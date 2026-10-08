import { P2PKH, Transaction } from "@bsv/sdk";
import { isValidAddress } from "./policy";
import { createMemoryReplayStore, type ReplayStore } from "./replay-store";
import { defaultBroadcast } from "./send";
import { p2pkhAddressFromLock } from "./x402";

const WOC = "https://api.whatsonchain.com/v1/bsv/main";
export type BsvMerchantConfig = { bsvPayTo?: string; bsvSatoshis?: number; fetchFn?: typeof fetch; replayStore?: ReplayStore };

// Single-process replay protection. Keep reservations after broadcast attempts:
// a timeout is ambiguous and must not permit a second delivery of the resource.
export function createBsvMerchant(cfg: BsvMerchantConfig) {
  if (!cfg.bsvPayTo) return undefined;
  if (!isValidAddress(cfg.bsvPayTo)) throw new Error("BSV payTo must be a mainnet P2PKH address");
  const satoshis = cfg.bsvSatoshis ?? 500;
  if (!Number.isSafeInteger(satoshis) || satoshis <= 0) throw new Error("BSV satoshis must be a positive safe integer");
  const requirement = { scheme: "bsv-direct", network: "bsv-main", satoshis, payTo: cfg.bsvPayTo } as const;
  const lockingHex = new P2PKH().lock(cfg.bsvPayTo).toHex();
  const fetchFn = cfg.fetchFn ?? globalThis.fetch.bind(globalThis);
  const store = cfg.replayStore ?? createMemoryReplayStore();

  async function settle(raw: string): Promise<string> {
    if (!/^(?:[a-fA-F0-9]{2})+$/.test(raw)) throw new Error("Invalid BSV payment hex");
    let tx: Transaction;
    try {
      tx = Transaction.fromHex(raw);
      if (tx.toHex() !== raw.toLowerCase() || !tx.inputs.length || !tx.outputs.length) throw new Error();
    } catch { throw new Error("Invalid BSV transaction encoding"); }
    const txid = tx.id("hex");
    const outpoints: string[] = [];
    for (const input of tx.inputs) {
      if (!input.sourceTXID || !/^[a-f0-9]{64}$/i.test(input.sourceTXID) || !input.unlockingScript?.toHex()) throw new Error("Invalid unsigned BSV input");
      const point = `${input.sourceTXID}:${input.sourceOutputIndex}`;
      if (outpoints.includes(point)) throw new Error("Duplicate BSV input");
      outpoints.push(point);
    }
    let outputTotal = 0n;
    let paid = 0n;
    for (const output of tx.outputs) {
      if (!Number.isSafeInteger(output.satoshis) || output.satoshis! < 0) throw new Error("Invalid BSV output amount");
      outputTotal += BigInt(output.satoshis!);
      if (output.lockingScript.toHex() === lockingHex) paid += BigInt(output.satoshis!);
    }
    if (paid < BigInt(satoshis)) throw new Error("BSV payment underpaid or payee mismatch");
    let inputTotal = 0n;
    for (const input of tx.inputs) {
      const response = await fetchFn(`${WOC}/tx/${input.sourceTXID}/hex`);
      if (!response.ok) throw new Error(`Unknown BSV source transaction: HTTP ${response.status}`);
      let source: Transaction;
      try { source = Transaction.fromHex((await response.text()).trim()); }
      catch { throw new Error("Invalid BSV source transaction hex"); }
      if (source.id("hex") !== input.sourceTXID) throw new Error("BSV source transaction ID mismatch");
      const output = source.outputs[input.sourceOutputIndex];
      if (!output || !Number.isSafeInteger(output.satoshis) || output.satoshis! < 0) throw new Error("Invalid BSV source output");
      const address = p2pkhAddressFromLock(output.lockingScript.toHex());
      if (!address) throw new Error("Unsupported BSV source output: P2PKH required");
      const unspentResponse = await fetchFn(`${WOC}/address/${address}/unspent`);
      if (!unspentResponse.ok) throw new Error(`BSV unspent lookup failed: HTTP ${unspentResponse.status}`);
      const unspent = await unspentResponse.json();
      if (!Array.isArray(unspent) || !unspent.some(u => u.tx_hash === input.sourceTXID && u.tx_pos === input.sourceOutputIndex && u.value === output.satoshis)) throw new Error("BSV input is spent or missing from unspent outputs");
      inputTotal += BigInt(output.satoshis!);
    }
    if (outputTotal > inputTotal) throw new Error("BSV inflation: outputs exceed inputs");
    // Check and reserve synchronously after chain validation and before broadcast.
    // No await between these operations: concurrent copies/conflicting txids cannot both pass.
    if (store.has(txid, outpoints)) throw new Error("BSV payment replay: transaction or input already used");
    store.reserve(txid, outpoints);
    const result = await defaultBroadcast(raw, fetchFn);
    if (result.txid.toLowerCase() !== txid) throw new Error("BSV broadcast txid mismatch");
    return txid;
  }
  return { requirement, settle };
}
