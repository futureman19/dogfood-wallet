import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const worker = join(import.meta.dir, "test-support/mcp-delegate.ts");
function temp() { return mkdtempSync(join(tmpdir(), "dogfood-delegate-")); }
function spawn(root: string, mode: string, action = "delegate") { return Bun.spawn([process.execPath, worker, root, mode, action], { stdout: "pipe", stderr: "pipe" }); }
async function result(p: ReturnType<typeof spawn>) { const out = await new Response(p.stdout).text(); const err = await new Response(p.stderr).text(); expect(await p.exited, err).toBe(0); return JSON.parse(out); }
async function run(mode: string, check: (r: any, root: string) => void) { const root = temp(); try { check(await result(spawn(root, mode)), root); } finally { rmSync(root, { recursive: true, force: true }); } }
for (const mode of ["held", "pending", "sponsored-held"]) test(`MCP ${mode} blocks before policy/network/signing`, () => run(mode, r => { expect(r.body.code).toBe("PAYMENT_HELD"); expect(r.events).toEqual([]); expect(r.rows).toEqual([]); }));
for (const mode of ["allowlist", "cap", "day", "kill", "brc181"]) test(`MCP ${mode} gates remain intact`, () => run(mode, r => { expect(r.body.ok).toBe(false); expect(r.events).toEqual([]); expect(r.held).toBe(false); }));
for (const mode of ["timeout", "broadcast-timeout", "payee", "change", "txid", "bad-signature", "broadcast-id", "extra-output", "sign-failure", "log-failure", "duplicate", "extra-local", "version"]) test(`MCP ${mode} retains durable exposure without accounting`, () => run(mode, r => { expect(r.body.ok).toBe(false); expect(r.events).toContain(mode === "sign-failure" ? "intent-before-sign" : "intent"); expect(r.held).toBe(true); expect(r.pending).toBe(true); expect(r.rows).toEqual([]); if (["payee", "change", "txid", "bad-signature"].includes(mode)) expect(r.events).not.toContain("broadcast"); }));
test("no-broadcast proof is exposure, not a completed payment", () => run("no-broadcast", r => { expect(r.held).toBe(true); expect(r.pending).toBe(true); expect(r.rows).toEqual([]); expect(r.events).toContain("intent"); expect(r.events).not.toContain("broadcast"); }));
for (const mode of ["exact", "value-lie", "source-lie", "multi"]) test(`${mode} unsupported/invalid funding rejected before exposure`, () => run(mode, r => { expect(r.body.ok).toBe(false); expect(r.events).not.toContain("delegate"); expect(r.held).toBe(false); expect(r.pending).toBe(false); }));
test("pending write failure prevents signing and POST", () => run("pending-failure", r => {
  expect(r.body.code).toBe("PAYMENT_HELD"); expect(r.held).toBe(true); expect(r.events).not.toContain("delegate");
  expect(r.events).not.toContain("intent-before-sign"); expect(r.events).not.toContain("unheld-sign");
}));
test("actual CLI refuses hold even with no readable vault policy/key", async () => {
  const root = temp();
  try {
    writeFileSync(join(root, "payment.lock"), "orphan");
    const vectors = JSON.parse(readFileSync(join(import.meta.dir, "../testdata/x402-vectors-v1.json"), "utf8"));
    const header = Buffer.from(JSON.stringify(vectors.vectors.find((v: any) => v.name === "valid_get_empty").challenge)).toString("base64url");
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "x402-delegate", header, "--vault-fund", "--broadcast"], {
      env: { ...process.env, DOGFOOD_WALLET_DIR: root }, stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(1); expect(JSON.parse(out).code).toBe("PAYMENT_HELD");
    expect(readFileSync(join(root, "payment.lock"), "utf8")).toBe("orphan");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("MCP registry has no unguarded payment or hold-clear tool", () => run("held", r => {
  expect(r.tools.sort()).toEqual(["address", "balance", "kill", "send", "status", "x402_delegate", "x402_inspect", "x402_pay", "x402_proof"]);
}));
test("pure sponsored timeout releases without local accounting", () => run("sponsored-timeout", r => {
  expect(r.body.ok).toBe(false); expect(r.events).toContain("delegate");
  expect(r.held).toBe(false); expect(r.pending).toBe(false); expect(r.rows).toEqual([]);
}));
test("sponsored template cannot expose a local input to the delegator", () => run("sponsored-own", r => {
  expect(r.body.ok).toBe(false); expect(r.events).not.toContain("delegate"); expect(r.rows).toEqual([]); expect(r.held).toBe(false);
}));
test("client signature commits payee and change before remote exposure", () => run("success", r => {
  expect(r.events).toContain("intent-before-sign"); expect(r.events).toContain("sighash-193"); expect(r.events).not.toContain("unheld-sign");
}));
test("validated broadcast commits exactly once and releases", () => run("success", (r, root) => { expect(r.body.ok).toBe(true); expect(r.events).toContain("intent"); expect(r.events.filter((x: string) => x === "broadcast")).toHaveLength(1); expect(r.rows).toHaveLength(1); expect(r.rows[0]).toMatchObject({ amount: 100, asset: "bsv", fee: 0, txid: r.body.txid }); expect(r.rows[0].paymentId).toMatch(/^[a-f0-9-]{36}$/); expect(r.held).toBe(false); expect(r.pending).toBe(false); }));
test("sponsored settlement never accounts local spending or reserves local funds", () => run("sponsored", r => { expect(r.body.ok).toBe(true); expect(r.body.vaultPaid).toBe(false); expect(r.rows).toEqual([]); expect(r.held).toBe(false); expect(r.pending).toBe(false); }));
async function entered(root: string, p: ReturnType<typeof spawn>) { for (let i = 0; i < 300; i++) { if (existsSync(join(root, "entered"))) return; if (p.exitCode !== null) throw new Error(await new Response(p.stderr).text()); await Bun.sleep(10); } throw new Error("fixture never entered network"); }
test("broadcast-time process death retains exposure across restart", async () => {
  const root = temp();
  const p = spawn(root, "broadcast-pause");
  try {
    await entered(root, p);
    p.kill(); await p.exited;
    expect(existsSync(join(root, "payment.pending.json"))).toBe(true);
    const retry = await result(spawn(root, "success"));
    expect(retry.body.code).toBe("PAYMENT_HELD");
    expect(retry.events).toEqual([]); expect(retry.rows).toEqual([]);
  } finally {
    if (p.exitCode === null) { p.kill(); await p.exited; }
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("next process re-reads committed delegate usage without duplicate accounting", async () => {
  const root = temp();
  try {
    const first = await result(spawn(root, "success"));
    expect(first.rows).toHaveLength(1);
    const policyPath = join(root, "policy.json");
    const policy = JSON.parse(readFileSync(policyPath, "utf8"));
    writeFileSync(policyPath, JSON.stringify({ ...policy, maxSatsPerDay: 100 }));
    const retry = await result(spawn(root, "success"));
    expect(retry.body.code).toBe("DAY");
    expect(retry.events).toEqual([]); expect(retry.rows).toEqual(first.rows);
    expect(retry.held).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const first of ["send", "delegate"]) test(`cross-process ${first} blocks ${first === "send" ? "delegate" : "send"}; crash remains held`, async () => {
  const root = temp(); const p = spawn(root, "pause", first);
  try { await entered(root, p); const r = await result(spawn(root, "success", first === "send" ? "delegate" : "send")); expect(r.body.code).toBe("PAYMENT_HELD"); expect(r.events).toEqual([]); p.kill(); await p.exited; const retry = await result(spawn(root, "success")); expect(retry.body.code).toBe("PAYMENT_HELD"); expect(retry.events).toEqual([]); if (first === "delegate") { const pending = JSON.parse(readFileSync(join(root, "payment.pending.json"), "utf8")); expect(pending.operation).toBe("x402-delegate"); } }
  finally { if (p.exitCode === null) { p.kill(); await p.exited; } rmSync(root, { recursive: true, force: true }); }
}, 15000);
