import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { P2PKH, PrivateKey, Transaction } from "@bsv/sdk";
import { createMerchantApp, type MerchantConfig } from "./merchant";

const key = PrivateKey.fromRandom();
const payTo = PrivateKey.fromRandom().toAddress();
const other = PrivateKey.fromRandom().toAddress();
const base: MerchantConfig = { payTo: "0x1111111111111111111111111111111111111111", priceBaseUnits: 1000, resourcePath: "/v1/fortune", facilitatorUrl: "https://facilitator.invalid", network: "base-sepolia" };
async function fixture(amounts = [500], destination = payTo, duplicate = false) {
  const source = new Transaction();
  source.addOutput({ satoshis: 2000, lockingScript: new P2PKH().lock(key.toAddress()) });
  const tx = new Transaction();
  for (let i = 0; i < (duplicate ? 2 : 1); i++) tx.addInput({ sourceTransaction: source, sourceTXID: source.id("hex"), sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) });
  for (const satoshis of amounts) tx.addOutput({ satoshis, lockingScript: new P2PKH().lock(destination) });
  await tx.sign();
  return { source, tx };
}
function harness(f: Awaited<ReturnType<typeof fixture>>, mode = "ok", overrides: Partial<MerchantConfig> = {}) {
  const calls: string[] = [];
  const fetchFn = (async (input: any, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    if (url.endsWith(`/tx/${f.source.id("hex")}/hex`)) {
      if (mode === "unknown") return new Response("unknown", { status: 404 });
      if (mode === "source-mismatch") return new Response(f.tx.toHex());
      return new Response(f.source.toHex());
    }
    if (url.endsWith(`/address/${key.toAddress()}/unspent`)) return Response.json(mode === "spent" ? [] : [{ tx_hash: f.source.id("hex"), tx_pos: 0, value: 2000 }]);
    if (url === "https://arc.gorillapool.io/v1/tx") {
      expect(JSON.parse(String(init?.body)).rawTx).toBe(f.tx.toHex());
      if (mode === "broadcast-fail") return new Response("rejected", { status: 500 });
      if (mode === "fee-fallback") return new Response("fee too low 465", { status: 465 });
      if (mode === "arc-rejected") return Response.json({ txid: f.tx.id("hex"), txStatus: "REJECTED", status: 200 });
      if (mode === "arc-double-spend") return Response.json({ txid: f.tx.id("hex"), txStatus: "DOUBLE_SPEND_ATTEMPTED", status: 200 });
      return Response.json({ txid: mode === "wrong-txid" ? "0".repeat(64) : f.tx.id("hex") });
    }
    if (url.endsWith("/tx/raw") && mode === "fee-fallback") return Response.json(f.tx.id("hex"));
    throw new Error(`Unexpected network call: ${url}`);
  }) as typeof fetch;
  const app = createMerchantApp({ ...base, bsvPayTo: payTo, fetchFn, ...overrides });
  const request = (raw = f.tx.toHex()) => app(new Request("https://merchant.invalid/v1/fortune", { headers: { "X-BSV-PAYMENT": raw } }));
  return { app, request, calls, broadcasts: () => calls.filter(x => x.includes("arc.gorillapool") || x.endsWith("/tx/raw")) };
}

describe("merchant BSV direct", () => {
  test("standalone entry wires optional BSV environment config", () => {
    const entry = readFileSync(new URL("./merchant-main.ts", import.meta.url), "utf8");
    expect(entry).toMatch(/bsvPayTo:\s*process\.env\.DOGFOOD_MERCHANT_BSV_PAYTO/);
    expect(entry).toMatch(/bsvSatoshis:\s*Number\(process\.env\.DOGFOOD_MERCHANT_BSV_SATS\s*\?\?\s*500\)/);
  });
  test("advertises alongside USDC with default and custom sats; absent when disabled", async () => {
    const f = await fixture();
    for (const sats of [undefined, 750]) {
      const h = harness(f, "ok", { bsvSatoshis: sats });
      const res = await h.app(new Request("https://merchant.invalid/v1/fortune"));
      expect(res.status).toBe(402);
      expect((await res.json()).accepts).toContainEqual({ scheme: "bsv-direct", network: "bsv-main", satoshis: sats ?? 500, payTo });
      expect(res.headers.get("x-bsv-payment-satoshis-required")).toBe(String(sats ?? 500));
      expect(res.headers.get("x-bsv-payment-address")).toBe(payTo);
    }
    const res = await createMerchantApp(base)(new Request("https://merchant.invalid/v1/fortune"));
    expect((await res.json()).accepts).toHaveLength(1);
    expect(res.headers.has("x-bsv-payment-address")).toBe(false);
  });
  test("accepts signed split payments without confirmation wait and returns receipt", async () => {
    const f = await fixture([200, 300]); const h = harness(f);
    const res = await h.request(); expect(res.status).toBe(200);
    expect(JSON.parse(Buffer.from(res.headers.get("x-payment-response")!, "base64").toString())).toEqual({ success: true, transaction: f.tx.id("hex"), network: "bsv-main" });
    expect(h.broadcasts()).toHaveLength(1);
    expect(h.calls).toHaveLength(3);
  });
  for (const [name, amounts, destination, mode, reason] of [
    ["underpaid", [499], payTo, "ok", /underpaid/i],
    ["wrong address", [500], other, "ok", /underpaid|payee/i],
    ["spent", [500], payTo, "spent", /spent|unspent/i],
    ["unknown", [500], payTo, "unknown", /source|unknown/i],
    ["source mismatch", [500], payTo, "source-mismatch", /source.*mismatch/i],
    ["inflation", [2001], payTo, "ok", /inflation|exceed/i],
  ] as const) test(`rejects ${name} before broadcast`, async () => {
    const h = harness(await fixture([...amounts], destination), mode);
    const res = await h.request(); expect(res.status).toBe(402); expect((await res.json()).error).toMatch(reason); expect(h.broadcasts()).toHaveLength(0);
  });
  test("rejects duplicate inputs before broadcast", async () => {
    const h = harness(await fixture([500], payTo, true));
    const res = await h.request(); expect(res.status).toBe(402); expect((await res.json()).error).toMatch(/duplicate/i); expect(h.broadcasts()).toHaveLength(0);
  });
  test("rejects garbage and trailing bytes without broadcast", async () => {
    const f = await fixture(); const h = harness(f);
    for (const raw of ["garbage", "00", f.tx.toHex() + "00"]) {
      const res = await h.request(raw); expect(res.status).toBe(402); expect((await res.json()).error).toMatch(/invalid|malformed|hex/i);
    }
    expect(h.broadcasts()).toHaveLength(0);
  });
  test("rejects replay, including concurrent attempts", async () => {
    const h = harness(await fixture());
    const results = await Promise.all([h.request(), h.request()]);
    expect(results.map(r => r.status).sort()).toEqual([200, 402]);
    const callsBeforeReplay = h.calls.length;
    const replay = await h.request(); expect(replay.status).toBe(402); expect((await replay.json()).error).toMatch(/replay|already|used/i);
    // Source existence/unspent validation precedes the txid replay gate.
    expect(h.calls.slice(callsBeforeReplay)).toHaveLength(2);
    expect(h.broadcasts()).toHaveLength(1);
  });
  for (const mode of ["broadcast-fail", "wrong-txid", "arc-rejected", "arc-double-spend"]) test(`fails closed on ${mode}`, async () => {
    const h = harness(await fixture(), mode); const res = await h.request();
    expect(res.status).toBe(402); expect((await res.json()).error).toMatch(/broadcast|settlement|txid/i); expect(h.broadcasts()).toHaveLength(1);
  });
  test("existing broadcaster fee fallback also uses injected fetch", async () => {
    const h = harness(await fixture(), "fee-fallback"); expect((await h.request()).status).toBe(200); expect(h.broadcasts()).toHaveLength(2);
  });
});
