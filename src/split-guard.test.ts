import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P2PKH, PrivateKey, Transaction } from "@bsv/sdk";
import { initVault, killVault, loadUsage, loadVault } from "./vault";
import { sendPayment, splitPayment, sweepPayment } from "./send";
import { sweepAllowance } from "./allowance";
import { inspectPaymentHold } from "./payment-guard";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "split-guard-"));
  initVault(root);
  const address = loadVault(root).address;
  const source = new Transaction();
  source.addOutput({ satoshis: 20000, lockingScript: new P2PKH().lock(address) });
  return { root, address, pieceSats: 1000,
    fetchUtxos: async () => [{ tx_hash: source.id("hex"), tx_pos: 0, value: 20000 }],
    fetchTxHex: async () => source.toHex(),
    broadcast: async (raw: string) => ({ txid: Transaction.fromHex(raw).id("hex") }) };
}
const pending = (root: string) => join(root, "payment.pending.json");
const lock = (root: string) => join(root, "payment.lock");

for (const file of ["payment.lock", "payment.pending.json"]) {
  test(`split refuses preexisting ${file} before vault/policy reads or network`, async () => {
    const f = fixture(); let calls = 0;
    try {
      writeFileSync(join(f.root, file), "orphan");
      writeFileSync(join(f.root, "policy.json"), "broken");
      expect(await splitPayment({ ...f, fetchUtxos: async () => { calls++; return []; } })).toMatchObject({ code: "PAYMENT_HELD" });
      expect(calls).toBe(0);
      expect(readFileSync(join(f.root, file), "utf8")).toBe("orphan");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("split reserves zero-transfer BSV intent before signing; self outputs and fee reconcile without charging caps", async () => {
  const f = fixture(); const original = Transaction.prototype.sign; let signs = 0; let paymentId = "";
  try {
    writeFileSync(join(f.root, "policy.json"), JSON.stringify({ maxSatsPerTx: 1, maxSatsPerDay: 1, maxSatsLifetime: 1, allowlist: [] }));
    writeFileSync(join(f.root, "brc181.json"), "split intentionally ignores signed agent policy");
    // Unterminated history must survive the new durable row.
    writeFileSync(join(f.root, "spends.jsonl"), JSON.stringify({ t: new Date().toISOString(), amount: 1 }));
    Transaction.prototype.sign = async function(...args) {
      signs++;
      const intent = JSON.parse(readFileSync(pending(f.root), "utf8"));
      expect(intent).toMatchObject({ version: 1, operation: "split", asset: "bsv", amount: 0, to: f.address });
      expect(intent.fee).toBe(20000 - this.outputs.reduce((sum, o) => sum + o.satoshis!, 0));
      expect(inspectPaymentHold(f.root)).toMatchObject({ blocked: true, pending: "valid", intent: { amount: 0 } });
      paymentId = intent.id;
      expect(existsSync(lock(f.root))).toBe(true);
      return original.apply(this, args);
    };
    const result = await splitPayment({ ...f, broadcast: async raw => {
      const tx = Transaction.fromHex(raw);
      expect(tx.outputs.length).toBeGreaterThan(1);
      for (const o of tx.outputs) expect(o.lockingScript.toHex()).toBe(new P2PKH().lock(f.address).toHex());
      return f.broadcast(raw);
    } });
    expect(result).toMatchObject({ ok: true, amount: 0, to: f.address });
    expect(signs).toBe(1);
    const rows = readFileSync(join(f.root, "spends.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ paymentId, kind: "split", amount: 0, fee: result.ok ? result.fee : -1 });
    expect(loadUsage(f.root)).toEqual({ spentToday: 1, spentLifetime: 1 });
    expect(inspectPaymentHold(f.root).blocked).toBe(false);
  } finally { Transaction.prototype.sign = original; rmSync(f.root, { recursive: true, force: true }); }
});

for (const behavior of ["timeout", "mismatch", "accounting"]) {
  test(`split ${behavior} retains hold and cannot be retried by split or agent send`, async () => {
    const f = fixture(); let broadcasts = 0;
    try {
      await expect(splitPayment({ ...f, broadcast: async raw => {
        broadcasts++;
        if (behavior === "timeout") throw new Error("synthetic timeout");
        if (behavior === "mismatch") return { txid: "aa".repeat(32) };
        mkdirSync(join(f.root, "spends.jsonl"));
        return f.broadcast(raw);
      } })).rejects.toThrow();
      expect(existsSync(pending(f.root))).toBe(true);
      expect(existsSync(lock(f.root))).toBe(true);
      expect(await splitPayment(f)).toMatchObject({ code: "PAYMENT_HELD" });
      expect(await sendPayment({ ...f, to: f.address, amount: 1 })).toMatchObject({ code: "PAYMENT_HELD" });
      expect(broadcasts).toBe(1);
      if (behavior !== "accounting") expect(loadUsage(f.root).spentLifetime).toBe(0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("split intent persistence failure prevents signing and broadcast", async () => {
  const f = fixture(); const original = Transaction.prototype.sign; let signs = 0; let broadcasts = 0;
  Transaction.prototype.sign = async function(...args) { signs++; return original.apply(this, args); };
  try {
    await expect(splitPayment({ ...f,
      fetchTxHex: async () => { mkdirSync(pending(f.root)); return f.fetchTxHex(); },
      broadcast: async raw => { broadcasts++; return f.broadcast(raw); },
    })).rejects.toThrow();
    expect(signs).toBe(0); expect(broadcasts).toBe(0);
    expect(existsSync(lock(f.root))).toBe(true);
  } finally { Transaction.prototype.sign = original; rmSync(f.root, { recursive: true, force: true }); }
});

test("split keeps kill gating; emergency sweeps remain outside holds", async () => {
  const f = fixture(); let calls = 0;
  try {
    killVault(f.root);
    expect(await splitPayment({ ...f, fetchUtxos: async () => { calls++; return []; } })).toMatchObject({ code: "KILL" });
    expect(calls).toBe(0); expect(inspectPaymentHold(f.root).blocked).toBe(false);
    writeFileSync(lock(f.root), "orphan");
    expect(await sweepPayment({ ...f, to: f.address, fetchUtxos: async () => [] })).toMatchObject({ code: "INSUFFICIENT" });
    expect(await sweepAllowance({ root: f.root, to: f.address })).toMatchObject({ code: "NEED_ALLOWANCE" });
    expect(existsSync(lock(f.root))).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const fault of ["value", "hash", "index", "script", "duplicate", "unsafe-total"]) {
  test(`split rejects ${fault} source metadata before signing or reserving a false fee`, async () => {
    const f = fixture(); const original = Transaction.prototype.sign; let signs = 0; let broadcasts = 0;
    Transaction.prototype.sign = async function(...args) { signs++; return original.apply(this, args); };
    try {
      const utxos = await f.fetchUtxos();
      let hex = await f.fetchTxHex();
      if (fault === "value") utxos[0].value++;
      if (fault === "hash") utxos[0].tx_hash = "aa".repeat(32);
      if (fault === "index") utxos[0].tx_pos = 1;
      if (fault === "script") {
        const source = new Transaction();
        source.addOutput({ satoshis: 20000, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) });
        hex = source.toHex(); utxos[0].tx_hash = source.id("hex");
      }
      if (fault === "duplicate") utxos.push({ ...utxos[0] });
      if (fault === "unsafe-total") utxos[0].value = Number.MAX_SAFE_INTEGER + 1;
      await expect(splitPayment({ ...f, fetchUtxos: async () => utxos, fetchTxHex: async () => hex,
        broadcast: async raw => { broadcasts++; return f.broadcast(raw); },
      })).rejects.toThrow();
      expect(signs).toBe(0); expect(broadcasts).toBe(0);
      expect(inspectPaymentHold(f.root).blocked).toBe(false);
    } finally { Transaction.prototype.sign = original; rmSync(f.root, { recursive: true, force: true }); }
  });
}

function spawn(root: string, mode: string, behavior = "normal") {
  return Bun.spawn([process.execPath, join(import.meta.dir, "test-support/payment-process.ts"), root, mode, behavior], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}
async function output(child: ReturnType<typeof spawn>) {
  const [text, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(exit).toBe(0);
  return JSON.parse(text.trim().split("\n").at(-1)!);
}
function processFixture(f: ReturnType<typeof fixture>) {
  writeFileSync(join(f.root, "policy.json"), JSON.stringify({ maxSatsPerTx: 500, maxSatsPerDay: 500, maxSatsLifetime: 500, allowlist: [f.address] }));
  return f.fetchTxHex().then(hex => writeFileSync(join(f.root, "fixture.json"), JSON.stringify({ hex, to: f.address })));
}
for (const mode of ["split", "send"]) {
  test(`cross-process ${mode} excludes split and send through broadcast/accounting`, async () => {
    const f = fixture(); await processFixture(f);
    const child = spawn(f.root, mode, "pause");
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read(); reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain("READY");
      for (const contender of ["split", "send"]) {
        const out = await output(spawn(f.root, contender));
        expect(out.result).toMatchObject({ code: "PAYMENT_HELD" }); expect(out.calls).toBe(0);
      }
      child.stdin.end();
      const remaining = child.stdout.getReader();
      let tail = "";
      for (;;) { const chunk = await remaining.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); }
      expect(await new Response(child.stderr).text()).toBe("");
      expect(await child.exited).toBe(0);
      expect(JSON.parse(tail.trim()).result.ok).toBe(true);
      expect(loadUsage(f.root).spentLifetime).toBe(mode === "split" ? 0 : 500);
      expect(inspectPaymentHold(f.root).blocked).toBe(false);
      const after = await output(spawn(f.root, "send"));
      expect(after.result).toMatchObject(mode === "split" ? { ok: true } : { code: "DAY" });
    } finally { child.kill(); await child.exited; rmSync(f.root, { recursive: true, force: true }); }
  }, 15000);
}

test("split process death at broadcast remains held on restart", async () => {
  const f = fixture(); await processFixture(f);
  const child = spawn(f.root, "split", "crash");
  try {
    expect(await child.exited).toBe(23);
    expect(inspectPaymentHold(f.root)).toMatchObject({ blocked: true, pending: "valid", intent: { amount: 0 } });
    for (const mode of ["split", "send"]) {
      const out = await output(spawn(f.root, mode));
      expect(out.result).toMatchObject({ code: "PAYMENT_HELD" }); expect(out.calls).toBe(0);
    }
  } finally { child.kill(); await child.exited; rmSync(f.root, { recursive: true, force: true }); }
});
