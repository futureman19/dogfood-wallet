import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import * as rootExport from "./index";

const repo = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

const VECTOR = {
  address: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  pubkey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  message: "dogfood-auth-vector-v1",
  signature:
    "H00A6WKvUCs3DEFxvtgM7WiOD4BaHJ/hZjLyh/pacGzzLIi2k8LkKRH+BSfC+H7tlZGgQBdeKKjolsKfsmGIuaU=",
};

describe("package library surface", () => {
  test("manifest exports map is exactly the curated surface", () => {
    expect(manifest.exports).toEqual({
      ".": "./src/index.ts",
      "./mcp": "./src/mcp.ts",
      "./package.json": "./package.json",
    });
    expect(manifest.files).toContain("src/index.ts");
  });

  test("root entry exposes exactly the curated keyless/agent-side API", () => {
    expect(Object.keys(rootExport).sort()).toEqual([
      "AUTH_PREFIX",
      "DOGFOOD_WALLET_VERSION",
      "MAX_AUTH_MESSAGE_BYTES",
      "MAX_PENDING_REQUESTS",
      "canonicalAuthMessage",
      "fileRequest",
      "listRequests",
      "signAuthMessage",
      "verifyAuthMessage",
    ]);
  });

  test("root entry has no payment, key-loading, or human-decision functions", () => {
    const banned = [
      "sendPayment", "sweepPayment", "splitPayment", "sendRaw",
      "loadVault", "initVault", "allowDestination", "updatePolicyCap",
      "approveRequest", "denyRequest", "signVaultAuth", "killVault",
    ];
    for (const name of banned) expect((rootExport as Record<string, unknown>)[name]).toBeUndefined();
  });

  test("keyless auth verify roundtrips through the root export", () => {
    expect(rootExport.verifyAuthMessage(VECTOR).pubkey).toBe(VECTOR.pubkey);
    const key = PrivateKey.fromString("1".padStart(64, "0"), 16);
    const signed = rootExport.signAuthMessage(key, "library-consumer");
    expect(rootExport.verifyAuthMessage(signed).address).toBe(VECTOR.address);
    expect(rootExport.DOGFOOD_WALLET_VERSION).toBe(manifest.version);
  });
});

describe("package self-reference resolution through the exports map", () => {
  function consumer(code: string) {
    return Bun.spawnSync([process.execPath, "-e", code], {
      cwd: repo,
      env: {
        PATH: process.env.PATH!,
        SystemRoot: process.env.SystemRoot!,
        TEMP: process.env.TEMP!,
        TMP: process.env.TMP!,
        TMPDIR: process.env.TMPDIR!,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("root and ./mcp resolve; deep internal paths are gated", () => {
    const ok = consumer(
      `const root = await import('@dogfood/wallet');
       if (typeof root.verifyAuthMessage !== 'function') throw new Error('root surface missing');
       const mcp = await import('@dogfood/wallet/mcp');
       if (typeof mcp.createServer !== 'function') throw new Error('createServer missing');
       console.log('RESOLVED');`,
    );
    expect(ok.stderr.toString()).toBe("");
    expect(ok.stdout.toString().trim()).toBe("RESOLVED");

    for (const deep of ["@dogfood/wallet/src/send", "@dogfood/wallet/vault", "@dogfood/wallet/send"]) {
      const gated = consumer(
        `try { await import('${deep}'); console.log('LEAK'); }
         catch { console.log('GATED'); }`,
      );
      expect(gated.stdout.toString().trim()).toBe("GATED");
    }
  }, 30000);
});
