import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initVault, allowDestination, killVault } from "./vault";

const cli = resolve(import.meta.dir, "cli.ts");
function run(root: string, script = cli, args = ["doctor"]) {
  const p = Bun.spawnSync([process.execPath, script, ...args], {
    cwd: tmpdir(), env: { ...process.env, DOGFOOD_WALLET_DIR: root },
  });
  expect(p.exitCode).toBe(0);
  return JSON.parse(p.stdout.toString());
}
function fixture(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "dogfood-doctor-"));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function metadata(root: string) {
  return readdirSync(root).sort().map(n => [n, statSync(join(root, n)).size, statSync(join(root, n)).mtimeMs]);
}

test("doctor reports missing vault without creating it", () => fixture(parent => {
  const root = join(parent, "missing");
  const d = run(root);
  expect(d.root).toBe(resolve(root));
  expect(d.vault).toBe("missing");
  expect(d.policy.state).toBe("missing");
  expect(d.dependencies.every((x: any) => x.available)).toBe(true);
  expect(d.hold.blocked).toBe(false);
  expect(existsSync(root)).toBe(false);
}));

test("doctor reports deny-by-default then human allowlist, without decrypting or writing", () => fixture(root => {
  const { address } = initVault(root);
  let d = run(root);
  expect(d.policy).toMatchObject({ state: "configured", allowlist: "deny-all", destinations: 0, maxSatsPerTx: 10000, maxSatsPerDay: 50000 });
  allowDestination(root, address);
  // Invalid private material: diagnostics must never attempt decryption or print it.
  writeFileSync(join(root, "wif.enc"), "PRIVATE_SENTINEL");
  writeFileSync(join(root, "wrap.key"), "PRIVATE_SENTINEL");
  const before = metadata(root);
  d = run(root);
  expect(d.vault).toBe("files-present-unverified");
  expect(d.policy).toMatchObject({ allowlist: "restricted", destinations: 1 });
  expect(JSON.stringify(d)).not.toContain("PRIVATE_SENTINEL");
  expect(metadata(root)).toEqual(before);
}));

test("doctor preserves kill and corrupt hold diagnostics without exposing file contents", () => fixture(root => {
  initVault(root);
  killVault(root);
  writeFileSync(join(root, "payment.lock"), "PRIVATE_SENTINEL");
  writeFileSync(join(root, "payment.pending.json"), "PRIVATE_SENTINEL");
  const before = metadata(root);
  const d = run(root);
  expect(d.kill).toBe("present");
  expect(d.hold).toEqual({ blocked: true, lock: "present", pending: "invalid" });
  expect(JSON.stringify(d)).not.toContain("PRIVATE_SENTINEL");
  expect(metadata(root)).toEqual(before);
}));

test("doctor distinguishes malformed and legacy unrestricted policy", () => fixture(root => {
  initVault(root);
  writeFileSync(join(root, "policy.json"), "PRIVATE_SENTINEL");
  expect(run(root).policy.state).toBe("invalid");
  writeFileSync(join(root, "policy.json"), JSON.stringify({ maxSatsPerTx: 10000 }));
  expect(run(root).policy.allowlist).toBe("unrestricted");
  writeFileSync(join(root, "policy.json"), JSON.stringify({ allowlist: [42] }));
  expect(run(root).policy.state).toBe("invalid");
}));

test("standalone preflight works without installed dependencies", () => fixture(root => {
  copyFileSync(join(import.meta.dir, "doctor.ts"), join(root, "doctor.ts"));
  copyFileSync(join(import.meta.dir, "payment-guard.ts"), join(root, "payment-guard.ts"));
  const d = run(join(root, "missing"), join(root, "doctor.ts"), []);
  expect(d.dependencies.every((x: any) => !x.available)).toBe(true);
  expect(d.vault).toBe("missing");
}));
