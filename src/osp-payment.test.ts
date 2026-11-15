import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transaction } from "@bsv/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./mcp";
import { fileRequest } from "./requests";
import { signOspGrant } from "./osp";
import { jcs, scopePayment } from "./osp-scope";
import { mockFetch } from "./test-support/fetch";

const p2pkh = "76a914" + "ab".repeat(20) + "88ac";
const scope = (script: string) => jcs({ payment: { amount_sats: 10, script }, salt: "ab".repeat(16) });
const invalidScripts = [
  ["odd hex", "a"],
  ["truncated push", "4c"],
  ["truncated P2PKH", p2pkh.slice(0, -2)],
  ["long hash", "76a914" + "ab".repeat(21) + "88ac"],
  ["trailing opcode", p2pkh + "51"],
  ["nonminimal hash push", "76a94c14" + "ab".repeat(20) + "88ac"],
  ["P2SH", "a914" + "ab".repeat(20) + "87"],
  ["anyone can spend", "51"],
  ["OP_RETURN", "006a"],
  ["OSP envelope candidate", "006a034f5350"],
  ["uppercase", p2pkh.toUpperCase()],
  ["trailing newline", p2pkh + "\n"],
  ["nonhex", "zz"],
  ["empty", ""],
];

describe("wallet OSP payment script policy", () => {
  test("canonical P2PKH payment is unchanged; absent payment remains unpaid", () => {
    expect(scopePayment({})).toBeUndefined();
    expect(scopePayment({ payment: { amount_sats: 10, script: p2pkh } })).toEqual({ amount_sats: 10, script: p2pkh });
  });
  for (const [label, script] of invalidScripts) {
    test(`raw request rejects ${label} before persistence`, () => {
      const root = mkdtempSync(join(tmpdir(), "osp-payment-"));
      try {
        expect(() => fileRequest(root, { kind: "osp-grant", door: "bench", scopeCanonical: scope(script!) })).toThrow(/payment.*P2PKH/);
        expect(readdirSync(root)).toEqual([]);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
    test(`signer rejects ${label} before vault access, signing or network`, async () => {
      // No vault/key exists: a payment-specific rejection proves validation precedes loadVault.
      const root = mkdtempSync(join(tmpdir(), "osp-payment-"));
      let network = 0;
      const signing = spyOn(Transaction.prototype, "sign").mockImplementation(async () => { throw Error("SIGN_FORBIDDEN"); });
      try {
        await expect(signOspGrant({ root, door: "bench", scopeCanonical: scope(script!), fetchFn: mockFetch(async () => { network++; throw Error("NETWORK_FORBIDDEN"); }) })).rejects.toThrow(/payment.*P2PKH/);
        expect(signing).not.toHaveBeenCalled();
        expect(network).toBe(0);
        expect(readdirSync(root)).toEqual([]);
      } finally { signing.mockRestore(); rmSync(root, { recursive: true, force: true }); }
    });
  }
  test("MCP raw scope refuses envelope payment and describes actual supported wire fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "osp-payment-mcp-"));
    const server = createServer(root);
    const client = new Client({ name: "osp-payment-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const result = await client.callTool({ name: "request_osp_grant", arguments: { door: "bench", scopeCanonical: scope("006a034f5350") } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/payment.*P2PKH/);
      expect(readdirSync(root)).toEqual([]);
      const tool = (await client.listTools()).tools.find(t => t.name === "request_osp_grant")!;
      expect(tool.description).toContain("{amount_sats,script}");
      expect(tool.description).toContain("P2PKH");
      const valid = await client.callTool({ name: "request_osp_grant", arguments: { door: "bench", scopeCanonical: scope(p2pkh) } });
      expect(valid.isError).toBe(false);
    } finally { await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
