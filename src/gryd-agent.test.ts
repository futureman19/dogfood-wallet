import { describe, expect, test } from "bun:test";
import { BSM, PrivateKey, PublicKey, Signature, Utils } from "@bsv/sdk";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vectors from "../testdata/gryd-agent-vectors.json";
import { canonicalSignedWriteMessage, signAgentRequest, signVaultAgentRequest, AGENT_WRITE_ACTIONS, type SignedWriteEnvelope } from "./gryd-agent";
import { initVault, killVault } from "./vault";
const key = PrivateKey.fromHex("1".padStart(64, "0"));
const request = { method: "POST" as const, path: "/api/v1/agents/mine" };
function validSignature(result: ReturnType<typeof signAgentRequest>) {
  return BSM.verify(Utils.toArray(canonicalSignedWriteMessage(result.payload), "utf8"), Signature.fromCompact(result.signature, "base64"), PublicKey.fromString(result.pubkey));
}

describe("Gryd signed-write interoperability", () => {
  test("action union matches frozen canonical protocol agent subset", () => {
    expect(vectors.agentActions).toEqual([...AGENT_WRITE_ACTIONS]);
  });
  for (const vector of vectors.vectors) test(`protocol bytes and compact BSM signature: ${vector.payload.action}`, () => {
    const payload = vector.payload as SignedWriteEnvelope;
    expect(canonicalSignedWriteMessage(payload)).toBe(vector.message);
    expect(Buffer.from(canonicalSignedWriteMessage(payload)).toString("hex")).toBe(vector.utf8Hex);
    const result = signAgentRequest(payload.action, payload.body, payload, key, payload);
    expect(result).toEqual({ payload, signature: vector.signature, pubkey: vector.pubkey, address: vector.address });
    expect(validSignature(result)).toBe(true);
    expect(validSignature({ ...result, payload: { ...payload, path: payload.path + "/other" } })).toBe(false);
    expect(validSignature({ ...result, payload: { ...payload, body: { changed: true } } })).toBe(false);
    expect(validSignature({ ...result, payload: { ...payload, method: payload.method === "PUT" ? "POST" : "PUT" } })).toBe(false);
  });
  test("fresh UUIDs, seconds timestamp, omitted network, detached body", () => {
    const body = { nested: { value: 1 } };
    const before = Math.floor(Date.now() / 1000);
    const a = signAgentRequest("agent.mine", body, request, key);
    const b = signAgentRequest("agent.mine", body, request, key);
    expect(a.payload.nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.payload.nonce).not.toBe(b.payload.nonce);
    expect(a.payload.timestamp).toBeGreaterThanOrEqual(before);
    expect(a.payload.timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(Object.hasOwn(a.payload, "network")).toBe(false);
    body.nested.value = 2;
    expect(a.payload.body).toEqual({ nested: { value: 1 } });
    expect(validSignature(JSON.parse(JSON.stringify(a)))).toBe(true);
  });
  test("rejects invalid action, method, path and metadata", () => {
    for (const action of ["heartbeat.submit", "agent.", "agent.unknown", " agent.mine"]) {
      expect(() => signAgentRequest(action as never, {}, request, key)).toThrow();
    }
    for (const method of ["GET", "post", "PATCH"]) expect(() => signAgentRequest("agent.mine", {}, { ...request, method: method as never }, key)).toThrow();
    for (const path of ["", "https://example.com/api", "//example.com/api", " /api", "/api\n"]) expect(() => signAgentRequest("agent.mine", {}, { ...request, path }, key)).toThrow();
    for (const options of [{ timestamp: NaN }, { timestamp: -1 }, { timestamp: 1.5 }, { nonce: "" }, { network: "invalid" }]) {
      expect(() => signAgentRequest("agent.mine", {}, request, key, options as never)).toThrow();
    }
  });
  test("rejects non-JSON values rather than signing bytes that change on transport", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const body of [null, [], { a: undefined }, { a: NaN }, { a: Infinity }, { a: 1n }, { a: () => 1 }, { a: Symbol() }, { a: new Date() }, { a: [, 1] }, cyclic]) {
      expect(() => signAgentRequest("agent.mine", body as never, request, key)).toThrow();
    }
  });
});

describe("vault and human CLI boundary", () => {
  test("packaged CLI includes its signer and documents the offline command", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
    expect(pkg.files).toContain("src/gryd-agent.ts");
    const help = Bun.spawnSync([process.execPath, "src/cli.ts", "--help"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, DOGFOOD_WALLET_DIR: join(tmpdir(), "gryd-unused") } });
    expect(help.stdout.toString()).toContain("agent-call");
  });
  test("offline signing leaves disposable vault unchanged; killfile blocks signing", () => {
    const root = mkdtempSync(join(tmpdir(), "gryd-agent-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("Network forbidden"); }) as unknown as typeof fetch;
    try {
      const { address } = initVault(root);
      const snapshot = () => readdirSync(root).filter(n => n !== ".init").map(n => [n, readFileSync(join(root, n)).toString("hex")]);
      const before = snapshot();
      const result = signVaultAgentRequest(root, "agent.mine", {}, request);
      expect(result.address).toBe(address);
      expect(validSignature(result)).toBe(true);
      expect(snapshot()).toEqual(before);
      killVault(root);
      expect(() => signVaultAgentRequest(root, "agent.mine", {}, request)).toThrow("STOP_SPENDING");
    } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
  });
  test("CLI prints only signed JSON; malformed input fails; no MCP registration", () => {
    const root = mkdtempSync(join(tmpdir(), "gryd-agent-cli-"));
    try {
      initVault(root);
      const run = (args: string[]) => Bun.spawnSync([process.execPath, "src/cli.ts", "agent-call", ...args], { cwd: join(import.meta.dir, ".."), env: { ...process.env, DOGFOOD_WALLET_DIR: root } });
      const result = run(["agent.mine", "POST", "/api/v1/agents/mine", "{}"]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(validSignature(JSON.parse(result.stdout.toString()))).toBe(true);
      for (const args of [[], ["agent.mine", "POST", "/api", "not-json"], ["agent.mine", "POST", "/api", "{}", "extra"], ["agent.mine", "POST", "/api", "[]"]]) {
        const failed = run(args);
        expect(failed.exitCode).not.toBe(0);
        expect(failed.stdout.toString()).toBe("");
      }
      expect(readFileSync(join(import.meta.dir, "mcp.ts"), "utf8")).not.toMatch(/gryd-agent|agent-call|signVaultAgentRequest/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
