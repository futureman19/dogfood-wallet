import { P2PKH, Script, Transaction, type PrivateKey } from "@bsv/sdk";
import { join } from "path";
import { homedir } from "os";
import { defaultFetchTxHex, defaultFetchUtxos, type Utxo } from "./send";
import { loadVault } from "./vault";

export function defaultDelegatorDir(): string {
  return process.env.DOGFOOD_DELEGATOR_DIR ?? join(homedir(), ".dogfood-delegator");
}

// Dogfood fee delegator: the merchant-side half of a client-funded x402
// settlement. Unlike the frozen Merkle Works v1 delegator (which funds the
// payment itself because raw tx hex hides input values), this delegator
// resolves every client input's value on-chain and only covers the miner
// fee. Client inputs must fully fund the outputs; the pool adds fee inputs
// (signed 0xC1, which commits to the final output set) and takes its own
// change output. Client signatures are 0xC3 (SINGLE|ANYONECANPAY), which
// tolerates the appended pool change output.

export class DelegationRefusal extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DelegationRefusal";
    this.code = code;
  }
}

export type FeePool = {
  key: PrivateKey;
  address: string;
  fetchUtxos?: (address: string) => Promise<Utxo[]>;
};

export type CompleteResult = {
  completedTxHex: string;
  txid: string;
  feeSats: number;
  feeInputs: number;
};

const P2PKH_INPUT_BYTES = 148;
const P2PKH_OUTPUT_BYTES = 34;

export async function completeForClient(opts: {
  partialTxHex: string;
  pool: FeePool;
  fetchTxHex?: (txid: string) => Promise<string>;
  minFeeSats?: number;
  satPerByte?: number;
}): Promise<CompleteResult> {
  const minFeeSats = opts.minFeeSats ?? 40;
  const satPerByte = opts.satPerByte ?? 0.25;
  const fetchTxHex = opts.fetchTxHex ?? defaultFetchTxHex;

  const tx = Transaction.fromHex(opts.partialTxHex);

  // Resolve the value of every pre-existing input from its source output.
  let inputSats = 0;
  for (const input of tx.inputs) {
    const txid = input.sourceTXID;
    if (!txid) throw new DelegationRefusal("BAD_PARTIAL", "input is missing sourceTXID.");
    const source = Transaction.fromHex(await fetchTxHex(txid));
    const out = source.outputs[input.sourceOutputIndex];
    if (!out || out.satoshis === undefined) {
      throw new DelegationRefusal("BAD_PARTIAL", `source output missing for ${txid}:${input.sourceOutputIndex}.`);
    }
    inputSats += out.satoshis;
  }
  let outputSats = 0;
  for (const out of tx.outputs) outputSats += out.satoshis ?? 0;

  if (inputSats < outputSats) {
    throw new DelegationRefusal(
      "CLIENT_UNDERFUNDED",
      `REJECTED: outputs exceed inputs by ${outputSats - inputSats} sats. Dogfood delegator covers the miner fee only, never the payment.`,
    );
  }

  // Iterative fee estimate: pool inputs and the pool change output add size.
  // Any existing slack (e.g. the nonce's 1 sat, client rounding) counts
  // toward the fee before the pool contributes anything.
  const fetchUtxos = opts.pool.fetchUtxos ?? defaultFetchUtxos;
  const poolUtxos = (await fetchUtxos(opts.pool.address)).sort((a, b) => a.value - b.value);
  const slack = inputSats - outputSats;

  let feeSats = 0;
  let chosen: Utxo[] = [];
  let poolSum = 0;
  for (let iter = 0; iter < 6; iter++) {
    const sizeBytes = opts.partialTxHex.length / 2 + chosen.length * P2PKH_INPUT_BYTES + P2PKH_OUTPUT_BYTES;
    feeSats = Math.max(minFeeSats, Math.ceil(sizeBytes * satPerByte));
    const neededFromPool = Math.max(0, feeSats - slack);
    while (poolSum < neededFromPool && chosen.length < poolUtxos.length) {
      const u = poolUtxos[chosen.length];
      chosen.push(u);
      poolSum += u.value;
    }
    if (poolSum >= neededFromPool) break;
  }
  const neededFromPool = Math.max(0, feeSats - slack);
  if (poolSum < neededFromPool) {
    throw new DelegationRefusal(
      "POOL_EXHAUSTED",
      `REJECTED: fee pool cannot cover ${neededFromPool} sats (have ${poolSum}).`,
    );
  }
  if (neededFromPool === 0) {
    // Client (plus nonce) already covers the fee; nothing for the pool to add.
    return { completedTxHex: opts.partialTxHex, txid: tx.id("hex"), feeSats: slack, feeInputs: 0 };
  }

  const change = poolSum - neededFromPool;
  if (change >= 1) {
    tx.addOutput({ satoshis: change, lockingScript: new P2PKH().lock(opts.pool.address) });
  }
  for (const u of chosen) {
    const source = Transaction.fromHex(await fetchTxHex(u.tx_hash));
    tx.addInput({
      sourceTransaction: source,
      sourceTXID: u.tx_hash,
      sourceOutputIndex: u.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(opts.pool.key, "all", true),
      sequence: 0xffffffff,
    });
  }
  await tx.sign();

  // Report the fee actually embedded in the transaction. ECDSA signature
  // length varies by a byte or two, so the pre-sign estimate above (which
  // sized the pool change output) can drift ±2 sats from the final size;
  // the measured value is the truthful one.
  let finalOutputSats = 0;
  for (const out of tx.outputs) finalOutputSats += out.satoshis ?? 0;
  const actualFee = inputSats + poolSum - finalOutputSats;

  return {
    completedTxHex: tx.toHex(),
    txid: tx.id("hex"),
    feeSats: actualFee,
    feeInputs: chosen.length,
  };
}

// Thin HTTP wrapper: POST /delegate/x402 {partial_tx} -> {completed_tx,
// txid, fee_sats}. Loopback-only in v0; the pool vault is loaded from
// DOGFOOD_DELEGATOR_DIR (default ~/.dogfood-delegator), which is a separate
// identity from the client vault on purpose.
export async function runFeeDelegatorServer(opts: {
  root?: string;
  port?: number;
  hostname?: string;
  minFeeSats?: number;
  satPerByte?: number;
  fetchTxHex?: (txid: string) => Promise<string>;
  fetchUtxos?: (address: string) => Promise<Utxo[]>;
}): Promise<{ port: number; address: string; stop: () => void }> {
  const root = opts.root ?? defaultDelegatorDir();
  const vault = loadVault(root);
  const hostname = opts.hostname ?? "127.0.0.1";
  const server = Bun.serve({
    port: opts.port ?? 8403,
    hostname,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, role: "dogfood-fee-delegator", address: vault.address });
      }
      if (req.method === "POST" && url.pathname === "/delegate/x402") {
        let body: { partial_tx?: string };
        try {
          body = (await req.json()) as { partial_tx?: string };
        } catch {
          return Response.json({ error: "BAD_JSON", message: "request body must be JSON" }, { status: 400 });
        }
        if (!body.partial_tx) {
          return Response.json({ error: "BAD_PARTIAL", message: "missing partial_tx" }, { status: 400 });
        }
        try {
          const r = await completeForClient({
            partialTxHex: body.partial_tx,
            pool: { key: vault.key, address: vault.address, fetchUtxos: opts.fetchUtxos },
            fetchTxHex: opts.fetchTxHex,
            minFeeSats: opts.minFeeSats,
            satPerByte: opts.satPerByte,
          });
          return Response.json({
            completed_tx: r.completedTxHex,
            txid: r.txid,
            fee_sats: r.feeSats,
            fee_inputs: r.feeInputs,
          });
        } catch (err) {
          if (err instanceof DelegationRefusal) {
            const status = err.code === "POOL_EXHAUSTED" ? 503 : 400;
            return Response.json({ error: err.code, message: err.message }, { status });
          }
          throw err;
        }
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    },
  });
  return { port: server.port, address: vault.address, stop: () => server.stop(true) };
}
