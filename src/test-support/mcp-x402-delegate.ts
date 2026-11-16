// Isolated subprocess: real MCP/delegate/vault, synthetic nonce, no outbound fetch.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { P2PKH, PrivateKey, Script, Transaction } from "@bsv/sdk";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "../mcp";
import { initVault, vaultPaths } from "../vault";
import { canonicalJson, toBase64Url, type X402Challenge } from "../x402";
import { mockFetch } from "./fetch";

const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "dogfood-mcp-delegate-"));
const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../testdata/x402-vectors-v1.json"), "utf8"),
) as { vectors: Array<{ name: string; challenge?: X402Challenge }> };
const base = vectors.vectors.find(v => v.name === "valid_get_empty")!.challenge!;

const payeeKey = PrivateKey.fromHex("3".padStart(64, "0"));
const payeeAddress = payeeKey.toAddress().toString();
const payeeLock = new P2PKH().lock(payeeAddress).toHex();
const nonceKey = PrivateKey.fromHex("4".padStart(64, "0"));
const nonceLock = new P2PKH().lock(nonceKey.toAddress()).toHex();
const nonceSource = new Transaction();
nonceSource.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(nonceKey.toAddress()) });
const nonceId = nonceSource.id("hex");

// Gateway-style template: nonce input pre-signed SIGHASH_SINGLE|FORKID|ANYONECANPAY,
// payee output first. The fixture delegator returns it unchanged (sponsor covers fee).
const completed = new Transaction();
completed.addInput({
  sourceTransaction: nonceSource,
  sourceTXID: nonceId,
  sourceOutputIndex: 0,
  unlockingScriptTemplate: new P2PKH().unlock(nonceKey, "single", true),
  sequence: 0xffffffff,
});
completed.addOutput({ satoshis: base.amount_sats, lockingScript: Script.fromHex(payeeLock) });
await completed.sign();
const completedHex = completed.toHex();
const completedId = completed.id("hex");

const challenge: X402Challenge = {
  ...base,
  payee_locking_script_hex: payeeLock,
  nonce_utxo: { txid: nonceId, vout: 0, satoshis: 1000, locking_script_hex: nonceLock },
  template: { rawtx_hex: completedHex, price_sats: base.amount_sats },
};

initVault(root); // Only this disposable, unfunded fixture vault is ever opened.
writeFileSync(vaultPaths(root).policy, JSON.stringify({
  maxSatsPerTx: 10_000, maxSatsPerDay: 50_000, maxSatsLifetime: null, allowlist: [payeeAddress],
}));
process.env.DOGFOOD_X402_DELEGATOR_URL = "http://delegator.fixture";
globalThis.fetch = mockFetch(async input => {
  const target = String(input);
  if (target === "http://delegator.fixture/delegate/x402") {
    return new Response(JSON.stringify({ completed_tx: completedHex, txid: completedId }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  if (target.endsWith(`/tx/${nonceId}/hex`)) return new Response(nonceSource.toHex(), { status: 200 });
  throw new Error(`Unexpected outbound fetch in offline delegate test: ${target}`);
});

const server = createServer(root);
const client = new Client({ name: "delegate-shape-test", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
const result = await client.callTool({
  name: "x402_delegate",
  arguments: { challenge: toBase64Url(canonicalJson(challenge)), method: "GET", path: "/v1/resource", broadcast: false },
});
console.log(JSON.stringify(result));
await client.close();
await server.close();
