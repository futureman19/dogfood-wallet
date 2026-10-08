import { describe, expect, test } from "bun:test";
import { PrivateKey } from "@bsv/sdk";
import { settleUsdcX402, UsdcX402Error } from "./evm-x402";
import { USDC_BASE } from "./evm";
import type { EvmAssetPolicy } from "./policy";

const KEY = PrivateKey.fromHex("0".repeat(63) + "1");
const FROM = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C18EF3122C5EA";

const pocket: EvmAssetPolicy = {
  maxPerTx: 1_000_000,
  maxPerDay: null,
  maxLifetime: null,
  allowlist: [PAY_TO.toLowerCase()],
};

function acceptsBody(overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: "10000",
        resource: "https://api.example.com/premium",
        description: "premium data",
        mimeType: "application/json",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        asset: USDC_BASE,
        extra: { name: "USD Coin", version: "2" },
        ...overrides,
      },
    ],
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("settleUsdcX402", () => {
  test("happy path: 402 -> sign -> paid 200 with settlement header; spend logged", async () => {
    const calls: { url: string; payment?: string | null }[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      const payment = (init?.headers as Record<string, string> | undefined)?.["X-PAYMENT"] ?? null;
      calls.push({ url, payment });
      if (!payment) return jsonResponse(402, acceptsBody());
      const settle = { success: true, transaction: "0x" + "11".repeat(32), network: "base", payer: FROM };
      return jsonResponse(200, { data: "premium" }, { "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify(settle)).toString("base64") });
    };
    const spends: Record<string, unknown>[] = [];
    const r = await settleUsdcX402({
      url: "https://api.example.com/premium",
      key: KEY,
      from: FROM,
      pocket,
      killfileOn: false,
      usage: { spentToday: 0, spentLifetime: 0 },
      fetchFn,
      onSpend: (row) => spends.push(row),
      now: 1_700_000_000,
    });
    expect(r.ok).toBe(true);
    expect(r.txHash).toBe("0x" + "11".repeat(32));
    expect(r.amountUsdc).toBe("10000");
    expect(r.payTo).toBe(PAY_TO);
    expect(calls).toHaveLength(2);
    const payload = JSON.parse(Buffer.from(calls[1].payment!, "base64").toString("utf8"));
    expect(payload.payload.authorization.from).toBe(FROM);
    expect(payload.payload.authorization.to).toBe(PAY_TO);
    expect(payload.payload.authorization.value).toBe("10000");
    expect(spends).toHaveLength(1);
    expect(spends[0]).toMatchObject({ kind: "send", asset: "usdc-base", amount: 10000, to: PAY_TO });
  });

  test("policy refusal stops before signing: only one fetch, no spend logged", async () => {
    const calls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      calls.push(String(input));
      return jsonResponse(402, acceptsBody({ maxAmountRequired: "2000000" }));
    };
    const spends: unknown[] = [];
    await expect(
      settleUsdcX402({
        url: "https://api.example.com/premium",
        key: KEY,
        from: FROM,
        pocket,
        killfileOn: false,
        usage: { spentToday: 0, spentLifetime: 0 },
        fetchFn,
        onSpend: (row) => spends.push(row),
      }),
    ).rejects.toMatchObject({ code: "CAP" });
    expect(calls).toHaveLength(1);
    expect(spends).toHaveLength(0);
  });

  test("no acceptable requirement (wrong scheme/network/asset) fails closed", async () => {
    const fetchFn: typeof fetch = async () => jsonResponse(402, acceptsBody({ network: "ethereum" }));
    await expect(
      settleUsdcX402({
        url: "https://api.example.com/premium",
        key: KEY,
        from: FROM,
        pocket,
        killfileOn: false,
        usage: { spentToday: 0, spentLifetime: 0 },
        fetchFn,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  test("non-402 first response refuses to pay", async () => {
    const fetchFn: typeof fetch = async () => jsonResponse(200, { data: "free" });
    await expect(
      settleUsdcX402({
        url: "https://api.example.com/premium",
        key: KEY,
        from: FROM,
        pocket,
        killfileOn: false,
        usage: { spentToday: 0, spentLifetime: 0 },
        fetchFn,
      }),
    ).rejects.toMatchObject({ code: "NOT_GATED" });
  });

  test("failed settlement reports the facilitator error and logs nothing", async () => {
    const fetchFn: typeof fetch = async (_input, init) => {
      const payment = (init?.headers as Record<string, string> | undefined)?.["X-PAYMENT"];
      if (!payment) return jsonResponse(402, acceptsBody());
      const settle = { success: false, error: "insufficient_balance", network: "base", payer: FROM };
      return jsonResponse(402, acceptsBody(), { "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify(settle)).toString("base64") });
    };
    const spends: unknown[] = [];
    await expect(
      settleUsdcX402({
        url: "https://api.example.com/premium",
        key: KEY,
        from: FROM,
        pocket,
        killfileOn: false,
        usage: { spentToday: 0, spentLifetime: 0 },
        fetchFn,
        onSpend: (row) => spends.push(row),
      }),
    ).rejects.toMatchObject({ code: "SETTLE_FAILED" });
    expect(spends).toHaveLength(0);
  });

  test("UsdcX402Error carries a code", () => {
    expect(new UsdcX402Error("UNSUPPORTED", "x").code).toBe("UNSUPPORTED");
  });
});
