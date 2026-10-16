// Repository-only acceptance harness, NOT a backup/restore API for real vaults.
// Accepts only a scratch parent; every vault is generated here and removed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { initVault, killVault, loadUsage, loadVault, statusVault } from "../src/vault";
import { inspectPaymentHold, withPaymentGuard } from "../src/payment-guard";
import { evaluateSend } from "../src/policy";

// All wallet network paths exercised here use fetch. Fail immediately rather
// than providing synthetic provider responses. This is not an OS firewall.
globalThis.fetch = (() => { throw new Error("NETWORK_FORBIDDEN"); }) as unknown as typeof fetch;

type Inventory = Record<string, string>;
function inventory(root: string): Inventory {
  const result: Inventory = {};
  function walk(relative: string) {
    const path = join(root, relative);
    const st = lstatSync(path);
    assert(!st.isSymbolicLink(), "Links are not supported");
    if (st.isDirectory()) {
      result[relative] = "directory";
      for (const name of readdirSync(path).sort()) walk(relative ? `${relative}/${name}` : name);
    } else {
      assert(st.isFile(), "Only regular files are supported");
      result[relative] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  walk("");
  return result;
}
function readable(root: string) {
  // Stronger than legacy loader defaults: missing policy must not be silently
  // accepted by this rehearsal. No init or repair fallback is permitted.
  for (const name of ["wif.enc", "wrap.key", "address.txt", "policy.json"])
    assert(lstatSync(join(root, name)).isFile());
  return loadVault(root);
}
function copyVerified(source: string, destination: string, expected: Inventory, requireReadable = true) {
  assert.deepEqual(inventory(source), expected);
  if (requireReadable) readable(source);
  // Exclusive directory claim: even an existing EMPTY destination is refused.
  // Never merge, overwrite, hardlink, repair, or remove an existing target.
  mkdirSync(destination, { mode: 0o700 });
  for (const [relative, hash] of Object.entries(expected)) {
    if (!relative) continue;
    const target = join(destination, relative);
    if (hash === "directory") mkdirSync(target, { mode: 0o700 });
    else writeFileSync(target, readFileSync(join(source, relative)), { flag: "wx", mode: 0o600 });
  }
  assert.deepEqual(inventory(destination), expected);
  if (requireReadable) readable(destination);
}
function refuses(fn: () => unknown) {
  let rejected = false;
  try { fn(); } catch { rejected = true; }
  assert(rejected, "Expected fail-closed refusal");
}

async function rehearse(parent: string) {
  assert(isAbsolute(parent), "Absolute scratch parent required");
  assert(lstatSync(parent).isDirectory() && !lstatSync(parent).isSymbolicLink());
  const workspace = mkdtempSync(join(parent, "dogfood-offline-restore-"));
  try {
    const preload = join(workspace, "deny-network.ts");
    const networkWitness = join(workspace, "network-attempted");
    writeFileSync(preload, `import { writeFileSync } from "node:fs";\nglobalThis.fetch = (() => { writeFileSync(${JSON.stringify(networkWitness)}, "forbidden"); throw new Error("NETWORK_FORBIDDEN"); }) as unknown as typeof fetch;\n`);
    const cli = resolve(import.meta.dir, "../src/cli.ts");
    const child = (root: string, ...args: string[]) => {
      // Deliberately do not inherit wallet/provider credentials or .env config.
      const env: Record<string, string> = {
        DOGFOOD_WALLET_DIR: root, TEMP: workspace, TMP: workspace, TMPDIR: workspace,
        NODE_ENV: "test", PATH: process.env.PATH ?? "",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      };
      const result = Bun.spawnSync([process.execPath, "--no-env-file", "--preload", preload, cli, ...args],
        { cwd: workspace, env, timeout: 10000 });
      assert(!readdirSync(workspace).includes("network-attempted"), "Network attempted");
      return result;
    };
    for (const layout of ["completed-init", "legacy"] as const) {
      const source = join(workspace, `${layout}-source`);
      const backup = join(workspace, `${layout}-backup`);
      const restored = join(workspace, `${layout}-restored`);
      const { address } = initVault(source, 321);
      // Construct only a disposable legacy-format fixture, never migrate a vault.
      if (layout === "legacy") rmSync(join(source, ".init"), { recursive: true });
      const policy = { maxSatsPerTx: 321, maxSatsPerDay: 654, maxSatsLifetime: 987,
        allowlist: [address], extension: { preserve: "opaque owner configuration" } };
      // Owner-style replacement ensures staged initial policy differs from live.
      writeFileSync(join(source, "policy.next"), JSON.stringify(policy));
      renameSync(join(source, "policy.next"), join(source, "policy.json"));
      killVault(source);
      const now = new Date();
      writeFileSync(join(source, "spends.jsonl"), JSON.stringify({ t: now.toISOString(), amount: 17, asset: "bsv", kind: "send", txid: "fixture-only-not-a-chain-receipt" }) + "\n");
      // Real guard persistence, but NO signing/broadcast/payment. Simulated
      // post-reservation ambiguity deliberately leaves both evidence files.
      await assert.rejects(withPaymentGuard(source, "send", async guard => {
        guard.reserve({ asset: "bsv", amount: 23, to: address, fee: 1 });
        throw new Error("synthetic ambiguity; no payment attempted");
      }));
      // Opaque byte-preservation fixtures, not claims of valid lifecycle records.
      for (const directory of ["allowances", "bridge-records", ".owner-evidence"])
        mkdirSync(join(source, directory));
      for (const name of ["allowance.json", "allowances/fixture.json", "allowances/fixture.accounted.json",
        "bridge.json", "bridge.intent.json", "bridge.order.json", "bridge-records/fixture.json",
        "payment.bridge-parked.json", "brc181.json", ".owner-evidence/note"])
        writeFileSync(join(source, name), JSON.stringify({ fixture: true, preserved: name }));
      const expected = inventory(source);
      copyVerified(source, backup, expected);
      copyVerified(backup, restored, expected);
      for (const [name, hash] of Object.entries(expected)) {
        if (hash === "directory") continue;
        // Copy must not preserve source hardlink aliases, even inside .init.
        assert.equal(statSync(join(backup, name)).nlink, 1);
        assert.equal(statSync(join(restored, name)).nlink, 1);
        assert.notEqual(statSync(join(source, name)).ino, statSync(join(backup, name)).ino);
        assert.notEqual(statSync(join(backup, name)).ino, statSync(join(restored, name)).ino);
      }
      const original = readable(source), recovered = readable(restored);
      assert.equal(recovered.address, address);
      const message = Array.from(Buffer.from("Dogfood offline restore identity challenge; not a transaction"));
      assert(recovered.key.toPublicKey().verify(message, original.key.sign(message)));
      assert(original.key.toPublicKey().verify(message, recovered.key.sign(message)));
      assert.deepEqual(recovered.policy, original.policy);
      assert.equal(recovered.policy.killfileOn, true);
      assert.deepEqual(loadUsage(restored, now), loadUsage(source, now));
      assert.equal(loadUsage(restored, now).spentLifetime, 17);
      assert.equal(loadUsage(restored, now).spentToday, 17);
      const s = statusVault(restored);
      assert.equal(s.cap, 321); assert.equal(s.maxSatsPerDay, 654); assert.equal(s.maxSatsLifetime, 987);
      assert.deepEqual(s.allowlist, [address]);
      const decision = evaluateSend(recovered.policy, 1, address);
      assert(!decision.ok && decision.code === "KILL");
      assert.deepEqual(inspectPaymentHold(restored), inspectPaymentHold(source));
      assert.equal(inspectPaymentHold(restored).pending, "valid");
      const addr = child(restored, "address");
      assert.equal(addr.exitCode, 0); assert.equal(addr.stdout.toString().trim(), address);
      const status = child(restored, "status");
      assert.equal(status.exitCode, 0);
      for (const text of [address, "Cap: 321", "Lifetime: 987", "Killfile: on"])
        assert(status.stdout.toString().includes(text));
      const denied = child(restored, "send", address, "1");
      assert.notEqual(denied.exitCode, 0);
      assert(denied.stderr.toString().includes("payment is active or unresolved"));
      assert(!denied.stderr.toString().includes("NETWORK_FORBIDDEN"));
      assert.deepEqual(inventory(source), expected);
      assert.deepEqual(inventory(restored), expected); // Read/denial must not alter evidence.
      for (const target of [source, backup, restored]) {
        refuses(() => copyVerified(backup, target, expected));
        assert.deepEqual(inventory(target), expected);
      }
      const empty = join(workspace, `${layout}-existing-empty`);
      mkdirSync(empty);
      refuses(() => copyVerified(backup, empty, expected));
      assert.deepEqual(readdirSync(empty), []);
      // Inventory is an in-memory trusted baseline, not an authenticated archive.
      // Every missing file/directory and changed byte is detected before restore.
      for (const [name, hash] of Object.entries(expected)) {
        if (!name || hash === "directory") continue;
        const file = join(backup, name), bytes = readFileSync(file);
        unlinkSync(file);
        refuses(() => copyVerified(backup, join(workspace, "must-not-exist"), expected));
        writeFileSync(file, bytes);
      }
      writeFileSync(join(backup, "wif.enc"), "corrupt-fixture");
      refuses(() => copyVerified(backup, join(workspace, "must-not-exist"), expected));
      refuses(() => copyVerified(backup, join(workspace, "must-not-exist"), inventory(backup)));
      assert.deepEqual(inventory(source), expected); // Deliberate backup damage cannot alias source.
      assert.deepEqual(inventory(restored), expected);
      assert(!readdirSync(workspace).includes("must-not-exist"));
    }
    const interrupted = join(workspace, "interrupted-source");
    initVault(interrupted);
    unlinkSync(join(interrupted, ".init", "complete")); // Synthetic interrupted fixture only.
    const blocked = inventory(interrupted);
    const evidence = join(workspace, "interrupted-backup"), restored = join(workspace, "interrupted-restored");
    copyVerified(interrupted, evidence, blocked, false);
    copyVerified(evidence, restored, blocked, false);
    refuses(() => readable(restored));
    refuses(() => initVault(restored));
    const denied = child(restored, "address");
    assert.notEqual(denied.exitCode, 0);
    assert(denied.stderr.toString().includes("initialization incomplete"));
    assert.deepEqual(inventory(restored), blocked);
    return {
      offline: true, funded: false, layouts: ["completed-init", "legacy"],
      identicalBytes: true, independentFiles: true, sameSigningIdentity: true,
      capsAllowlistKillUsagePreserved: true, ambiguousHoldPreserved: true,
      opaqueRecoveryRecordsPreserved: true, cliAddressStatusDenial: true,
      interruptedInitBlocked: true, corruptIncompleteRejected: true,
      existingTargetsPreserved: true, fixturesRemoved: true,
    };
  } finally {
    // Only the newly claimed private fixture workspace, never the parent.
    rmSync(workspace, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== "--offline-fixture-only" || args[1] !== "--scratch-parent") {
  console.error("Usage: bun scripts/backup-rehearsal.ts --offline-fixture-only --scratch-parent <absolute-private-scratch-directory>");
  process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(await rehearse(args[2]), null, 2)); }
  catch {
    // Never print key material, raw child output, crypto errors, or file contents.
    console.error("Offline fixture rehearsal failed; no real vault was selected. Check scratch access and run the repository tests.");
    process.exitCode = 1;
  }
}
