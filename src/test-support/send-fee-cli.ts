// Preload for disposable CLI fixtures only. Never forwards any request to a provider.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { P2PKH, Transaction } from "@bsv/sdk";
const root = process.env.DOGFOOD_WALLET_DIR!;
const fixture = JSON.parse(readFileSync(join(root, "public-fixture.json"), "utf8"));
const source = new Transaction();
source.addOutput({ satoshis: 1227, lockingScript: new P2PKH().lock(fixture.address) });
const sign = Transaction.prototype.sign;
Transaction.prototype.sign = async function (...args) {
  appendFileSync(join(root, "calls.jsonl"), '"sign"\n');
  return sign.apply(this, args);
};
globalThis.fetch = Object.assign(async (input: any, init?: RequestInit) => {
  const url = String(input);
  appendFileSync(join(root, "calls.jsonl"), JSON.stringify(url) + "\n");
  if (url === `https://api.whatsonchain.com/v1/bsv/main/address/${fixture.address}/unspent`) {
    return Response.json([{ tx_hash: source.id("hex"), tx_pos: 0, value: 1227 }]);
  }
  if (url === `https://api.whatsonchain.com/v1/bsv/main/tx/${source.id("hex")}/hex`) return new Response(source.toHex());
  if (url === "https://arc.gorillapool.io/v1/tx") {
    const tx = Transaction.fromHex(JSON.parse(String(init?.body)).rawTx);
    return Response.json({ txid: tx.id("hex") });
  }
  throw new Error("UNEXPECTED_SYNTHETIC_REQUEST");
}, { preconnect() { throw new Error("NETWORK_FORBIDDEN"); } }) as typeof fetch;
