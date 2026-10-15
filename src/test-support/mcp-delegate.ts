// Disposable real MCP boundary; every request is intercepted, including unexpected ones.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { P2PKH, PrivateKey, Transaction } from "@bsv/sdk";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../mcp";
import { initVault, loadVault, vaultPaths } from "../vault";
import { sendPayment } from "../send";
const [root, mode, action = "delegate"] = process.argv.slice(2);
if (!existsSync(vaultPaths(root).address)) initVault(root);
const vault = loadVault(root);
const key = PrivateKey.fromHex("2".padStart(64, "0"));
const lock = new P2PKH().lock(key.toAddress());
function source(value: number, own = false) { const t = new Transaction(); t.addOutput({ satoshis: value, lockingScript: own ? new P2PKH().lock(vault.address) : lock }); return t; }
const fund = source(mode === "exact" ? 100 : mode === "multi" ? 60 : 1000, true);
const secondFund = source(50, true);
const nonce = source(1, mode === "sponsored-own");
const fee = source(200);
const template = new Transaction();
template.addInput({ sourceTransaction: nonce, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(mode === "sponsored-own" ? vault.key : key, "single", true) });
template.addOutput({ satoshis: 100, lockingScript: lock });
await template.sign();
const vectors = JSON.parse(readFileSync(join(import.meta.dir, "../../testdata/x402-vectors-v1.json"), "utf8"));
const ch = { ...vectors.vectors.find((v: any) => v.name === "valid_get_empty").challenge, amount_sats: 100, payee_locking_script_hex: lock.toHex(), nonce_utxo: { txid: nonce.id("hex"), vout: 0 }, template: { rawtx_hex: template.toHex(), price_sats: 100 } };
const paths = vaultPaths(root);
if (!existsSync(join(root, "fixture.ready"))) {
  writeFileSync(paths.policy, JSON.stringify({ maxSatsPerTx: mode === "cap" ? 99 : 1000, maxSatsPerDay: 1000, maxSatsLifetime: 1000, allowlist: mode === "allowlist" ? [] : [key.toAddress()] }));
  if (mode === "held" || mode === "sponsored-held") writeFileSync(join(root, "payment.lock"), "orphan");
  if (mode === "pending") writeFileSync(join(root, "payment.pending.json"), "corrupt");
  if (mode === "kill") writeFileSync(paths.kill, "stop");
  if (mode === "brc181") writeFileSync(paths.brc181, "invalid");
  if (mode === "day") writeFileSync(paths.log, JSON.stringify({ t: new Date().toISOString(), amount: 950, asset: "bsv" }) + "\n");
  writeFileSync(join(root, "fixture.ready"), "yes");
}
const events: string[] = [];
const originalSign = Transaction.prototype.sign;
Transaction.prototype.sign = async function (...args: any[]) {
  if (this.inputs.some(i => i.sourceTXID === fund.id("hex"))) {
    const intent = existsSync(join(root, "payment.pending.json")) && JSON.parse(readFileSync(join(root, "payment.pending.json"), "utf8"));
    events.push(intent?.operation === "x402-delegate" ? "intent-before-sign" : "unheld-sign");
    if (mode === "sign-failure") throw new Error("fixture signing failure");
  }
  return originalSign.apply(this, args as []);
};
async function pause() { writeFileSync(join(root, "entered"), "yes"); await new Promise(() => {}); }
globalThis.fetch = (async (url, init) => {
  const target = String(url);
  events.push(target.includes("/delegate/") ? "delegate" : target.includes("gorillapool") ? "broadcast" : "chain");
  if (target.endsWith("/unspent")) {
    if (action === "send" && mode === "pause") await pause();
    return Response.json([{ tx_hash: fund.id("hex"), tx_pos: 0, value: mode === "value-lie" ? 2000 : fund.outputs[0].satoshis }, ...(mode === "multi" ? [{ tx_hash: secondFund.id("hex"), tx_pos: 0, value: 50 }] : [])]);
  }
  for (const tx of [fund, nonce, fee, secondFund]) if (target.endsWith(`/tx/${tx.id("hex")}/hex`)) {
    if (mode === "pending-failure" && tx === fund && !existsSync(join(root, "payment.pending.json"))) mkdirSync(join(root, "payment.pending.json"));
    return new Response(mode === "source-lie" && tx === fund ? nonce.toHex() : tx.toHex());
  }
  if (target === "https://fixture.invalid/delegate/x402") {
    events.push(existsSync(join(root, "payment.pending.json")) ? "intent" : "no-intent");
    if (mode === "pause" || mode === "crash") await pause();
    if (mode === "timeout" || mode === "sponsored-timeout") throw new Error("intercepted delegation timeout");
    const tx = Transaction.fromHex(JSON.parse(String(init?.body)).partial_tx);
    if (mode === "log-failure") mkdirSync(paths.log);
    if (tx.inputs[1]?.unlockingScript) {
      const sig = tx.inputs[1].unlockingScript.chunks[0].data!;
      events.push(`sighash-${sig[sig.length - 1]}`);
    }
    if (mode === "duplicate") tx.addInput({ ...tx.inputs[0] });
    if (mode === "extra-local") tx.addInput({ sourceTransaction: secondFund, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(vault.key, "all", true) });
    if (mode === "version") tx.version++;
    if (mode === "payee") tx.outputs[0].lockingScript = new P2PKH().lock(PrivateKey.fromHex("3".padStart(64, "0")).toAddress());
    if (mode === "change") tx.outputs[1].satoshis!--;
    tx.addInput({ sourceTransaction: fee, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key, "all", true) });
    // Guarded client mode commits ALL outputs; fee sponsor can append inputs only.
    if (mode === "sponsored" || mode === "extra-output") tx.addOutput({ satoshis: 90, lockingScript: lock });
    await tx.sign();
    if (mode === "bad-signature") tx.inputs[1].unlockingScript = template.inputs[0].unlockingScript;
    return Response.json({ completed_tx: tx.toHex(), txid: mode === "txid" ? "ff".repeat(32) : tx.id("hex") });
  }
  if (target.includes("gorillapool")) {
    if (mode === "broadcast-pause") await pause();
    if (mode === "broadcast-timeout") throw new Error("intercepted broadcast timeout");
    const raw = JSON.parse(String(init?.body)).rawTx;
    return Response.json({ txid: mode === "broadcast-id" ? "ee".repeat(32) : Transaction.fromHex(raw).id("hex"), txStatus: "SEEN_ON_NETWORK" });
  }
  throw new Error("Unexpected network blocked");
}) as typeof fetch;
process.env.DOGFOOD_X402_DELEGATOR_URL = "https://fixture.invalid";
delete process.env.DOGFOOD_X402_BROADCAST;
const client = new Client({ name: "delegate-test", version: "1" });
const server = createServer(root);
try {
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  let body: any;
  if (action === "send") body = await sendPayment({ root, to: key.toAddress(), amount: 100 });
  else {
    const result = await client.callTool({ name: "x402_delegate", arguments: { challenge: Buffer.from(JSON.stringify(ch)).toString("base64url"), vault_fund: !mode.startsWith("sponsored"), broadcast: mode !== "no-broadcast" } });
    const value = (result.content as any[])[0].text;
    try { body = JSON.parse(value); } catch { body = { message: value }; }
  }
  const rows = existsSync(paths.log) && statSync(paths.log).isFile() ? readFileSync(paths.log, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
  const tools = (await client.listTools()).tools.map(t => t.name);
  console.log(JSON.stringify({ body, events, tools, rows, held: existsSync(join(root, "payment.lock")), pending: existsSync(join(root, "payment.pending.json")) }));
} finally { await client.close(); await server.close(); }
