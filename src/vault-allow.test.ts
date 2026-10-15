import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { allowDestination, initVault, killVault, loadVault, vaultPaths } from "./vault";

function fixture(run: (root: string, address: string, policy: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "dogfood-allow-"));
  try {
    const { address } = initVault(root);
    run(root, address, vaultPaths(root).policy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function richPolicy(allowlist: string[]) {
  return {
    maxSatsPerTx: 1234, maxSatsPerDay: 5678, maxSatsLifetime: 9012, allowlist,
    evm: { usdc: { maxPerTx: 101, maxPerDay: null, maxLifetime: 303, allowlist: [] }, future: { rules: [false, null, { deny: true }] } },
    solana: { usdc: { maxPerTx: 404, maxPerDay: 505, maxLifetime: null, allowlist: ["fixture-only"] } },
    bridge: { maxSatsPerSwap: 606, maxSatsPerDay: 707, future: { routes: [] } },
    extension: { allowlist: ["not BSV"], nested: [{ text: 'braces } ] , "allowlist": [', flags: [null, false, 0] }] },
    killfileOn: "persisted extension, not the actual killfile",
  };
}

const OTHER = "1GjcRUKdwqsnrxCHiDoHtF57rKqDd8oibT";

describe("BSV allow policy preservation", () => {
  test("adds only the BSV destination, retaining nested pockets, extensions, caps and killfile", () => fixture((root, address, path) => {
    const original = richPolicy([OTHER]);
    writeFileSync(path, JSON.stringify(original));
    killVault(root);
    const policyBefore = loadVault(root).policy;
    expect(allowDestination(root, address)).toEqual([OTHER, address]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...original, allowlist: [OTHER, address] });
    expect(loadVault(root).policy).toEqual({ ...policyBefore, allowlist: [OTHER, address] });
    expect(existsSync(vaultPaths(root).kill)).toBe(true);
  }));

  test("leaves unrelated JSON bytes (including large numbers and escaped keys) untouched", () => fixture((root, address, path) => {
    const prefix = '{ "future": {"n":900719925474099312345,"fraction":1.2300,"allowlist":[null]}, "\\u0061llowlist" : ';
    const suffix = ', "__proto__":{"retain":true}, "empty":{}, "maxSatsPerDay":null }\n';
    writeFileSync(path, prefix + '[]' + suffix);
    allowDestination(root, address);
    expect(readFileSync(path, "utf8")).toBe(prefix + JSON.stringify([address]) + suffix);
  }));

  test("duplicate addition is a byte-for-byte no-op, retaining existing order and duplicates", () => fixture((root, address, path) => {
    const raw = JSON.stringify(richPolicy([OTHER, address, OTHER]), null, 4) + "\n\n";
    writeFileSync(path, raw);
    const before = statSync(path);
    expect(allowDestination(root, address)).toEqual([OTHER, address, OTHER]);
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
  }));

  for (const legacy of [{}, { allowlist: null }]) {
    test(`legacy ${JSON.stringify(legacy)} is unrestricted until allow narrows it without adding defaults`, () => fixture((root, address, path) => {
      writeFileSync(path, JSON.stringify(legacy));
      expect(loadVault(root).policy.allowlist).toBeNull();
      expect(allowDestination(root, address)).toEqual([address]);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ allowlist: [address] });
      expect(loadVault(root).policy.allowlist).toEqual([address]);
    }));
  }

  test("missing legacy policy remains readable but allow refuses to recreate it", () => fixture((root, address, path) => {
    rmSync(path);
    expect(loadVault(root).policy.allowlist).toBeNull();
    expect(loadVault(root).policy.maxSatsPerTx).toBe(10000);
    expect(() => allowDestination(root, address)).toThrow();
    expect(existsSync(path)).toBe(false);
  }));

  test("new vault remains deny-all until explicitly allowed", () => fixture((root, address, path) => {
    expect(loadVault(root).policy.allowlist).toEqual([]);
    const original = JSON.parse(readFileSync(path, "utf8"));
    allowDestination(root, address);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...original, allowlist: [address] });
  }));

  for (const raw of ["{broken", "", "null", "[]", '[{"allowlist":[]}]', '"text"', "42", "true"]) {
    test(`invalid policy root ${JSON.stringify(raw)} fails closed without mutation`, () => fixture((root, address, path) => {
      writeFileSync(path, raw);
      const files = readdirSync(root);
      let failed = false;
      try { allowDestination(root, address); } catch { failed = true; }
      expect(readFileSync(path, "utf8")).toBe(raw);
      expect(failed).toBe(true);
      expect(() => loadVault(root)).toThrow();
      expect(readdirSync(root)).toEqual(files);
    }));
  }

  for (const allowlist of [false, 42, "any", {}, [OTHER, null], [42]]) {
    test(`malformed BSV allowlist ${JSON.stringify(allowlist)} is not normalized by allow`, () => fixture((root, address, path) => {
      const raw = JSON.stringify({ allowlist, extension: { retained: true } });
      writeFileSync(path, raw);
      let failed = false;
      try { allowDestination(root, address); } catch { failed = true; }
      expect(readFileSync(path, "utf8")).toBe(raw);
      expect(failed).toBe(true);
    }));
  }

  test("unreadable policy path is not replaced", () => fixture((root, address, path) => {
    rmSync(path);
    mkdirSync(path);
    expect(() => allowDestination(root, address)).toThrow();
    expect(() => loadVault(root)).toThrow();
    expect(statSync(path).isDirectory()).toBe(true);
    expect(readdirSync(path)).toEqual([]);
  }));

  test("ambiguous duplicate BSV allowlist keys fail without mutation", () => fixture((root, address, path) => {
    const raw = '{"allowlist":[], "\\u0061llowlist":null}';
    writeFileSync(path, raw);
    expect(() => allowDestination(root, address)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(raw);
  }));

  test("invalid destination cannot change policy", () => fixture((root, _address, path) => {
    const raw = readFileSync(path, "utf8");
    expect(() => allowDestination(root, "invalid")).toThrow(/P2PKH/);
    expect(readFileSync(path, "utf8")).toBe(raw);
  }));

  test("real CLI allow preserves multichain policy and is idempotent in a disposable vault", () => fixture((root, address, path) => {
    const run = () => Bun.spawnSync([process.execPath, resolve(import.meta.dir, "cli.ts"), "allow", address], {
      cwd: tmpdir(), env: { ...process.env, DOGFOOD_WALLET_DIR: root },
    });
    const original = richPolicy([OTHER]);
    writeFileSync(path, JSON.stringify(original));
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(`Allowlist: ${OTHER}, ${address}`);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...original, allowlist: [OTHER, address] });
    const saved = readFileSync(path, "utf8");
    expect(run().exitCode).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(saved);
  }), 15000);

  test("real CLI allow refuses corrupt policy without mutation", () => fixture((root, address, path) => {
    const corrupt = '{"allowlist":[], BROKEN';
    writeFileSync(path, corrupt);
    const failed = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "cli.ts"), "allow", address], {
      cwd: tmpdir(), env: { ...process.env, DOGFOOD_WALLET_DIR: root },
    });
    expect(failed.exitCode).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe(corrupt);
    expect(failed.stdout.toString()).not.toContain("Allowlist:");
  }), 15000);
});
