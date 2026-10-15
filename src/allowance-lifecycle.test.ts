import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MasterCertificate, P2PKH, PrivateKey, Transaction } from "@bsv/sdk";
import * as allowance from "./allowance";
import { initVault, loadVault, loadUsage } from "./vault";
import { inspectPaymentHold } from "./payment-guard";
import { sendPayment } from "./send";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "allowance-lifecycle-"));
  initVault(root);
  const address = loadVault(root).address;
  const source = new Transaction();
  source.addOutput({ satoshis: 20000, lockingScript: new P2PKH().lock(address) });
  return { root, address, agentPubHex: PrivateKey.fromRandom().toPublicKey().toString(), amount: 1000,
    fetchUtxos: async () => [{ tx_hash: source.id("hex"), tx_pos: 0, value: 20000 }],
    fetchTxHex: async () => source.toHex(),
    broadcast: async (raw: string) => ({ txid: Transaction.fromHex(raw).id("hex") }) };
}
const recordPath = (root: string, id: string) => join(root, "allowances", `${id}.json`);
const readRecord = (root: string, id: string) => JSON.parse(readFileSync(recordPath(root, id), "utf8"));
const clean = (root: string) => rmSync(root, { recursive: true, force: true });

function spawn(root: string, mode: string, behavior = "normal") {
  return Bun.spawn([process.execPath, join(import.meta.dir, "test-support/payment-process.ts"), root, mode, behavior], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}
async function output(child: ReturnType<typeof spawn>) {
  const [text, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(exit).toBe(0);
  return JSON.parse(text.trim().split("\n").at(-1)!);
}
async function prepareProcess(f: ReturnType<typeof fixture>) {
  writeFileSync(join(f.root, "policy.json"), JSON.stringify({ maxSatsPerTx: 1000, maxSatsLifetime: 1000, allowlist: [f.address] }));
  writeFileSync(join(f.root, "fixture.json"), JSON.stringify({ hex: await f.fetchTxHex(), to: f.address, agentPubHex: f.agentPubHex }));
}
for (const mode of ["fund", "send"]) {
  test(`cross-process ${mode} excludes fund and send before policy reads`, async () => {
    const f = fixture(); await prepareProcess(f); const child = spawn(f.root, mode, "pause");
    try {
      const reader = child.stdout.getReader(); const ready = await reader.read(); reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain("READY");
      const policy = readFileSync(join(f.root, "policy.json"), "utf8");
      writeFileSync(join(f.root, "policy.json"), "malformed policy must not be read");
      for (const contender of ["fund", "send"]) {
        const out = await output(spawn(f.root, contender));
        expect(out.result).toMatchObject({ code: "PAYMENT_HELD" }); expect(out.calls).toBe(0);
      }
      writeFileSync(join(f.root, "policy.json"), policy);
      child.stdin.end();
      const remaining = child.stdout.getReader(); let tail = "";
      for (;;) { const chunk = await remaining.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); }
      expect(await new Response(child.stderr).text()).toBe(""); expect(await child.exited).toBe(0);
      expect(JSON.parse(tail.trim()).result.ok).toBe(true);
      expect(loadUsage(f.root).spentLifetime).toBe(500);
      if (mode === "fund") expect(await allowance.listAllowances(f.root)).toHaveLength(1);
    } finally { child.kill(); await child.exited; clean(f.root); }
  }, 15000);
}
for (const behavior of ["crash-stage", "crash", "crash-accounting"]) {
  test(`fund process ${behavior} preserves recovery evidence and holds on restart`, async () => {
    const f = fixture(); await prepareProcess(f); const child = spawn(f.root, "fund", behavior);
    try {
      expect(await child.exited).toBe(23);
      expect(inspectPaymentHold(f.root)).toMatchObject({ blocked: true, pending: "valid" });
      const rows = await allowance.listAllowances(f.root); expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("unresolved");
      expect(readRecord(f.root, rows[0].recordId).descriptor.masterKeyring).toBeDefined();
      expect(loadUsage(f.root).spentLifetime).toBe(behavior === "crash-accounting" ? 500 : 0);
      for (const mode of ["fund", "send"]) expect((await output(spawn(f.root, mode))).result).toMatchObject({ code: "PAYMENT_HELD" });
    } finally { child.kill(); await child.exited; clean(f.root); }
  }, 15000);
}

test("owner CLI list emits only sanitized offline inventory", async () => {
  const f = fixture();
  try {
    expect((await allowance.fundAllowance(f)).ok).toBe(true);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "allowance-list"], {
      env: { ...process.env, DOGFOOD_WALLET_DIR: f.root }, stdout: "pipe", stderr: "pipe",
    });
    const text = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(text)).toHaveLength(1);
    expect(text).not.toContain("masterKeyring"); expect(text).not.toContain("rawHex"); expect(text).not.toContain("signature");
  } finally { clean(f.root); }
});

test("repeated funding keeps immutable private descriptors and accounts each exactly once", async () => {
  const f = fixture();
  try {
    const first = await allowance.fundAllowance(f); expect(first.ok).toBe(true); if (!first.ok) return;
    expect(existsSync(recordPath(f.root, first.txid))).toBe(true);
    const bytes = readFileSync(recordPath(f.root, first.txid), "utf8");
    const second = await allowance.fundAllowance(f); expect(second.ok).toBe(true); if (!second.ok) return;
    expect(readFileSync(recordPath(f.root, first.txid), "utf8")).toBe(bytes);
    expect(readRecord(f.root, first.txid).descriptor.masterKeyring).toBeDefined();
    expect(first.descriptor.masterKeyring).toBeUndefined();
    expect(second.descriptor.masterKeyring).toBeUndefined();
    expect(await allowance.listAllowances(f.root)).toHaveLength(2);
    expect(loadUsage(f.root).spentLifetime).toBe(2000);
    expect(inspectPaymentHold(f.root).blocked).toBe(false);
    expect(await allowance.sweepAllowance({ ...f, fetchTxHex: async () => { throw Error("must select"); } })).toMatchObject({ code: "SELECT_ALLOWANCE" });
  } finally { clean(f.root); }
});

test("legacy descriptor remains byte-identical through funding and requires explicit selection", async () => {
  const f = fixture();
  try {
    const first = await allowance.fundAllowance(f); if (!first.ok) throw Error("fixture funding");
    // Fixture migration from the historical single descriptor, with its private keyring.
    const descriptor = existsSync(recordPath(f.root, first.txid)) ? readRecord(f.root, first.txid).descriptor : JSON.parse(readFileSync(join(f.root, "allowance.json"), "utf8"));
    const legacy = JSON.stringify(descriptor, null, 2);
    writeFileSync(join(f.root, "allowance.json"), legacy);
    rmSync(join(f.root, "allowances"), { recursive: true, force: true });
    const second = await allowance.fundAllowance(f); expect(second.ok).toBe(true);
    expect(readFileSync(join(f.root, "allowance.json"), "utf8")).toBe(legacy);
    expect(await allowance.listAllowances(f.root)).toHaveLength(2);
    const swept = await allowance.sweepAllowance({ ...f, recordId: "legacy", fetchTxHex: async () => first.rawHex });
    expect(swept.ok).toBe(true);
    expect(readFileSync(join(f.root, "allowance.json"), "utf8")).toBe(legacy);
  } finally { clean(f.root); }
});

test("signed descriptor, certificate and keyring exist before broadcast; intent exists before sign", async () => {
  const f = fixture(); const sign = Transaction.prototype.sign; let signs = 0;
  try {
    Transaction.prototype.sign = async function(...args) {
      signs++;
      expect(inspectPaymentHold(f.root)).toMatchObject({ blocked: true, pending: "valid" });
      return sign.apply(this, args);
    };
    const result = await allowance.fundAllowance({ ...f, broadcast: async raw => {
      const id = Transaction.fromHex(raw).id("hex"); const row = readRecord(f.root, id);
      expect(row.rawHex).toBe(raw); expect(row.txid).toBe(id);
      expect(row.descriptor.masterKeyring).toBeDefined(); expect(row.descriptor.certificate.signature).toBeDefined();
      return f.broadcast(raw);
    } });
    expect(result.ok).toBe(true); expect(signs).toBe(1);
  } finally { Transaction.prototype.sign = sign; clean(f.root); }
});

for (const fault of ["intent", "descriptor", "accounting", "receipt", "timeout", "txid"]) {
  test(`${fault} failure keeps hold; persistence before exposure never broadcasts`, async () => {
    const f = fixture(); const sign = Transaction.prototype.sign; let signs = 0; let broadcasts = 0;
    try {
      Transaction.prototype.sign = async function(...args) {
        signs++;
        await sign.apply(this, args);
        if (fault === "descriptor") writeFileSync(join(f.root, "allowances"), "blocked");
      };
      await expect(allowance.fundAllowance({ ...f,
        fetchTxHex: async () => { if (fault === "intent") mkdirSync(join(f.root, "payment.pending.json")); return f.fetchTxHex(); },
        broadcast: async raw => {
          broadcasts++;
          if (fault === "accounting") mkdirSync(join(f.root, "spends.jsonl"));
          if (fault === "receipt") mkdirSync(join(f.root, "allowances", `${Transaction.fromHex(raw).id("hex")}.accounted.json`));
          if (fault === "timeout") throw Error("uncertain synthetic broadcast");
          if (fault === "txid") return { txid: "ff".repeat(32) };
          return f.broadcast(raw);
        },
      })).rejects.toThrow();
      expect(broadcasts).toBe(["intent", "descriptor"].includes(fault) ? 0 : 1);
      if (fault === "intent") expect(signs).toBe(0);
      expect(inspectPaymentHold(f.root).blocked).toBe(true);
      expect(await allowance.fundAllowance(f)).toMatchObject({ code: "PAYMENT_HELD" });
      expect(await sendPayment({ ...f, to: f.address })).toMatchObject({ code: "PAYMENT_HELD" });
      if (["timeout", "txid", "receipt"].includes(fault)) {
        const files = readdirSync(join(f.root, "allowances")).filter(x => /^[a-f0-9]{64}\.json$/.test(x));
        expect(files).toHaveLength(1);
        expect(readRecord(f.root, files[0].slice(0, -5)).rawHex).toBeTruthy();
        expect(loadUsage(f.root).spentLifetime).toBe(fault === "receipt" ? 1000 : 0);
      }
    } finally { Transaction.prototype.sign = sign; clean(f.root); }
  });
}

for (const fault of ["hash", "value", "index", "script", "duplicate", "unsafe"]) {
  test(`invalid funding source ${fault} never signs or broadcasts`, async () => {
    const f = fixture(); const sign = Transaction.prototype.sign; let signs = 0; let broadcasts = 0;
    try {
      const coins = await f.fetchUtxos(); let hex = await f.fetchTxHex();
      if (fault === "hash") coins[0].tx_hash = "ab".repeat(32);
      if (fault === "value") coins[0].value++;
      if (fault === "index") coins[0].tx_pos = 5;
      if (fault === "duplicate") coins.push({ ...coins[0] });
      if (fault === "unsafe") coins[0].value = Number.MAX_SAFE_INTEGER + 1;
      if (fault === "script") { const tx = new Transaction(); tx.addOutput({ satoshis: 20000, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) }); hex = tx.toHex(); coins[0].tx_hash = tx.id("hex"); }
      Transaction.prototype.sign = async function(...args) { signs++; return sign.apply(this, args); };
      await expect(allowance.fundAllowance({ ...f, fetchUtxos: async () => coins, fetchTxHex: async () => hex, broadcast: async raw => { broadcasts++; return f.broadcast(raw); } })).rejects.toThrow();
      expect(signs).toBe(0); expect(broadcasts).toBe(0);
    } finally { Transaction.prototype.sign = sign; clean(f.root); }
  });
}

for (const state of ["legacy", "archive", "orphan-receipt"]) {
  test(`malformed ${state} blocks funding without network`, async () => {
    const f = fixture(); let calls = 0;
    try {
      if (state === "legacy") writeFileSync(join(f.root, "allowance.json"), '{"masterKeyring":"DO_NOT_PRINT"}');
      else { mkdirSync(join(f.root, "allowances")); writeFileSync(join(f.root, "allowances", "aa".repeat(32) + (state === "archive" ? ".json" : ".accounted.json")), "DO_NOT_PRINT"); }
      await expect(allowance.fundAllowance({ ...f, fetchUtxos: async () => { calls++; return []; } })).rejects.toThrow("Invalid allowance state");
      expect(calls).toBe(0);
    } finally { clean(f.root); }
  });
}

test("emergency sweep explicitly selects unresolved record without removing hold or history", async () => {
  const f = fixture(); let funded = "";
  try {
    await expect(allowance.fundAllowance({ ...f, broadcast: async raw => { funded = raw; throw Error("timeout"); } })).rejects.toThrow();
    const id = Transaction.fromHex(funded).id("hex"); const bytes = readFileSync(recordPath(f.root, id), "utf8");
    writeFileSync(join(f.root, "STOP_SPENDING"), "stop");
    const swept = await allowance.sweepAllowance({ ...f, recordId: id, fetchTxHex: async () => funded });
    expect(swept.ok).toBe(true); expect(inspectPaymentHold(f.root).blocked).toBe(true);
    expect(readFileSync(recordPath(f.root, id), "utf8")).toBe(bytes);
    expect((await allowance.listAllowances(f.root))[0].status).toBe("unresolved");
  } finally { clean(f.root); }
});

test("certificate issuance failure holds without exposing signed bytes", async () => {
  const f = fixture(); const issue = MasterCertificate.issueCertificateForSubject; let broadcasts = 0;
  try {
    MasterCertificate.issueCertificateForSubject = async () => { throw Error("synthetic certificate failure"); };
    await expect(allowance.fundAllowance({ ...f, broadcast: async raw => { broadcasts++; return f.broadcast(raw); } })).rejects.toThrow();
    expect(broadcasts).toBe(0); expect(inspectPaymentHold(f.root).blocked).toBe(true);
  } finally { MasterCertificate.issueCertificateForSubject = issue; clean(f.root); }
});

for (const fault of ["missing-log", "duplicate-log", "wrong-amount"]) {
  test(`accounted archive with ${fault} refuses fresh funding; never replays accounting`, async () => {
    const f = fixture();
    try {
      expect((await allowance.fundAllowance(f)).ok).toBe(true);
      const path = join(f.root, "spends.jsonl"); const row = readFileSync(path, "utf8");
      if (fault === "missing-log") rmSync(path);
      if (fault === "duplicate-log") writeFileSync(path, row + row);
      if (fault === "wrong-amount") writeFileSync(path, JSON.stringify({ ...JSON.parse(row), amount: 1 }) + "\n");
      await expect(allowance.fundAllowance({ ...f, fetchUtxos: async () => { throw Error("must not fetch"); } })).rejects.toThrow("Invalid allowance state");
      if (fault === "missing-log") expect(existsSync(path)).toBe(false);
    } finally { clean(f.root); }
  });
}

test("explicit emergency selection can bypass unrelated corrupt history, but not rewrite it", async () => {
  const f = fixture();
  try {
    const first = await allowance.fundAllowance(f); if (!first.ok) throw Error("fixture");
    const bad = join(f.root, "allowances", "aa".repeat(32) + ".json"); writeFileSync(bad, "broken unrelated evidence");
    writeFileSync(join(f.root, "payment.lock"), "held");
    const result = await allowance.sweepAllowance({ ...f, recordId: first.txid, fetchTxHex: async () => first.rawHex });
    expect(result.ok).toBe(true); expect(readFileSync(bad, "utf8")).toBe("broken unrelated evidence");
    expect(inspectPaymentHold(f.root).blocked).toBe(true);
  } finally { clean(f.root); }
});

test("successful accounting gates next fund by lifetime cap even with empty owner allowlist", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "policy.json"), JSON.stringify({ maxSatsPerTx: 1000, maxSatsLifetime: 1000, allowlist: [] }));
    expect((await allowance.fundAllowance(f)).ok).toBe(true);
    expect(await allowance.fundAllowance({ ...f, fetchUtxos: async () => { throw Error("cap must precede fetch"); } })).toMatchObject({ code: "LIFETIME" });
    expect(loadUsage(f.root).spentLifetime).toBe(1000);
  } finally { clean(f.root); }
});
