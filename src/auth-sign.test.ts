import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BSM, PrivateKey, Utils } from "@bsv/sdk";
import {
  AUTH_PREFIX,
  MAX_AUTH_MESSAGE_BYTES,
  canonicalAuthMessage,
  signAuthMessage,
  signVaultAuth,
  verifyAuthMessage,
} from "./auth-sign";
import { initVault, killVault, loadVault, vaultPaths } from "./vault";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./mcp";

const ONE = PrivateKey.fromString("1".padStart(64, "0"), 16);
const VECTOR = {
  address: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  pubkey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  message: "dogfood-auth-vector-v1",
  signature:
    "H00A6WKvUCs3DEFxvtgM7WiOD4BaHJ/hZjLyh/pacGzzLIi2k8LkKRH+BSfC+H7tlZGgQBdeKKjolsKfsmGIuaU=",
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dogfood-auth-"));
}

describe("auth-sign", () => {
  test("frozen vector: privkey=1 signs deterministically and verifies", () => {
    const signed = signAuthMessage(ONE, VECTOR.message);
    expect(signed).toEqual(VECTOR);
    const out = verifyAuthMessage(signed);
    expect(out.address).toBe(VECTOR.address);
    expect(out.pubkey).toBe(VECTOR.pubkey);
  });

  test("canonical message carries the auth domain prefix", () => {
    expect(canonicalAuthMessage("abc")).toBe(AUTH_PREFIX + "abc");
    expect(AUTH_PREFIX).toBe("Dogfood Auth v1\n");
  });

  test("verify recovers the signer pubkey from the compact signature", () => {
    const signed = signAuthMessage(ONE, "challenge-nonce-0123456789abcdef");
    const out = verifyAuthMessage({
      address: signed.address,
      message: signed.message,
      signature: signed.signature,
    });
    expect(out.pubkey).toBe(VECTOR.pubkey);
  });

  test("rejects a tampered message", () => {
    expect(() =>
      verifyAuthMessage({ address: VECTOR.address, message: VECTOR.message + "x", signature: VECTOR.signature }),
    ).toThrow(/Invalid auth/);
  });

  test("rejects the wrong address", () => {
    const other = PrivateKey.fromString("2".padStart(64, "0"), 16);
    expect(() =>
      verifyAuthMessage({ address: other.toAddress(), message: VECTOR.message, signature: VECTOR.signature }),
    ).toThrow(/Invalid auth/);
  });

  test("rejects a foreign-domain signature (Locus signed write)", () => {
    const msg = "Locus Signed Write\n" + JSON.stringify({ a: 1 });
    const sig = BSM.sign(Utils.toArray(msg, "utf8"), ONE, "base64") as string;
    expect(() =>
      verifyAuthMessage({ address: VECTOR.address, message: msg, signature: sig }),
    ).toThrow(/Invalid auth/);
  });

  test("rejects an attestation-domain signature", () => {
    const msg = "Dogfood Attestation v1\n" + JSON.stringify({ a: 1 });
    const sig = BSM.sign(Utils.toArray(msg, "utf8"), ONE, "base64") as string;
    expect(() =>
      verifyAuthMessage({ address: VECTOR.address, message: msg, signature: sig }),
    ).toThrow(/Invalid auth/);
  });

  test("message validation: empty, control chars, lone surrogates, oversize", () => {
    for (const bad of ["", "a\nb", "a\x00b", "lone‑surrogate‑\uD800here", "x".repeat(MAX_AUTH_MESSAGE_BYTES + 1)]) {
      expect(() => signAuthMessage(ONE, bad)).toThrow(/Invalid auth/);
      expect(() =>
        verifyAuthMessage({ address: VECTOR.address, message: bad, signature: VECTOR.signature }),
      ).toThrow(/Invalid auth/);
    }
    // exactly at the cap is fine
    const atCap = signAuthMessage(ONE, "x".repeat(MAX_AUTH_MESSAGE_BYTES));
    expect(verifyAuthMessage(atCap).address).toBe(VECTOR.address);
  });

  test("address validation: testnet and script-hash versions rejected", () => {
    const decoded = Utils.fromBase58Check(VECTOR.address);
    const testnet = Utils.toBase58Check(decoded.data as number[], [0x6f]);
    const script = Utils.toBase58Check(decoded.data as number[], [0x05]);
    for (const bad of [testnet, script, "not-an-address", "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMZ"]) {
      expect(() =>
        verifyAuthMessage({ address: bad, message: VECTOR.message, signature: VECTOR.signature }),
      ).toThrow(/Invalid auth/);
    }
  });

  test("signature encoding: bad base64, wrong length, header outside 31..34", () => {
    const raw = Buffer.from(VECTOR.signature, "base64");
    const badHeader = Buffer.concat([Buffer.from([30]), raw.subarray(1)]).toString("base64");
    const short = raw.subarray(0, 64).toString("base64");
    for (const bad of ["!!!", short, badHeader, raw.toString("base64") + "AA"]) {
      expect(() =>
        verifyAuthMessage({ address: VECTOR.address, message: VECTOR.message, signature: bad }),
      ).toThrow(/Invalid auth/);
    }
  });

  test("rejects extra or missing fields", () => {
    expect(() =>
      verifyAuthMessage({ ...VECTOR, extra: 1 }),
    ).toThrow(/Invalid auth/);
    expect(() =>
      verifyAuthMessage({ address: VECTOR.address, message: VECTOR.message }),
    ).toThrow(/Invalid auth/);
  });

  test("vault: killfile blocks signing, not verifying", () => {
    const root = tmp();
    try {
      initVault(root);
      const before = signVaultAuth(root, "hello");
      expect(verifyAuthMessage(before).address).toBe(loadVault(root).address);
      killVault(root);
      expect(() => signVaultAuth(root, "hello")).toThrow(/KILLED/);
      // historical signatures still verify — verify is keyless
      expect(verifyAuthMessage(before).address).toBe(loadVault(root).address);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("signing never touches policy gates (no funds move): empty allowlist vault still signs", () => {
    const root = tmp();
    try {
      initVault(root); // fresh vault: empty allowlist denies every send
      const signed = signVaultAuth(root, "auth-is-not-spending");
      expect(verifyAuthMessage(signed).address).toBe(loadVault(root).address);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("auth-sign MCP surface", () => {
  test("auth_sign and auth_verify are exposed and work; killfile gates auth_sign", async () => {
    const root = tmp();
    initVault(root);
    const server = createServer(root);
    const client = new Client({ name: "auth-test", version: "1" });
    try {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      await client.connect(a);
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      expect(names).toContain("auth_sign");
      expect(names).toContain("auth_verify");

      const signed = await client.callTool({ name: "auth_sign", arguments: { message: "mcp-challenge" } });
      expect(signed.isError).toBeFalsy();
      const payload = JSON.parse((signed.content as { type: string; text: string }[])[0]!.text);
      expect(payload.address).toBe(loadVault(root).address);

      const verified = await client.callTool({
        name: "auth_verify",
        arguments: { address: payload.address, message: "mcp-challenge", signature: payload.signature },
      });
      expect(verified.isError).toBeFalsy();
      expect((verified.content as { type: string; text: string }[])[0]!.text).toContain(payload.address);

      const bad = await client.callTool({
        name: "auth_verify",
        arguments: { address: payload.address, message: "tampered", signature: payload.signature },
      });
      expect(bad.isError).toBe(true);

      writeFileSync(vaultPaths(root).kill, "killed\n");
      const killed = await client.callTool({ name: "auth_sign", arguments: { message: "mcp-challenge" } });
      expect(killed.isError).toBe(true);
      expect((killed.content as { type: string; text: string }[])[0]!.text).toMatch(/KILLED/);
    } finally {
      await client.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("auth-sign CLI", () => {
  const cli = new URL("./cli.ts", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");
  function childEnv(root: string) {
    return {
      PATH: process.env.PATH!,
      SystemRoot: process.env.SystemRoot!,
      TEMP: tmpdir(),
      TMP: tmpdir(),
      TMPDIR: tmpdir(),
      DOGFOOD_WALLET_DIR: root,
    };
  }
  function run(root: string, args: string[]) {
    return Bun.spawnSync([process.execPath, cli, ...args], {
      env: childEnv(root),
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("sign-auth | verify-auth roundtrip; killfile gates sign-auth", () => {
    const root = tmp();
    try {
      initVault(root);
      const sign = run(root, ["sign-auth", "cli-challenge"]);
      expect(sign.exitCode).toBe(0);
      const payload = JSON.parse(sign.stdout.toString());
      expect(payload.address).toBe(loadVault(root).address);

      const verify = run(root, ["verify-auth", payload.address, "cli-challenge", payload.signature]);
      expect(verify.exitCode).toBe(0);
      const out = JSON.parse(verify.stdout.toString());
      expect(out.valid).toBe(true);
      expect(out.address).toBe(payload.address);

      const bad = run(root, ["verify-auth", payload.address, "tampered", payload.signature]);
      expect(bad.exitCode).not.toBe(0);

      writeFileSync(vaultPaths(root).kill, "killed\n");
      const killed = run(root, ["sign-auth", "cli-challenge"]);
      expect(killed.exitCode).not.toBe(0);
      expect(killed.stderr.toString()).toMatch(/KILLED/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
