import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault, loadVault, killVault, vaultPaths } from "./vault";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "dogfood-wallet-"));
}

describe("vault", () => {
  test("init writes address but never writes a plaintext WIF", () => {
    const root = scratch();
    try {
      const { address } = initVault(root);
      expect(address).toMatch(/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/);
      const paths = vaultPaths(root);
      expect(existsSync(paths.enc)).toBe(true);
      expect(existsSync(paths.wrap)).toBe(true);
      expect(existsSync(paths.address)).toBe(true);
      const enc = readFileSync(paths.enc, "utf8");
      expect(enc).not.toMatch(/^[5KL][1-9A-HJ-NP-Za-km-z]{50,}$/);
      expect(readFileSync(paths.address, "utf8")).not.toMatch(/[5KL][1-9A-HJ-NP-Za-km-z]{50,}/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite an existing vault", () => {
    const root = scratch();
    try {
      initVault(root);
      expect(() => initVault(root)).toThrow(/already initialized/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadVault decrypts to the same address as address.txt", () => {
    const root = scratch();
    try {
      const { address } = initVault(root);
      const loaded = loadVault(root);
      expect(loaded.address).toBe(address);
      expect(loaded.policy.maxSatsPerTx).toBe(10_000);
      expect(loaded.policy.killfileOn).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("kill turns the killfile on", () => {
    const root = scratch();
    try {
      initVault(root);
      killVault(root);
      expect(loadVault(root).policy.killfileOn).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
