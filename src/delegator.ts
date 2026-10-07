import { challengeSha256, decideX402, encodeProofHeader, buildProof, inspectProof, type X402Challenge, type X402Proof } from "./x402";
import type { Policy, Usage } from "./policy";

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

function encodeVarInt(n: number): Buffer {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const buf = Buffer.alloc(3);
    buf[0] = 0xfd;
    buf.writeUInt16LE(n, 1);
    return buf;
  }
  if (n <= 0xffffffff) {
    const buf = Buffer.alloc(5);
    buf[0] = 0xfe;
    buf.writeUInt32LE(n, 1);
    return buf;
  }
  const buf = Buffer.alloc(9);
  buf[0] = 0xff;
  buf.writeBigUInt64LE(BigInt(n), 1);
  return buf;
}

function buildUnsignedPartialTx(
  nonce: { txid: string; vout: number },
  lockingScriptHex: string,
  amountSats: number,
): string {
  const parts: Buffer[] = [];
  const version = Buffer.alloc(4);
  version.writeUInt32LE(1);
  parts.push(version);
  parts.push(encodeVarInt(1));
  parts.push(Buffer.from(nonce.txid, "hex").reverse());
  const vout = Buffer.alloc(4);
  vout.writeUInt32LE(nonce.vout);
  parts.push(vout);
  parts.push(encodeVarInt(0));
  const seq = Buffer.alloc(4);
  seq.writeUInt32LE(0xffffffff);
  parts.push(seq);
  parts.push(encodeVarInt(1));
  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(BigInt(amountSats));
  parts.push(value);
  const script = Buffer.from(lockingScriptHex, "hex");
  parts.push(encodeVarInt(script.length));
  parts.push(script);
  const locktime = Buffer.alloc(4);
  locktime.writeUInt32LE(0);
  parts.push(locktime);
  return Buffer.concat(parts).toString("hex");
}

export function buildPartialTransaction(challenge: X402Challenge): string {
  const template = challenge.template?.rawtx_hex;
  if (template && template.length > 0) return template;
  const nonce = challenge.nonce_utxo;
  if (!nonce?.txid) {
    throw new Error("REJECTED: x402 challenge has no nonce_utxo and no template.");
  }
  return buildUnsignedPartialTx(nonce, challenge.payee_locking_script_hex, challenge.amount_sats);
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
      broadcast: false;
      txid: string;
      header: string;
      proof: X402Proof;
      partialTxHex: string;
      message: string;
    }
  | {
      ok: false;
      broadcast: false;
      code: string;
      message: string;
    };

export async function settleX402(opts: {
  policy: Policy;
  usage: Usage;
  challenge: X402Challenge;
  delegatorUrl?: string;
  fetchFn?: typeof fetch;
  method?: string;
  path?: string;
  query?: string;
}): Promise<SettleX402Result> {
  const decided = decideX402(opts.policy, opts.usage, opts.challenge);
  if (!decided.ok) {
    return { ok: false, broadcast: false, code: decided.code ?? "POLICY", message: decided.message };
  }
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
  try {
    partialTxHex = buildPartialTransaction(opts.challenge);
  } catch (e) {
    return {
      ok: false,
      broadcast: false,
      code: "BAD_CHALLENGE",
      message: e instanceof Error ? e.message : String(e),
    };
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
  return {
    ok: true,
    broadcast: false,
    txid: completed.txid,
    header: encodeProofHeader(proof),
    proof,
    partialTxHex,
    message: "Delegator completed the settlement tx. Proof is ready. Dogfood did not broadcast.",
  };
}
