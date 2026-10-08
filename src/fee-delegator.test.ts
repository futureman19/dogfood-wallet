import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P2PKH, PrivateKey, Script, Transaction } from "@bsv/sdk";
import { buildClientFundedPartialTx } from "./delegator";
import { completeForClient, DelegationRefusal, runFeeDelegatorServer } from "./fee-delegator";
import { initVault } from "./vault";
import type { X402Challenge } from "./x402";
import type { Utxo } from "./send";

const clientKey = PrivateKey.fromRandom();
const clientAddr = clientKey.toAddress().toString();
const clientLock = new P2PKH().lock(clientAddr).toHex();

const poolKey = PrivateKey.fromRandom();
const poolAddr = poolKey.toAddress().toString();
const poolLock = new P2PKH().lock(poolAddr).toHex();

const PAYEE_LOCK = "76a914" + "33".repeat(20) + "88ac";
const NONCE_TXID = "44".repeat(32);

function makeWorld(opts: { clientSats: number; poolPieces: number[]; poolLockHex?: string }) {
  const lock = opts.poolLockHex ?? poolLock;
  const nonceSrc = new Transaction();
  nonceSrc.addOutput({ satoshis: 1, lockingScript: Script.fromHex(PAYEE_LOCK) });
  const clientSrc = new Transaction();
  clientSrc.addOutput({ satoshis: opts.clientSats, lockingScript: Script.fromHex(clientLock) });
  const poolSrc = new Transaction();
  for (const sats of opts.poolPieces) poolSrc.addOutput({ satoshis: sats, lockingScript: Script.fromHex(lock) });

  const hexById = new Map<string, string>([
    [nonceSrc.id("hex"), nonceSrc.toHex()],
    [clientSrc.id("hex"), clientSrc.toHex()],
    [poolSrc.id("hex"), poolSrc.toHex()],
  ]);
  const clientUtxo: Utxo = { tx_hash: clientSrc.id("hex"), tx_pos: 0, value: opts.clientSats };
  const poolUtxos: Utxo[] = opts.poolPieces.map((value, i) => ({
    tx_hash: poolSrc.id("hex"),
    tx_pos: i,
    value,
  }));
  return {
    nonceTxid: nonceSrc.id("hex"),
    fetchTxHex: async (txid: string) => {
      const hex = hexById.get(txid);
      if (!hex) throw new Error(`no source tx ${txid}`);
      return hex;
    },
    clientUtxo,
    poolUtxos,
  };
}

function makeChallenge(nonceTxid: string): X402Challenge {
  const tmpl = new Transaction();
  tmpl.addInput({ sourceTXID: nonceTxid, sourceOutputIndex: 0, unlockingScript: Script.fromHex("deadbeef") });
  tmpl.addOutput({ satoshis: 100, lockingScript: Script.fromHex(PAYEE_LOCK) });
  return {
    v: 1,
    scheme: "bsv-tx-v1",
    amount_sats: 100,
    payee_locking_script_hex: PAYEE_LOCK,
    expires_at: 4_000_000_000,
    nonce_utxo: { txid: nonceTxid, vout: 0, satoshis: 1, locking_script_hex: PAYEE_LOCK },
    template: { rawtx_hex: tmpl.toHex(), price_sats: 100 },
  };
}

async function partialFor(world: ReturnType<typeof makeWorld>) {
  return buildClientFundedPartialTx({
    challenge: makeChallenge(world.nonceTxid),
    key: clientKey,
    address: clientAddr,
    fetchUtxos: async () => [world.clientUtxo],
    fetchTxHex: world.fetchTxHex,
  });
}

describe("completeForClient", () => {
  test("covers the miner fee, signs pool inputs 0xC1, and returns pool change", async () => {
    const world = makeWorld({ clientSats: 10_000, poolPieces: [200] });
    const { partialTxHex } = await partialFor(world);
    const r = await completeForClient({
      partialTxHex,
      pool: { key: poolKey, address: poolAddr, fetchUtxos: async () => world.poolUtxos },
      fetchTxHex: world.fetchTxHex,
    });
    const tx = Transaction.fromHex(r.completedTxHex);
    expect(tx.inputs).toHaveLength(3);
    expect(tx.outputs).toHaveLength(3);
    // client outputs preserved
    expect(tx.outputs[0].satoshis).toBe(100);
    expect(tx.outputs[0].lockingScript.toHex()).toBe(PAYEE_LOCK);
    expect(tx.outputs[1].satoshis).toBe(9_900);
    // pool change present; exact value conservation with the measured fee
    const poolChange = tx.outputs[2].satoshis!;
    expect(tx.outputs[2].lockingScript.toHex()).toBe(poolLock);
    const inSum = 1 + 10_000 + 200;
    const outSum = tx.outputs.reduce((s, o) => s + (o.satoshis ?? 0), 0);
    expect(inSum - outSum).toBe(r.feeSats);
    expect(r.feeSats).toBeGreaterThanOrEqual(40);
    expect(poolChange).toBeGreaterThanOrEqual(1);
    expect(poolChange).toBeLessThan(200 - 40);
    // sighashes: client payment input 0xC3, pool input 0xC1
    const clientSig = tx.inputs[1].unlockingScript!.chunks[0].data!;
    expect(clientSig[clientSig.length - 1]).toBe(0xc3);
    const poolSig = tx.inputs[2].unlockingScript!.chunks[0].data!;
    expect(poolSig[poolSig.length - 1]).toBe(0xc1);
    expect(r.feeInputs).toBe(1);
  });

  test("refuses a partial whose outputs exceed its inputs (no pool subsidy)", async () => {
    const world = makeWorld({ clientSats: 10_000, poolPieces: [200] });
    const ch = makeChallenge(world.nonceTxid);
    const templateOnly = ch.template!.rawtx_hex;
    await expect(
      completeForClient({
        partialTxHex: templateOnly,
        pool: { key: poolKey, address: poolAddr, fetchUtxos: async () => world.poolUtxos },
        fetchTxHex: world.fetchTxHex,
      }),
    ).rejects.toMatchObject({ code: "CLIENT_UNDERFUNDED" });
  });

  test("fails closed when the pool cannot cover the fee", async () => {
    const world = makeWorld({ clientSats: 10_000, poolPieces: [30] });
    const { partialTxHex } = await partialFor(world);
    await expect(
      completeForClient({
        partialTxHex,
        pool: { key: poolKey, address: poolAddr, fetchUtxos: async () => world.poolUtxos },
        fetchTxHex: world.fetchTxHex,
      }),
    ).rejects.toMatchObject({ code: "POOL_EXHAUSTED" });
  });

  test("accumulates multiple pool inputs when one cannot cover the fee", async () => {
    const world = makeWorld({ clientSats: 10_000, poolPieces: [100, 100] });
    const { partialTxHex } = await partialFor(world);
    const r = await completeForClient({
      partialTxHex,
      pool: { key: poolKey, address: poolAddr, fetchUtxos: async () => world.poolUtxos },
      fetchTxHex: world.fetchTxHex,
      minFeeSats: 150,
      satPerByte: 0,
    });
    // nonce slack is 1 sat, so the pool only covers 149
    expect(r.feeInputs).toBe(2);
    const tx = Transaction.fromHex(r.completedTxHex);
    expect(tx.inputs).toHaveLength(4);
    const poolChange = tx.outputs[tx.outputs.length - 1];
    expect(poolChange.satoshis).toBe(51);
    expect(poolChange.lockingScript.toHex()).toBe(poolLock);
    expect(r.feeSats).toBeGreaterThanOrEqual(149);
    expect(r.feeSats).toBeLessThanOrEqual(152);
  });

  test("adds no pool input when the client side already covers the fee", async () => {
    const world = makeWorld({ clientSats: 10_000, poolPieces: [200] });
    const { partialTxHex } = await partialFor(world);
    const r = await completeForClient({
      partialTxHex,
      pool: { key: poolKey, address: poolAddr, fetchUtxos: async () => world.poolUtxos },
      fetchTxHex: world.fetchTxHex,
      minFeeSats: 1,
      satPerByte: 0,
    });
    expect(r).toMatchObject({ feeSats: 1, feeInputs: 0 });
    const tx = Transaction.fromHex(r.completedTxHex);
    expect(tx.inputs).toHaveLength(2);
    expect(tx.outputs).toHaveLength(2);
  });

  test("rejects a partial that references a missing source output", async () => {
    const world = makeWorld({ clientSats: 10_000, poolPieces: [200] });
    const { partialTxHex } = await partialFor(world);
    await expect(
      completeForClient({
        partialTxHex,
        pool: { key: poolKey, address: poolAddr, fetchUtxos: async () => world.poolUtxos },
        fetchTxHex: async () => {
          throw new Error("404");
        },
      }),
    ).rejects.toThrow();
  });
});

describe("runFeeDelegatorServer", () => {
  test("serves /health and completes a client-funded partial over HTTP; maps refusals", async () => {
    const root = mkdtempSync(join(tmpdir(), "df-delegator-"));
    try {
      const { address } = initVault(root);
      const world = makeWorld({
        clientSats: 10_000,
        poolPieces: [200],
        poolLockHex: new P2PKH().lock(address).toHex(),
      });
      const srv = await runFeeDelegatorServer({
        root,
        port: 0,
        fetchTxHex: world.fetchTxHex,
        fetchUtxos: async (a) => (a === address ? world.poolUtxos.map((u) => ({ ...u })) : []),
      });
      try {
        const health = await fetch(`http://127.0.0.1:${srv.port}/health`);
        expect(health.status).toBe(200);
        expect(await health.json()).toMatchObject({ ok: true, address });

        const { partialTxHex } = await partialFor(world);
        const ok = await fetch(`http://127.0.0.1:${srv.port}/delegate/x402`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ partial_tx: partialTxHex }),
        });
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as { completed_tx: string; txid: string; fee_sats: number };
        const tx = Transaction.fromHex(body.completed_tx);
        expect(tx.inputs).toHaveLength(3);
        expect(tx.outputs[0].satoshis).toBe(100);
        expect(body.fee_sats).toBeGreaterThanOrEqual(40);

        const bad = await fetch(`http://127.0.0.1:${srv.port}/delegate/x402`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ partial_tx: makeChallenge(world.nonceTxid).template!.rawtx_hex }),
        });
        expect(bad.status).toBe(400);
        expect(await bad.json()).toMatchObject({ error: "CLIENT_UNDERFUNDED" });
      } finally {
        srv.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
