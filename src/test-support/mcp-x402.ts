// Isolated subprocess: real MCP/rails/vault, synthetic funds, no outbound fetch.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrivateKey, P2PKH, Transaction } from "@bsv/sdk";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../mcp";
import { initVault, loadVault, vaultPaths } from "../vault";
import { USDC_BASE } from "../evm";
import { USDC_SOLANA } from "../solana";

const [rail, failure = "none"] = process.argv.slice(2);
const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "dogfood-mcp-x402-"));
const url = "https://fixture.invalid/fortune";
const bsvPayee = PrivateKey.fromHex("2".padStart(64, "0")).toAddress();
const basePayee = "0x" + "42".repeat(20);
const solPayee = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const asset = rail === "bsv" ? "bsv" : `usdc-${rail}`;
const events: string[] = [];
const payments: string[] = [];
const client = new Client({ name: "parity-test", version: "1" });
const server = createServer(root);
try {
  initVault(root); // Only this disposable, unfunded fixture vault is ever opened.
  const vault = loadVault(root);
  const paths = vaultPaths(root);
  const pocket = (payee: string) => {
    const selected = payee === (rail === "base" ? basePayee : rail === "solana" ? solPayee : "");
    return { maxPerTx: selected && failure === "cap" ? 499 : 1000, maxPerDay: selected || failure === "none" ? 1000 : 100000, maxLifetime: null, allowlist: selected && failure === "allowlist" ? [] : [payee] };
  };
  writeFileSync(paths.policy, JSON.stringify({ maxSatsPerTx: failure === "cap" ? 499 : 1000, maxSatsPerDay: 1000, maxSatsLifetime: null, allowlist: failure === "allowlist" ? [] : [bsvPayee], evm: { usdc: pocket(basePayee) }, solana: { usdc: pocket(solPayee) } }));
  if (failure === "kill") writeFileSync(paths.kill, "fixture");
  // Invalid signed policy must block BSV but must not block another currency.
  if (failure === "brc181" || rail !== "bsv") writeFileSync(paths.brc181, "invalid fixture");
  const seed = ["bsv", "usdc-base", "usdc-solana"].map(a => ({ t: new Date().toISOString(), kind: "send", asset: a, amount: a === asset ? (failure === "day" ? 600 : 100) : 9000 }));
  writeFileSync(paths.log, seed.map(r => JSON.stringify(r)).join("\n") + "\n");
  const source = new Transaction();
  source.addOutput({ satoshis: 2000, lockingScript: new P2PKH().lock(vault.address) });
  const sourceId = source.id("hex");
  const requirements = [
    { scheme: "bsv-direct", network: "bsv-main", satoshis: 500, payTo: bsvPayee },
    { scheme: "exact", network: "base", maxAmountRequired: "500", payTo: basePayee, asset: USDC_BASE },
    { scheme: "exact", network: "solana", maxAmountRequired: "500", payTo: solPayee, asset: USDC_SOLANA, extra: { feePayer: "CkTDQfii4biNwDuWGbLCBxaY2M9VLsDu3fMNvWEbZvTa" } },
  ].slice(rail === "bsv" ? 0 : rail === "base" ? 1 : 2);
  globalThis.fetch = (async (input, init) => {
    const target = String(input);
    if (target === url) {
      const headers = new Headers(init?.headers);
      const bsv = headers.get("X-BSV-PAYMENT");
      const usdc = headers.get("X-PAYMENT");
      if (!bsv && !usdc) { events.push("challenge"); return Response.json({ x402Version: 1, accepts: requirements }, { status: 402 }); }
      const selected = bsv ? "bsv" : JSON.parse(Buffer.from(usdc!, "base64").toString()).network;
      payments.push(selected);
      events.push("payment");
      const receipt = { success: failure !== "settle", network: bsv ? "bsv-main" : selected, transaction: bsv ? Transaction.fromHex(bsv).id("hex") : "fixture-settlement", error: "fixture refusal" };
      return new Response("fixture paid", { status: failure === "settle" ? 402 : 200, headers: { "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify(receipt)).toString("base64") } });
    }
    if (target === `https://api.whatsonchain.com/v1/bsv/main/address/${vault.address}/unspent`) {
      events.push("utxos");
      return Response.json(failure === "funding" ? [] : [{ tx_hash: sourceId, tx_pos: 0, value: 2000 }]);
    }
    if (target === `https://api.whatsonchain.com/v1/bsv/main/tx/${sourceId}/hex`) { events.push("source"); return new Response(source.toHex()); }
    if (JSON.parse(String(init?.body || "{}" )).method === "getLatestBlockhash") {
      events.push("blockhash");
      return Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { blockhash: "4uHCe4FhA1RqVhVPe7LBDhMvVKjCPyUKBiLfkPePbZZ7", lastValidBlockHeight: 100 } } });
    }
    throw new Error(`Unexpected network blocked: ${target}`);
  }) as typeof fetch;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "x402_pay", arguments: { url } });
  const body = JSON.parse((result.content as { text: string }[])[0].text);
  const rows = readFileSync(paths.log, "utf8").trim().split("\n").map(l => JSON.parse(l));
  console.log(JSON.stringify({ isError: result.isError, body, events, payments, rows: rows.slice(seed.length) }));
} finally {
  await client.close();
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
