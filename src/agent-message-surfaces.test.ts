// agent-message-surfaces.test.ts — S7: CLI message-decrypt + MCP message_decrypt
// wiring smoke. Zero network: MCP happy path stubs global fetch; CLI paths
// exercise gates that fire before any fetch (usage / bad txid / killfile).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { P2PKH, PrivateKey, Script, Transaction, UnlockingScript } from "@bsv/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./mcp";
import { initVault, loadVault, killVault } from "./vault";
import { buildMessageScript, type Envelope } from "./agent-message";
import { encryptMessageBody } from "./agent-message-crypto";

const ONE = new PrivateKey(1);
const NONCE = "000102030405060708090a0b0c0d0e0f";
const TS = 1763000000;
const scratch = () => mkdtempSync(join(tmpdir(), "dogfood-surfaces-"));

function unsignedTx(outputs: { satoshis: number; lockingScript: Script }[]): Transaction {
  const tx = new Transaction();
  tx.addInput({ sourceTXID: "ab".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  for (const o of outputs) tx.addOutput(o);
  return tx;
}
function encTxFor(v: { address: string; key: PrivateKey }, plaintext: string): Transaction {
  const enc = encryptMessageBody(ONE, v.key.toPublicKey().toString(), plaintext);
  const env: Envelope = { v: 1, app: "dogfood", type: "message", from: ONE.toAddress().toString(), to: v.address, nonce: NONCE, ts: TS, enc: "brc78", body: enc.ciphertextB64 };
  return unsignedTx([
    { satoshis: 546, lockingScript: new P2PKH().lock(v.address) },
    { satoshis: 0, lockingScript: Script.fromHex(buildMessageScript(ONE, env)) },
    { satoshis: 1000, lockingScript: new P2PKH().lock(ONE.toAddress()) },
  ]);
}
function wocFetch(txs: Transaction[]): typeof fetch {
  const hexes = new Map(txs.map(t => [t.id("hex"), t.toHex()]));
  return (async (input: RequestInfo | URL) => {
    const m = new URL(String(input)).pathname.match(/\/tx\/([a-f0-9]{64})\/hex$/);
    if (m) { const hex = hexes.get(m[1]!); return hex ? new Response(hex) : new Response("not found", { status: 404 }); }
    return new Response("unexpected url", { status: 404 });
  }) as typeof fetch;
}
function parseTool(result: any): any {
  const c = result.content as { type: string; text: string }[];
  return JSON.parse(c[0]!.text);
}
async function withClient(root: string, fn: (client: Client) => Promise<void>) {
  const server = createServer(root), client = new Client({ name: "s7-surfaces", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try { await fn(client); } finally { await client.close(); await server.close(); }
}
function runCli(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, DOGFOOD_WALLET_DIR: root },
    stdout: "pipe", stderr: "pipe",
  });
  return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(([stdout, stderr, exit]) => ({ stdout, stderr, exit }));
}

describe("S7 MCP message_decrypt surface", () => {
  test("message_decrypt is discoverable; agent_message exposes encryptTo/expiryHeight", async () => {
    const root = scratch();
    try {
      await withClient(root, async (client) => {
        const tools = (await client.listTools()).tools;
        const dec = tools.find(t => t.name === "message_decrypt");
        expect(dec).toBeTruthy();
        const send = tools.find(t => t.name === "agent_message");
        expect(send).toBeTruthy();
        const props = (send!.inputSchema as any).properties ?? {};
        expect(props.encryptTo).toBeTruthy();
        expect(props.expiryHeight).toBeTruthy();
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("decrypts an addressed encrypted message through the tool (stubbed WoC)", async () => {
    const root = scratch();
    const realFetch = globalThis.fetch;
    try {
      initVault(root);
      const v = loadVault(root);
      const tx = encTxFor(v, "secret terms");
      globalThis.fetch = wocFetch([tx]);
      await withClient(root, async (client) => {
        const r = await client.callTool({ name: "message_decrypt", arguments: { txid: tx.id("hex") } });
        expect(r.isError).toBeFalsy();
        const body = parseTool(r);
        expect(body.ok).toBe(true);
        expect(body.body).toBe("secret terms");
        expect(body.to).toBe(v.address);
      });
    } finally { globalThis.fetch = realFetch; rmSync(root, { recursive: true, force: true }); }
  });

  test("killfile denies through the tool before any network", async () => {
    const root = scratch();
    try {
      initVault(root);
      killVault(root);
      await withClient(root, async (client) => {
        const r = await client.callTool({ name: "message_decrypt", arguments: { txid: "ab".repeat(32) } });
        expect(r.isError).toBe(true);
        expect(parseTool(r).code).toBe("KILL");
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a second decrypt through the tool is rejected REPLAY", async () => {
    const root = scratch();
    const realFetch = globalThis.fetch;
    try {
      initVault(root);
      const v = loadVault(root);
      const tx = encTxFor(v, "once");
      globalThis.fetch = wocFetch([tx]);
      await withClient(root, async (client) => {
        const first = await client.callTool({ name: "message_decrypt", arguments: { txid: tx.id("hex") } });
        expect(parseTool(first).ok).toBe(true);
        const second = await client.callTool({ name: "message_decrypt", arguments: { txid: tx.id("hex") } });
        expect(second.isError).toBe(true);
        expect(parseTool(second).code).toBe("REPLAY");
      });
    } finally { globalThis.fetch = realFetch; rmSync(root, { recursive: true, force: true }); }
  });
});

describe("S7 CLI message-decrypt surface", () => {
  test("usage without a txid exits 1", async () => {
    const root = scratch();
    try {
      const { exit, stderr } = await runCli(root, ["message-decrypt"]);
      expect(exit).toBe(1);
      expect(stderr).toContain("Usage");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a malformed txid exits 1 before any network", async () => {
    const root = scratch();
    try {
      const { exit, stderr } = await runCli(root, ["message-decrypt", "nothex"]);
      expect(exit).toBe(1);
      expect(stderr).toContain("txid");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("killfile exits 1 before any network", async () => {
    const root = scratch();
    try {
      initVault(root);
      killVault(root);
      const { exit, stderr } = await runCli(root, ["message-decrypt", "ab".repeat(32)]);
      expect(exit).toBe(1);
      expect(stderr).toContain("STOP_SPENDING");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
