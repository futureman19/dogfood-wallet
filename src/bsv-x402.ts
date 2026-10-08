import { P2PKH, Transaction, type PrivateKey } from "@bsv/sdk";
import { evaluateSend, type Policy, type Usage } from "./policy";
import { defaultFetchTxHex, defaultFetchUtxos, selectUtxos } from "./send";
import { gateAgentSend, type PolicyEnvelope } from "./brc181";

export class BsvX402Error extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "BsvX402Error";
  }
}

export type BsvDirectRequirement = {
  scheme: "bsv-direct";
  network: "bsv-main";
  satoshis: number;
  payTo: string;
};

export function pickBsvDirect(body: unknown): BsvDirectRequirement | null {
  const accepts = (body as { accepts?: unknown })?.accepts;
  if (!Array.isArray(accepts)) return null;
  for (const a of accepts) {
    if (a?.scheme !== "bsv-direct" || a?.network !== "bsv-main") continue;
    // An offered but malformed BSV rail must not trigger a different currency.
    if (!Number.isSafeInteger(a.satoshis) || a.satoshis <= 0) {
      throw new BsvX402Error("BAD_AMOUNT", "REJECTED: BSV price must be positive integer satoshis.");
    }
    if (typeof a.payTo !== "string" || !a.payTo.startsWith("1")) {
      throw new BsvX402Error("BAD_ADDRESS", "REJECTED: BSV payee must be a mainnet P2PKH address.");
    }
    try { new P2PKH().lock(a.payTo); } catch {
      throw new BsvX402Error("BAD_ADDRESS", "REJECTED: invalid BSV P2PKH payee.");
    }
    return { scheme: "bsv-direct", network: "bsv-main", satoshis: a.satoshis, payTo: a.payTo };
  }
  return null;
}

export type BsvSettleResult = {
  ok: true;
  txid: string;
  amount: number;
  payTo: string;
  fee: number;
  body: string;
};

export async function settleBsvX402(opts: {
  url: string;
  key: PrivateKey;
  from: string;
  policy: Policy;
  usage: Usage;
  fetchFn?: typeof fetch;
  onSpend?: (row: Record<string, unknown>) => void;
  policyEnvelope?: PolicyEnvelope | null;
  origin?: string;
  /** Recent own bsv send txids (from the spend log). WoC's /unspent only
   *  drops outputs spent by CONFIRMED txs, so our own mempool spends keep
   *  showing as spendable; masking them here avoids building on dead coins.
   *  Best-effort: the merchant's replay ledger remains the hard guard. */
  ownSpendTxids?: string[];
}): Promise<BsvSettleResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const first = await fetchFn(opts.url);
  if (first.status !== 402) throw new BsvX402Error("NOT_GATED", `REJECTED: expected 402, got HTTP ${first.status}.`);
  const req = pickBsvDirect(await first.json());
  if (!req) throw new BsvX402Error("UNSUPPORTED", "REJECTED: no bsv-direct/bsv-main requirement offered.");
  const decision = evaluateSend(opts.policy, req.satoshis, req.payTo, opts.usage);
  if (!decision.ok) throw new BsvX402Error(decision.code, decision.message);
  const gate = (fee: number) => {
    const d = gateAgentSend({ envelope: opts.policyEnvelope, to: req.payTo, amount: req.satoshis, fee, spentTotal: opts.usage.spentLifetime, origin: opts.origin });
    if (!d.ok) throw new BsvX402Error(d.code, d.message);
  };
  gate(0);
  if (opts.from !== opts.key.toAddress()) throw new BsvX402Error("BAD_ADDRESS", "REJECTED: funding address does not match the signer.");
  const utxos = await defaultFetchUtxos(opts.from, fetchFn);
  const outpoints = new Set<string>();
  for (const u of utxos) {
    const outpoint = `${u.tx_hash}:${u.tx_pos}`;
    if (!/^[0-9a-f]{64}$/i.test(u.tx_hash) || !Number.isSafeInteger(u.tx_pos) || u.tx_pos < 0 || !Number.isSafeInteger(u.value) || u.value <= 0 || outpoints.has(outpoint)) {
      throw new BsvX402Error("BAD_UTXO", "REJECTED: invalid or duplicate funding UTXO.");
    }
    outpoints.add(outpoint);
  }
  const spentByUs = new Set<string>();
  for (const txid of (opts.ownSpendTxids ?? []).slice(0, 10)) {
    try {
      const spentTx = Transaction.fromHex(await defaultFetchTxHex(txid, fetchFn));
      if (spentTx.id("hex") !== txid) continue;
      for (const i of spentTx.inputs) if (i.sourceTXID) spentByUs.add(`${i.sourceTXID}:${i.sourceOutputIndex}`);
    } catch {
      // Best-effort filter only: the merchant's replay ledger is the hard guard.
    }
  }
  const liveUtxos = spentByUs.size ? utxos.filter((u) => !spentByUs.has(`${u.tx_hash}:${u.tx_pos}`)) : utxos;
  const { chosen, fee, total } = selectUtxos(liveUtxos, req.satoshis);
  if (!Number.isSafeInteger(total) || !chosen.length || total < req.satoshis + fee) {
    throw new BsvX402Error("INSUFFICIENT", "REJECTED: insufficient BSV for payment and fee.");
  }
  const change = total - req.satoshis - fee;
  const actualFee = fee + (change > 1 ? 0 : change);
  gate(actualFee);
  const tx = new Transaction();
  const ownScript = new P2PKH().lock(opts.from).toHex();
  for (const u of chosen) {
    const source = Transaction.fromHex(await defaultFetchTxHex(u.tx_hash, fetchFn));
    const output = source.outputs[u.tx_pos];
    if (source.id("hex") !== u.tx_hash || output?.satoshis !== u.value || output.lockingScript.toHex() !== ownScript) {
      throw new BsvX402Error("BAD_UTXO", "REJECTED: funding source does not match UTXO or signer.");
    }
    tx.addInput({ sourceTransaction: source, sourceTXID: u.tx_hash, sourceOutputIndex: u.tx_pos, unlockingScriptTemplate: new P2PKH().unlock(opts.key) });
  }
  tx.addOutput({ satoshis: req.satoshis, lockingScript: new P2PKH().lock(req.payTo) });
  if (change > 1) tx.addOutput({ satoshis: change, lockingScript: new P2PKH().lock(opts.from) });
  await tx.sign();
  const txid = tx.id("hex");
  // Merchant owns broadcast. Never independently broadcast or try another rail after signing.
  const paid = await fetchFn(opts.url, { redirect: "error", headers: { "X-BSV-PAYMENT": tx.toHex() } });
  let receipt: { success?: boolean; transaction?: string; network?: string } | null = null;
  try {
    const header = paid.headers.get("X-PAYMENT-RESPONSE");
    if (header) receipt = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch { /* missing or malformed receipts fail closed */ }
  if (!paid.ok || receipt?.success !== true || receipt.network !== "bsv-main" || receipt.transaction !== txid) {
    throw new BsvX402Error("SETTLE_FAILED", `REJECTED: merchant HTTP ${paid.status} or invalid BSV settlement receipt; do not automatically retry payment.`);
  }
  opts.onSpend?.({ t: new Date().toISOString(), kind: "send", asset: "bsv", amount: req.satoshis, to: req.payTo, txid, resource: opts.url, fee: actualFee });
  return { ok: true, txid, amount: req.satoshis, payTo: req.payTo, fee: actualFee, body: await paid.text() };
}
