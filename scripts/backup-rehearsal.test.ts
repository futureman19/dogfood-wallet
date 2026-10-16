import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "backup-rehearsal.ts");
function run(args: string[]) {
  return Bun.spawnSync([process.execPath, script, ...args], { env: { ...process.env, DOGFOOD_WALLET_DIR: "DO-NOT-USE-INHERITED-VAULT" }, timeout: 30000 });
}
test("rehearsal requires explicit opt-in and scratch parent", () => {
  const result = run([]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("--offline-fixture-only --scratch-parent");
});
test("offline full-directory rehearsal proves preservation and cleans private fixtures", () => {
  const parent = mkdtempSync(join(tmpdir(), "dogfood-rehearsal-test-"));
  try {
    const result = run(["--offline-fixture-only", "--scratch-parent", parent]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const report = JSON.parse(result.stdout.toString());
    expect(report).toEqual({
      offline: true, funded: false, layouts: ["completed-init", "legacy"],
      identicalBytes: true, independentFiles: true, sameSigningIdentity: true,
      capsAllowlistKillUsagePreserved: true, ambiguousHoldPreserved: true,
      opaqueRecoveryRecordsPreserved: true, cliAddressStatusDenial: true,
      interruptedInitBlocked: true, corruptIncompleteRejected: true,
      existingTargetsPreserved: true, fixturesRemoved: true,
    });
    expect(readdirSync(parent)).toEqual([]);
    expect(existsSync("DO-NOT-USE-INHERITED-VAULT")).toBe(false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
}, 40000);
