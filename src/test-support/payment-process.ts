// Disposable-vault subprocess only; no network escape hatch.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Transaction } from "@bsv/sdk";
import { sendPayment, splitPayment } from "../send";
import { payX402 } from "../x402-pay";

const [root, mode, behavior = "normal"] = process.argv.slice(2);
if (!root || !existsSync(join(root, "fixture.json"))) throw new Error("fixture required");
const fixture = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8"));
const source = Transaction.fromHex(fixture.hex);
let calls = 0;
async function pause() {
  console.log("READY");
  if (behavior === "crash") process.exit(23);
  if (behavior === "pause") await Bun.stdin.text();
}
const funds = async () => [{ tx_hash: source.id("hex"), tx_pos: 0, value: source.outputs[0].satoshis! }];
globalThis.fetch = (async (input, init) => {
  calls++;
  const target = String(input);
  if (target === "https://fixture.invalid/pay") {
    const raw = new Headers(init?.headers).get("X-BSV-PAYMENT");
    if (!raw) return Response.json({ accepts: [{ scheme: "bsv-direct", network: "bsv-main", satoshis: 500, payTo: fixture.to }] }, { status: 402 });
    await pause();
    return new Response("paid", { headers: { "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, network: "bsv-main", transaction: Transaction.fromHex(raw).id("hex") })).toString("base64") } });
  }
  if (target.endsWith("/unspent")) return Response.json(await funds());
  if (target.endsWith(`/tx/${source.id("hex")}/hex`)) return new Response(fixture.hex);
  throw new Error("Unexpected fixture network");
}) as typeof fetch;
try {
  const result = mode === "x402" ? await payX402(root, "https://fixture.invalid/pay") : await (mode === "split" ? splitPayment : sendPayment)({
    root, to: fixture.to, amount: 500,
    fetchUtxos: async () => { calls++; return funds(); },
    fetchTxHex: async () => fixture.hex,
    broadcast: async raw => { calls++; await pause(); return { txid: Transaction.fromHex(raw).id("hex") }; },
  });
  console.log(JSON.stringify({ result, calls }));
} catch (e) { console.log(JSON.stringify({ result: { ok: false, code: (e as { code?: string }).code, message: (e as Error).message }, calls })); }
