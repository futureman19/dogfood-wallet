import { describe, expect, test } from "bun:test";
import { PrivateKey } from "@bsv/sdk";
import {
  buildUsdcRequirement,
  createMerchantApp,
  parsePaymentHeader,
  verifyPayment,
  MerchantError,
  type MerchantConfig,
} from "./merchant";
import { settleUsdcX402 } from "./evm-x402";
import { USDC_BASE } from "./evm";
import type { EvmAssetPolicy } from "./policy";

const MERCHANT_KEY = PrivateKey.fromHex("0".repeat(63) + "2");
const MERCHANT_ADDR = "0x" + "42".repeat(20); // payTo fixture; signature checks use the client's own key
const CLIENT_KEY = PrivateKey.fromHex("0".repeat(63) + "1");
const CLIENT_ADDR = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

const PRICE = 1_000; // $0.001

const config: MerchantConfig = {
  payTo: MERCHANT_ADDR,
  priceBaseUnits: PRICE,
  resourcePath: "/v1/fortune",
  facilitatorUrl: "https://facilitator.example",
  network: "base",
};

describe("buildUsdcRequirement", () => {
  test("emits an exact/base/USDC requirement paying our pocket", () => {
    const req = buildUsdcRequirement(config, "https://merchant.example");
    expect(req).toMatchObject({
      scheme: "exact",
      network: "base",
      maxAmountRequired: "1000",
      payTo: MERCHANT_ADDR,
      asset: USDC_BASE,
    });
    expect(req.extra).toMatchObject({ name: "USD Coin", version: "2" });
  });
});

describe("parsePaymentHeader", () => {
  test("decodes base64 JSON; rejects garbage", () => {
    const good = { x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0x12", authorization: {} } };
    expect(parsePaymentHeader(Buffer.from(JSON.stringify(good)).toString("base64"))).toEqual(good);
    expect(() => parsePaymentHeader("not-base64!!!")).toThrow(MerchantError);
  });
});

describe("verifyPayment", () => {
  test("accepts a correctly signed authorization and rejects mismatches", async () => {
    const { buildX402PaymentHeader } = await import("./evm");
    const requirement = buildUsdcRequirement(config, "https://merchant.example");
    const header = await buildX402PaymentHeader({
      key: CLIENT_KEY,
      requirement,
      from: CLIENT_ADDR,
      now: 1_700_000_000,
      nonceHex: "0x" + "77".repeat(32),
    });
    const payload = parsePaymentHeader(header);
    const ok = await verifyPayment(payload, requirement, { now: 1_700_000_100 });
    expect(ok.ok).toBe(true);

    // wrong payee
    expect(
      (await verifyPayment(payload, { ...requirement, payTo: "0x" + "99".repeat(20) }, { now: 1_700_000_100 })).ok,
    ).toBe(false);
    // wrong network
    expect(
      (await verifyPayment(payload, { ...requirement, network: "ethereum" }, { now: 1_700_000_100 })).ok,
    ).toBe(false);
    // underpaid
    expect(
      (await verifyPayment(payload, { ...requirement, maxAmountRequired: "2000" }, { now: 1_700_000_100 })).ok,
    ).toBe(false);
    // expired
    expect((await verifyPayment(payload, requirement, { now: 1_800_000_000 })).ok).toBe(false);
    // tampered authorization (different value than the signature covers)
    const tampered = structuredClone(payload) as typeof payload;
    (tampered.payload.authorization as { value: string }).value = "1";
    expect((await verifyPayment(tampered, requirement, { now: 1_700_000_100 })).ok).toBe(false);
  });
});

describe("merchant app (full client<->merchant loop)", () => {
  test("402 without payment; 200 with a real client signature and facilitator settle", async () => {
    const facilitatorCalls: unknown[] = [];
    const facilitatorFetch: typeof fetch = async (_url, init) => {
      facilitatorCalls.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ success: true, transaction: "0x" + "ab".repeat(32), network: "base", payer: CLIENT_ADDR }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const app = createMerchantApp({ ...config, facilitatorFetch });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app });
    try {
      const url = `http://127.0.0.1:${server.port}/v1/fortune`;

      // no payment -> 402 with accepts
      const first = await fetch(url);
      expect(first.status).toBe(402);
      const body = (await first.json()) as { accepts: unknown[] };
      expect(body.accepts).toHaveLength(1);

      // pay through OUR OWN client
      const pocket: EvmAssetPolicy = { maxPerTx: 10_000, maxPerDay: null, maxLifetime: null, allowlist: null };
      const r = await settleUsdcX402({
        url,
        key: CLIENT_KEY,
        from: CLIENT_ADDR,
        pocket,
        killfileOn: false,
        usage: { spentToday: 0, spentLifetime: 0 },
      });
      expect(r.ok).toBe(true);
      expect(r.txHash).toBe("0x" + "ab".repeat(32));
      expect(JSON.parse(r.body)).toMatchObject({ fortune: expect.any(String) });
      expect(facilitatorCalls).toHaveLength(1);
      const settleReq = facilitatorCalls[0] as { paymentPayload: { payload: { authorization: { to: string } } } };
      expect(settleReq.paymentPayload.payload.authorization.to).toBe(MERCHANT_ADDR);
    } finally {
      server.stop(true);
    }
  });

  test("replay: the same nonce cannot buy twice", async () => {
    const facilitatorFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ success: true, transaction: "0x" + "cd".repeat(32), network: "base" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const app = createMerchantApp({ ...config, facilitatorFetch });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app });
    try {
      const url = `http://127.0.0.1:${server.port}/v1/fortune`;
      const { buildX402PaymentHeader } = await import("./evm");
      const requirement = buildUsdcRequirement(config, url);
      const header = await buildX402PaymentHeader({
        key: CLIENT_KEY,
        requirement,
        from: CLIENT_ADDR,
        nonceHex: "0x" + "88".repeat(32),
      });
      const r1 = await fetch(url, { headers: { "X-PAYMENT": header } });
      expect(r1.status).toBe(200);
      const r2 = await fetch(url, { headers: { "X-PAYMENT": header } });
      expect(r2.status).toBe(402);
    } finally {
      server.stop(true);
    }
  });
});
