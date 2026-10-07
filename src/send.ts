import { appendFileSync } from "node:fs";
import { P2PKH, Transaction } from "@bsv/sdk";
import { evaluateSend, evaluateSweep, evaluateSplit, planSplit, DEFAULT_SPLIT_PIECE } from "./policy";
import { loadUsage, loadVault, vaultPaths } from "./vault";
import { gateAgentSend, loadPolicyEnvelope } from "./brc181";

export type Utxo = { tx_hash: string; tx_pos: number; value: number };

export type SendResult =
  | { ok: true; txid: string; amount: number; to: string; fee: number }
  | { ok: false; code: string; message: string };

const WOC = "https://api.whatsonchain.com/v1/bsv/main";
const ARC_URL = "https://arc.gorillapool.io/v1/tx";

export async function defaultFetchUtxos(address: string): Promise<Utxo[]> {
  const response = await fetch(`${WOC}/address/${address}/unspent`);
  if (!response.ok) throw new Error(`UTXO fetch failed: ${response.status}`);
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

export async function defaultFetchTxHex(txid: string): Promise<string> {
  const response = await fetch(`${WOC}/tx/${txid}/hex`);
  if (!response.ok) throw new Error(`Tx hex fetch failed: ${response.status}`);
  return (await response.text()).trim();
}

export async function defaultBroadcast(raw: string): Promise<{ txid: string }> {
  const response = await fetch(ARC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rawTx: raw }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Broadcast failed: ${response.status} ${body}`);
  const parsed = JSON.parse(body) as { txid?: string };
  if (!parsed.txid) throw new Error(`Broadcast failed: ${body}`);
  return { txid: parsed.txid };
}

function feeFor(inputs: number, outputs: number): number {
  return 10 + inputs * 148 + outputs * 34;
}

export function selectUtxos(utxos: Utxo[], amount: number): { chosen: Utxo[]; fee: number; total: number } {
  const sorted = [...utxos].sort((a, b) => a.value - b.value);
  const chosen: Utxo[] = [];
  let total = 0;
  for (const u of sorted) {
    chosen.push(u);
    total += u.value;
    const fee = feeFor(chosen.length, 2);
    if (total >= amount + fee) return { chosen, fee, total };
  }
  return { chosen, fee: feeFor(Math.max(chosen.length, 1), 2), total };
}

export async function sendPayment(opts: {
  root: string;
  to: string;
  amount: number;
  note?: string;
  origin?: string;
  fetchUtxos?: (address: string) => Promise<Utxo[]>;
  fetchTxHex?: (txid: string) => Promise<string>;
  broadcast?: (raw: string) => Promise<{ txid: string }>;
}): Promise<SendResult> {
  const vault = loadVault(opts.root);
  const usage = loadUsage(opts.root);
  const decision = evaluateSend(vault.policy, opts.amount, opts.to, usage);
  if (!decision.ok) return decision;

  const loaded = loadPolicyEnvelope(vaultPaths(opts.root).brc181);
  if (!loaded.ok) return loaded;
  const pre = gateAgentSend({
    envelope: loaded.envelope,
    to: opts.to,
    amount: opts.amount,
    fee: 0,
    spentTotal: usage.spentLifetime,
    origin: opts.origin,
  });
  if (!pre.ok) return pre;

  const utxos = await (opts.fetchUtxos ?? defaultFetchUtxos)(vault.address);
  const { chosen, fee, total } = selectUtxos(utxos, opts.amount);
  if (chosen.length === 0 || total < opts.amount + fee) {
    return {
      ok: false,
      code: "INSUFFICIENT",
      message: `REJECTED: Insufficient funds (${total} sats available, need ${opts.amount + fee}).`,
    };
  }
  const post = gateAgentSend({
    envelope: loaded.envelope,
    to: opts.to,
    amount: opts.amount,
    fee,
    spentTotal: usage.spentLifetime,
    origin: opts.origin,
  });
  if (!post.ok) return post;

  const fetchTxHex = opts.fetchTxHex ?? defaultFetchTxHex;
  const tx = new Transaction();
  for (const u of chosen) {
    const hex = await fetchTxHex(u.tx_hash);
    const source = Transaction.fromHex(hex);
    tx.addInput({
      sourceTransaction: source,
      sourceTXID: u.tx_hash,
      sourceOutputIndex: u.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(vault.key),
    });
  }
  tx.addOutput({ satoshis: opts.amount, lockingScript: new P2PKH().lock(opts.to) });
  const change = total - opts.amount - fee;
  if (change > 1) {
    tx.addOutput({ satoshis: change, lockingScript: new P2PKH().lock(vault.address) });
  }
  await tx.sign();
  const raw = tx.toHex();
  const { txid } = await (opts.broadcast ?? defaultBroadcast)(raw);
  const paths = vaultPaths(opts.root);
  appendFileSync(
    paths.log,
    `${JSON.stringify({
      t: new Date().toISOString(),
      txid,
      to: opts.to,
      amount: opts.amount,
      fee,
      note: opts.note ?? "",
    })}\n`,
  );
  return { ok: true, txid, amount: opts.amount, to: opts.to, fee };
}

export async function sweepPayment(opts: {
  root: string;
  to: string;
  note?: string;
  fetchUtxos?: (address: string) => Promise<Utxo[]>;
  fetchTxHex?: (txid: string) => Promise<string>;
  broadcast?: (raw: string) => Promise<{ txid: string }>;
}): Promise<SendResult> {
  const vault = loadVault(opts.root);
  const decision = evaluateSweep(vault.policy, opts.to);
  if (!decision.ok) return decision;

  const utxos = await (opts.fetchUtxos ?? defaultFetchUtxos)(vault.address);
  const total = utxos.reduce((s, u) => s + u.value, 0);
  const fee = feeFor(Math.max(utxos.length, 1), 1);
  if (utxos.length === 0 || total <= fee) {
    return {
      ok: false,
      code: "INSUFFICIENT",
      message: `REJECTED: Insufficient funds to sweep (${total} sats, fee ${fee}).`,
    };
  }
  const amount = total - fee;
  const fetchTxHex = opts.fetchTxHex ?? defaultFetchTxHex;
  const tx = new Transaction();
  for (const u of utxos) {
    const hex = await fetchTxHex(u.tx_hash);
    const source = Transaction.fromHex(hex);
    tx.addInput({
      sourceTransaction: source,
      sourceTXID: u.tx_hash,
      sourceOutputIndex: u.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(vault.key),
    });
  }
  tx.addOutput({ satoshis: amount, lockingScript: new P2PKH().lock(opts.to) });
  await tx.sign();
  const raw = tx.toHex();
  const { txid } = await (opts.broadcast ?? defaultBroadcast)(raw);
  const paths = vaultPaths(opts.root);
  appendFileSync(
    paths.log,
    `${JSON.stringify({
      t: new Date().toISOString(),
      txid,
      to: opts.to,
      amount,
      fee,
      note: opts.note ?? "sweep",
      kind: "sweep",
    })}\n`,
  );
  return { ok: true, txid, amount, to: opts.to, fee };
}

export async function splitPayment(opts: {
  root: string;
  pieceSats?: number;
  fetchUtxos?: (address: string) => Promise<Utxo[]>;
  fetchTxHex?: (txid: string) => Promise<string>;
  broadcast?: (raw: string) => Promise<{ txid: string }>;
}): Promise<SendResult & { pieces?: number[] }> {
  const vault = loadVault(opts.root);
  const pieceSats = opts.pieceSats ?? DEFAULT_SPLIT_PIECE;
  const decision = evaluateSplit(vault.policy, pieceSats);
  if (!decision.ok) return decision;

  const utxos = await (opts.fetchUtxos ?? defaultFetchUtxos)(vault.address);
  const total = utxos.reduce((s, u) => s + u.value, 0);
  const plan = planSplit(total, pieceSats, Math.max(utxos.length, 1));
  if (!plan.ok) return plan;

  const fetchTxHex = opts.fetchTxHex ?? defaultFetchTxHex;
  const tx = new Transaction();
  for (const u of utxos) {
    const hex = await fetchTxHex(u.tx_hash);
    const source = Transaction.fromHex(hex);
    tx.addInput({
      sourceTransaction: source,
      sourceTXID: u.tx_hash,
      sourceOutputIndex: u.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(vault.key),
    });
  }
  for (const satoshis of plan.pieces) {
    tx.addOutput({ satoshis, lockingScript: new P2PKH().lock(vault.address) });
  }
  await tx.sign();
  const raw = tx.toHex();
  const { txid } = await (opts.broadcast ?? defaultBroadcast)(raw);
  const paths = vaultPaths(opts.root);
  appendFileSync(
    paths.log,
    `${JSON.stringify({
      t: new Date().toISOString(),
      txid,
      to: vault.address,
      amount: 0,
      fee: plan.fee,
      pieces: plan.pieces.length,
      note: "split",
      kind: "split",
    })}\n`,
  );
  return { ok: true, txid, amount: 0, to: vault.address, fee: plan.fee, pieces: plan.pieces };
}
