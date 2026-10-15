import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P2PKH, PrivateKey, Transaction } from "@bsv/sdk";
import { initVault, allowDestination, loadVault, loadUsage, killVault, statusVault } from "./vault";
import { sendPayment, sweepPayment } from "./send";

const to = PrivateKey.fromRandom().toAddress();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "payment-safety-"));
  initVault(root); allowDestination(root, to);
  const source = new Transaction();
  source.addOutput({ satoshis: 2000, lockingScript: new P2PKH().lock(loadVault(root).address) });
  return { root, to, amount: 500, fetchUtxos: async () => [{ tx_hash: source.id("hex"), tx_pos: 0, value: 2000 }], fetchTxHex: async () => source.toHex() };
}
function spawnPayment(root: string, mode: string, behavior = "normal") {
  return Bun.spawn([process.execPath, join(import.meta.dir, "test-support/payment-process.ts"), root, mode, behavior], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}
async function output(child: ReturnType<typeof spawnPayment>) {
  const [text, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(exit).toBe(0);
  return JSON.parse(text.trim().split("\n").at(-1)!);
}
for (const mode of ["send", "x402"]) {
  test(`separate processes exclude ${mode} against send AND x402, then re-read caps`, async () => {
    const f = fixture();
    writeFileSync(join(f.root, "fixture.json"), JSON.stringify({ hex: await f.fetchTxHex(), to }));
    writeFileSync(join(f.root, "policy.json"), JSON.stringify({ maxSatsPerTx: 1000, maxSatsPerDay: 700, maxSatsLifetime: 700, allowlist: [to] }));
    const child = spawnPayment(f.root, mode, "pause");
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read(); reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain("READY");
      for (const contender of ["send", "x402"]) {
        const r = await output(spawnPayment(f.root, contender));
        expect(r.result).toMatchObject({ code: "PAYMENT_HELD" }); expect(r.calls).toBe(0);
      }
      child.stdin.end();
      const remaining = child.stdout.getReader();
      let tail = "";
      for (;;) { const chunk = await remaining.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); }
      expect(await child.exited).toBe(0);
      expect(JSON.parse(tail.trim()).result.ok).toBe(true);
      expect(loadUsage(f.root).spentLifetime).toBe(500);
      const after = await output(spawnPayment(f.root, mode));
      expect(after.result).toMatchObject({ code: "DAY" });
      expect(after.calls).toBe(mode === "send" ? 0 : 1);
    } finally { child.kill(); await child.exited; rmSync(f.root, { recursive: true, force: true }); }
  }, 15000);

  test(`process death at ${mode} submission never unlocks on restart`, async () => {
    const f = fixture();
    writeFileSync(join(f.root, "fixture.json"), JSON.stringify({ hex: await f.fetchTxHex(), to }));
    try {
      const child = spawnPayment(f.root, mode, "crash");
      expect(await child.exited).toBe(23);
      expect(existsSync(pending(f.root))).toBe(true);
      const r = await output(spawnPayment(f.root, mode));
      expect(r.result).toMatchObject({ code: "PAYMENT_HELD" }); expect(r.calls).toBe(0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 15000);
}

test("read-only CLI diagnostics validate schema without echoing secrets or clearing holds", async () => {
  const f = fixture();
  try {
    for (const raw of ["{secret-broken", JSON.stringify({ version: 999, secret: "DO-NOT-ECHO" })]) {
      writeFileSync(pending(f.root), raw);
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "payment-inspect"], { env: { ...process.env, DOGFOOD_WALLET_DIR: f.root }, stdout: "pipe", stderr: "pipe" });
      const text = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(JSON.parse(text)).toMatchObject({ blocked: true, pending: "invalid" });
      expect(text).not.toContain("secret"); expect(text).not.toContain("DO-NOT-ECHO");
      expect(readFileSync(pending(f.root), "utf8")).toBe(raw);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

const lock = (root: string) => join(root, "payment.lock");
const pending = (root: string) => join(root, "payment.pending.json");

test("send excludes overlapping calls before usage read and releases after durable accounting", async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(r => entered = r);
  const wait = new Promise<void>(r => release = r);
  let broadcasts = 0;
  const broadcast = async (raw: string) => { broadcasts++; return { txid: Transaction.fromHex(raw).id("hex") }; };
  try {
    const first = sendPayment({ ...f, fetchUtxos: async () => { entered(); await wait; return f.fetchUtxos(); }, broadcast });
    await ready;
    const second = await sendPayment({ ...f, broadcast });
    release(); await first;
    expect(second).toMatchObject({ ok: false, code: "PAYMENT_HELD" });
    expect(broadcasts).toBe(1);
    expect(loadUsage(f.root).spentLifetime).toBe(500);
    expect(existsSync(lock(f.root))).toBe(false);
    expect(existsSync(pending(f.root))).toBe(false);
  } finally { release?.(); rmSync(f.root, { recursive: true, force: true }); }
});

test("timeout after submission retains pre-sign intent and blocks retries, not reads/kill/sweep", async () => {
  const f = fixture(); let sawHold = false; let retries = 0;
  try {
    await expect(sendPayment({ ...f, broadcast: async () => { sawHold = existsSync(pending(f.root)); throw new Error("fixture timeout"); } })).rejects.toThrow("fixture timeout");
    expect(sawHold).toBe(true);
    expect(JSON.parse(readFileSync(pending(f.root), "utf8"))).toMatchObject({ version: 1, asset: "bsv", amount: 500, to });
    const retry = await sendPayment({ ...f, fetchUtxos: async () => { retries++; return []; } });
    expect(retry).toMatchObject({ ok: false, code: "PAYMENT_HELD" });
    expect(retries).toBe(0);
    expect(statusVault(f.root).address).toBe(loadVault(f.root).address);
    killVault(f.root);
    expect(statusVault(f.root).killfile).toBe(true);
    const sweep = await sweepPayment({ root: f.root, to, fetchUtxos: async () => [] });
    expect(sweep).toMatchObject({ code: "INSUFFICIENT" });
    expect(existsSync(pending(f.root))).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const content of ["{broken", JSON.stringify({ version: 999 }), ""]) {
  test(`orphan/corrupt intent blocks without network (${content})`, async () => {
    const f = fixture(); let fetched = false;
    try {
      writeFileSync(pending(f.root), content);
      expect(await sendPayment({ ...f, fetchUtxos: async () => { fetched = true; return []; } })).toMatchObject({ code: "PAYMENT_HELD" });
      expect(fetched).toBe(false);
      expect(readFileSync(pending(f.root), "utf8")).toBe(content);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("pending persistence failure prevents signing/submission and stays held", async () => {
  const f = fixture(); let broadcasts = 0;
  const original = Transaction.prototype.sign; let signs = 0;
  Transaction.prototype.sign = async function(...args) { signs++; return original.apply(this, args); };
  try {
    // Create an obstruction AFTER acquiring the payment lock, during source retrieval.
    await expect(sendPayment({ ...f, fetchTxHex: async () => { mkdirSync(pending(f.root)); return f.fetchTxHex(); }, broadcast: async () => { broadcasts++; return { txid: "aa".repeat(32) }; } })).rejects.toThrow();
    expect(signs).toBe(0); expect(broadcasts).toBe(0);
    expect(existsSync(lock(f.root))).toBe(true);
  } finally { Transaction.prototype.sign = original; rmSync(f.root, { recursive: true, force: true }); }
});

test("durable accounting preserves unterminated historical log rows", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "spends.jsonl"), JSON.stringify({ t: new Date().toISOString(), amount: 100, asset: "bsv" }));
    expect((await sendPayment({ ...f, broadcast: async raw => ({ txid: Transaction.fromHex(raw).id("hex") }) })).ok).toBe(true);
    expect(loadUsage(f.root).spentLifetime).toBe(600);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("mismatched broadcast acknowledgement retains hold instead of committing success", async () => {
  const f = fixture();
  try {
    await expect(sendPayment({ ...f, broadcast: async () => ({ txid: "aa".repeat(32) }) })).rejects.toThrow("acknowledgement");
    expect(existsSync(pending(f.root))).toBe(true);
    expect(loadUsage(f.root).spentLifetime).toBe(0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("log commit failure after broadcast retains intent", async () => {
  const f = fixture();
  try {
    await expect(sendPayment({ ...f, broadcast: async (raw) => { mkdirSync(join(f.root, "spends.jsonl")); return { txid: Transaction.fromHex(raw).id("hex") }; } })).rejects.toThrow();
    expect(existsSync(pending(f.root))).toBe(true);
    expect(existsSync(lock(f.root))).toBe(true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
