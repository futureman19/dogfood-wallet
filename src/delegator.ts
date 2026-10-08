import { P2PKH, Script, Transaction, type PrivateKey } from "@bsv/sdk";
import { challengeSha256, decideX402, encodeProofHeader, buildProof, inspectProof, p2pkhAddressFromLock, type X402Challenge, type X402Proof } from "./x402";
import type { Policy, Usage } from "./policy";
import { defaultBroadcast, defaultFetchTxHex, defaultFetchUtxos, type Utxo } from "./send";
import { gateAgentSend, type PolicyEnvelope } from "./brc181";

export const DEFAULT_DELEGATOR_PATH = "/delegate/x402";

export type DelegationInput = {
  partialTxHex: string;
  nonceUtxo: { txid: string; vout: number };
  challengeHash: string;
};

export type CompletedTransaction = {
  txid: string;
  rawtxHex: string;
};

export class DelegationError extends Error {
  code = "DELEGATOR" as const;
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "DelegationError";
    this.status = status;
  }
}

export class X402FundsError extends Error {
  code = "INSUFFICIENT" as const;
}

export type X402Funding = {
  key: PrivateKey;
  address: string;
  fetchUtxos?: (address: string) => Promise<Utxo[]>;
  fetchTxHex?: (txid: string) => Promise<string>;
};

// Builds the client side of an x402 settlement: the vault funds the payment
// with its own UTXOs (smallest-first), signed SIGHASH_ALL|FORKID|ANYONECANPAY
// (0xC1) so the delegator can append fee inputs afterwards. The gateway's
// nonce input stays at index 0 — its pre-signed template script is committed
// to output 0 via SIGHASH_SINGLE, so the payee output must remain first and
// vault change comes after. The delegator covers the miner fee; the vault
// pays exactly amount_sats (the rest returns as change).
export async function buildClientFundedPartialTx(opts: {
  challenge: X402Challenge;
  key: PrivateKey;
  address: string;
  fetchUtxos?: (address: string) => Promise<Utxo[]>;
  fetchTxHex?: (txid: string) => Promise<string>;
}): Promise<{ partialTxHex: string; changeSats: number; spentUtxos: Utxo[] }> {
  const ch = opts.challenge;
  const amount = ch.amount_sats;
  const fetchUtxos = opts.fetchUtxos ?? defaultFetchUtxos;
  const fetchTxHex = opts.fetchTxHex ?? defaultFetchTxHex;

  const utxos = await fetchUtxos(opts.address);
  const sorted = [...utxos].sort((a, b) => a.value - b.value);
  const chosen: Utxo[] = [];
  let total = 0;
  for (const u of sorted) {
    chosen.push(u);
    total += u.value;
    if (total >= amount) break;
  }
  if (total < amount) {
    throw new X402FundsError(
      `REJECTED: Vault cannot fund x402 payment (${total} sats available, need ${amount}).`,
    );
  }

  const tx = new Transaction();
  const template = ch.template?.rawtx_hex;
  if (template) {
    const tin = Transaction.fromHex(template).inputs[0];
    tx.addInput({
      sourceTXID: tin.sourceTXID!,
      sourceOutputIndex: tin.sourceOutputIndex,
      unlockingScript: tin.unlockingScript,
      sequence: tin.sequence ?? 0xffffffff,
    });
  } else if (ch.nonce_utxo?.txid) {
    tx.addInput({
      sourceTXID: ch.nonce_utxo.txid,
      sourceOutputIndex: ch.nonce_utxo.vout,
      unlockingScript: new Script(),
      sequence: 0xffffffff,
    });
  } else {
    throw new Error("REJECTED: x402 challenge has no nonce_utxo and no template.");
  }

  for (const u of chosen) {
    const source = Transaction.fromHex(await fetchTxHex(u.tx_hash));
    tx.addInput({
      sourceTransaction: source,
      sourceTXID: u.tx_hash,
      sourceOutputIndex: u.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(opts.key, "all", true),
      sequence: 0xffffffff,
    });
  }

  tx.addOutput({ satoshis: amount, lockingScript: Script.fromHex(ch.payee_locking_script_hex) });
  const change = total - amount;
  if (change >= 1) {
    tx.addOutput({ satoshis: change, lockingScript: new P2PKH().lock(opts.address) });
  }
  await tx.sign();
  return { partialTxHex: tx.toHex(), changeSats: Math.max(change, 0), spentUtxos: chosen };
}

export function delegatorEndpoint(baseUrl: string, path = DEFAULT_DELEGATOR_PATH): string {
  return baseUrl.replace(/\/$/, "") + path;
}

export async function completeDelegation(opts: {
  url: string;
  input: DelegationInput;
  fetchFn?: typeof fetch;
  path?: string;
}): Promise<CompletedTransaction> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const res = await fetchFn(delegatorEndpoint(opts.url, opts.path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ partial_tx: opts.input.partialTxHex }),
  });
  if (!res.ok) {
    let extra = "";
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      extra = body.error ?? body.code ?? "";
    } catch {
      /* non-JSON */
    }
    throw new DelegationError(
      `REJECTED: Delegator returned ${res.status}${extra ? ` (${extra})` : ""}.`,
      res.status,
    );
  }
  const data = (await res.json()) as { completed_tx?: string; rawtx_hex?: string; txid?: string };
  const rawtxHex = data.completed_tx ?? data.rawtx_hex;
  const txid = data.txid;
  if (!rawtxHex || !txid) {
    throw new DelegationError("REJECTED: Delegator response missing completed_tx or txid.");
  }
  return { txid, rawtxHex };
}

export type SettleX402Result =
  | {
      ok: true;
      broadcast: boolean;
      txid: string;
      header: string;
      proof: X402Proof;
      partialTxHex: string;
      vaultPaid: boolean;
      changeSats: number;
      message: string;
    }
  | {
      ok: false;
      broadcast: false;
      code: string;
      message: string;
    };

export function shouldBroadcast(flag?: boolean, env = process.env.DOGFOOD_X402_BROADCAST): boolean {
  if (flag === true) return true;
  if (flag === false) return false;
  const v = (env ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export async function settleX402(opts: {
  policy: Policy;
  usage: Usage;
  challenge: X402Challenge;
  delegatorUrl?: string;
  fetchFn?: typeof fetch;
  method?: string;
  path?: string;
  query?: string;
  broadcast?: boolean;
  broadcastFn?: (raw: string) => Promise<{ txid: string }>;
  envelope?: PolicyEnvelope | null;
  origin?: string;
  fund?: X402Funding;
  onSpend?: (entry: Record<string, unknown>) => void;
}): Promise<SettleX402Result> {
  const decided = decideX402(opts.policy, opts.usage, opts.challenge);
  if (!decided.ok) {
    return { ok: false, broadcast: false, code: decided.code ?? "POLICY", message: decided.message };
  }
  const brc = gateAgentSend({
    envelope: opts.envelope,
    lockingScriptHex: opts.challenge.payee_locking_script_hex,
    amount: opts.challenge.amount_sats,
    fee: 0,
    spentTotal: opts.usage.spentLifetime,
    origin: opts.origin,
  });
  if (!brc.ok) return { ok: false, broadcast: false, code: brc.code, message: brc.message };
  const url = opts.delegatorUrl ?? process.env.DOGFOOD_X402_DELEGATOR_URL;
  if (!url) {
    return {
      ok: false,
      broadcast: false,
      code: "NEED_DELEGATOR",
      message:
        "REJECTED: Set DOGFOOD_X402_DELEGATOR_URL to a Merkle Works /delegate/x402 host. Dogfood will not hit a demo gateway by default, and will not spend the merchant nonce UTXO locally.",
    };
  }

  let partialTxHex: string;
  let changeSats = 0;
  const vaultPaid = Boolean(opts.fund);
  if (opts.fund) {
    try {
      const built = await buildClientFundedPartialTx({
        challenge: opts.challenge,
        key: opts.fund.key,
        address: opts.fund.address,
        fetchUtxos: opts.fund.fetchUtxos,
        fetchTxHex: opts.fund.fetchTxHex,
      });
      partialTxHex = built.partialTxHex;
      changeSats = built.changeSats;
    } catch (e) {
      const code = e instanceof X402FundsError ? "INSUFFICIENT" : "BAD_CHALLENGE";
      return {
        ok: false,
        broadcast: false,
        code,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  } else {
    // Gateway-template (Profile B) settlement: the gateway pre-signed the
    // nonce and its delegator funds the payment from its own pool. That is
    // the frozen v1 demo model — valid interop, but the vault pays nothing,
    // so vaultPaid stays false and no spend is ever logged.
    const template = opts.challenge.template?.rawtx_hex;
    if (!template) {
      return {
        ok: false,
        broadcast: false,
        code: "NEED_FUNDS",
        message:
          "REJECTED: Vault funding required. Dogfood pays x402 challenges from vault coins; a delegator subsidy is not a payment.",
      };
    }
    partialTxHex = template;
  }

  const nonce = opts.challenge.nonce_utxo;
  if (!nonce) {
    return {
      ok: false,
      broadcast: false,
      code: "BAD_CHALLENGE",
      message: "REJECTED: x402 challenge has no nonce_utxo.",
    };
  }

  let completed: CompletedTransaction;
  try {
    completed = await completeDelegation({
      url,
      input: {
        partialTxHex,
        nonceUtxo: { txid: nonce.txid, vout: nonce.vout },
        challengeHash: challengeSha256(opts.challenge),
      },
      fetchFn: opts.fetchFn,
    });
  } catch (e) {
    const err = e as DelegationError;
    return {
      ok: false,
      broadcast: false,
      code: err.code ?? "DELEGATOR",
      message: err.message,
    };
  }

  const method = opts.method || opts.challenge.method || "GET";
  const path = opts.path || opts.challenge.path || "/";
  const query = opts.query ?? opts.challenge.query ?? "";
  const proof = buildProof({
    challenge: opts.challenge,
    rawtxHex: completed.rawtxHex,
    method,
    path,
    query,
  });
  const check = inspectProof(proof, { challenge: opts.challenge, requestPath: path, rawtxHex: completed.rawtxHex });
  if (!check.ok) {
    return { ok: false, broadcast: false, code: check.code, message: check.message };
  }

  const doBroadcast = shouldBroadcast(opts.broadcast);
  if (doBroadcast) {
    try {
      await (opts.broadcastFn ?? defaultBroadcast)(completed.rawtxHex);
    } catch (e) {
      return {
        ok: false,
        broadcast: false,
        code: "BROADCAST",
        message: `REJECTED: Broadcast failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (vaultPaid) {
      opts.onSpend?.({
        t: new Date().toISOString(),
        txid: completed.txid,
        to: p2pkhAddressFromLock(String(opts.challenge.payee_locking_script_hex ?? "")) ?? "",
        amount: opts.challenge.amount_sats,
        fee: 0,
        note: "x402 settle (delegator covers fee)",
        kind: "x402",
      });
    }
  }

  const detail = vaultPaid
    ? "Vault funded the settlement; delegator added the fee."
    : "Gateway sponsored this settlement from its own pool (v1 demo model); the vault paid nothing.";
  return {
    ok: true,
    broadcast: doBroadcast,
    txid: completed.txid,
    header: encodeProofHeader(proof),
    proof,
    partialTxHex,
    vaultPaid,
    changeSats,
    message: `${detail} Proof is ready.${doBroadcast ? " Broadcast submitted." : " Dogfood did not broadcast."}`,
  };
}
