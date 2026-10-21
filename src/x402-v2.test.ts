import { mockFetch } from "./test-support/fetch";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { USDC_BASE, USDC_BASE_SEPOLIA } from "./evm";
import { settleUsdcX402, UsdcX402Error } from "./evm-x402";
import {
  buildV2PaymentPayload,
  isV2PaymentRequired,
  parseV2SettleResponse,
  pickV2ExactEvm,
  type V2SignatureBundle,
} from "./x402-v2";
import type { EvmAssetPolicy } from "./policy";
import { makePayload, signEnvelope } from "./test-support/brc181";

const KEY = PrivateKey.fromHex("0".repeat(63) + "1");
const FROM = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "testdata", "x402-vectors-v2.json"), "utf8"),
) as {
  paymentRequired: Record<string, unknown>;
  httpPaymentRequired: Record<string, unknown>;
  paymentPayload: Record<string, unknown>;
  settlementSuccess: Record<string, unknown>;
  settlementFailure: Record<string, unknown>;
};

const pocket: EvmAssetPolicy = {
  maxPerTx: 1_000_000,
  maxPerDay: null,
  maxLifetime: null,
  allowlist: [PAY_TO.toLowerCase()],
};

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function v2Accept(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: "eip155:84532",
    amount: "10000",
    asset: USDC_BASE_SEPOLIA,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
    ...overrides,
  };
}

function v2Body(overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    resource: {
      url: "https://api.example.com/premium-data",
      description: "Access to premium market data",
      mimeType: "application/json",
    },
    accepts: [v2Accept()],
    ...overrides,
  };
}

function v1Body() {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: "10000",
        payTo: "0x209693Bc6afc0C5328bA36FaF03C18EF3122C5EA",
        asset: USDC_BASE,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  };
}

describe("isV2PaymentRequired", () => {
  test("detects v2 via PAYMENT-REQUIRED header before looking at body", () => {
    const headers = new Headers({ "PAYMENT-REQUIRED": b64(vectors.httpPaymentRequired) });
    expect(isV2PaymentRequired(headers, { x402Version: 1 })).toBe(true);
  });

  test("detects v2 via JSON body when header is absent", () => {
    expect(isV2PaymentRequired(new Headers(), vectors.paymentRequired)).toBe(true);
    expect(isV2PaymentRequired(new Headers(), v2Body())).toBe(true);
  });

  test("v1 402s are not v2", () => {
    expect(isV2PaymentRequired(new Headers(), v1Body())).toBe(false);
    expect(isV2PaymentRequired(new Headers(), { x402Version: 1, accepts: [] })).toBe(false);
  });

  test("garbage PAYMENT-REQUIRED header falls back to body", () => {
    const headers = new Headers({ "PAYMENT-REQUIRED": "%%%not-base64%%%" });
    expect(isV2PaymentRequired(headers, v2Body())).toBe(true);
    expect(isV2PaymentRequired(headers, v1Body())).toBe(false);
  });
});

describe("pickV2ExactEvm", () => {
  test("picks exact + eip155:84532 USDC from the frozen spec example", () => {
    const picked = pickV2ExactEvm(vectors.paymentRequired);
    expect(picked).not.toBeNull();
    expect(picked!.scheme).toBe("exact");
    expect(picked!.network).toBe("eip155:84532");
    expect(picked!.asset.toLowerCase()).toBe(USDC_BASE_SEPOLIA.toLowerCase());
    expect(picked!.amount).toBe("10000");
    expect(JSON.stringify(picked)).toBe(JSON.stringify((vectors.paymentRequired as { accepts: unknown[] }).accepts[0]));
  });

  test("skips unknown flow, unknown network, unknown scheme, wrong asset; mixed array picks the good entry", () => {
    const good = v2Accept();
    const body = v2Body({
      accepts: [
        v2Accept({ scheme: "upto" }),
        v2Accept({ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }),
        v2Accept({ network: "eip155:1" }),
        v2Accept({ asset: USDC_BASE }),
        v2Accept({ extra: { name: "USDC", version: "2", paymentFlow: "escrow" } }),
        v2Accept({ extra: { name: "USDC", version: "2", paymentFlow: "upfront" } }),
        good,
      ],
    });
    const picked = pickV2ExactEvm(body);
    expect(JSON.stringify(picked)).toBe(JSON.stringify(good));
  });

  test("prefers authorization flow over upfront when both match", () => {
    const upfront = v2Accept({ amount: "1", extra: { name: "USDC", version: "2", paymentFlow: "upfront" } });
    const auth = v2Accept({ extra: { name: "USDC", version: "2", paymentFlow: "authorization" } });
    const picked = pickV2ExactEvm(v2Body({ accepts: [upfront, auth] }));
    expect(JSON.stringify(picked)).toBe(JSON.stringify(auth));
  });

  test("picks eip155:8453 mainnet USDC", () => {
    const main = v2Accept({ network: "eip155:8453", asset: USDC_BASE });
    expect(pickV2ExactEvm(v2Body({ accepts: [main] }))!.network).toBe("eip155:8453");
  });

  test("no match returns null so settle can throw UNSUPPORTED", () => {
    expect(pickV2ExactEvm(v2Body({ accepts: [v2Accept({ network: "eip155:1" })] }))).toBeNull();
  });

  test("malformed amount on an otherwise matching entry fails closed", () => {
    expect(() => pickV2ExactEvm(v2Body({ accepts: [v2Accept({ amount: "10.5" })] }))).toThrow(/BAD_REQUIREMENT|malformed/i);
    expect(() => pickV2ExactEvm(v2Body({ accepts: [v2Accept({ amount: "-1" })] }))).toThrow(/BAD_REQUIREMENT|malformed/i);
  });

  test("non-hex payTo on a matching entry fails closed", () => {
    expect(() => pickV2ExactEvm(v2Body({ accepts: [v2Accept({ payTo: "not-an-address" })] }))).toThrow(/BAD_ADDRESS|malformed/i);
  });
});

describe("buildV2PaymentPayload", () => {
  const requirement = v2Accept();
  const resource = (v2Body() as { resource: Record<string, unknown> }).resource;
  const bundle = {
    signature: "0x" + "ab".repeat(65),
    authorization: {
      from: FROM,
      to: PAY_TO,
      value: "10000",
      validAfter: "0",
      validBefore: "1700003600",
      nonce: "0x" + "cd".repeat(32),
    },
  };

  test("payload base64 round-trips to the locked schema; accepted echoes requirements byte-equal", () => {
    const payload = buildV2PaymentPayload(requirement, resource, undefined, bundle);
    expect(payload.x402Version).toBe(2);
    expect(JSON.stringify(payload.accepted)).toBe(JSON.stringify(requirement));
    expect(payload.resource).toEqual(resource);
    expect("extensions" in payload).toBe(false);
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
    const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    expect(decoded).toEqual(payload);
    expect(decoded.payload.authorization).toEqual(bundle.authorization);
    expect(decoded.payload.authorization.validAfter).toBe("0");
  });

  test("extensions echo preserved; missing extensions omitted", () => {
    const extensions = {
      discovery: { info: { bazaar: true }, schema: { type: "object" } },
    };
    const withExt = buildV2PaymentPayload(requirement, resource, extensions, bundle);
    expect(withExt.extensions).toEqual(extensions);
    expect((withExt.extensions as typeof extensions).discovery.info).toEqual({ bazaar: true });
    const without = buildV2PaymentPayload(requirement, resource, undefined, bundle);
    expect("extensions" in without).toBe(false);
  });

  test("frozen spec payload is wrap-only: signature is not recovered", () => {
    const spec = vectors.paymentPayload as {
      accepted: Record<string, unknown>;
      resource: Record<string, unknown>;
      payload: V2SignatureBundle;
      extensions: Record<string, unknown>;
    };
    const wrapped = buildV2PaymentPayload(spec.accepted, spec.resource, spec.extensions, spec.payload);
    expect(wrapped.payload.signature).toBe(spec.payload.signature);
    expect(wrapped.x402Version).toBe(2);
  });

  test("real privkey=1 EIP-3009 vector wraps as v2 and round-trips the header", async () => {
    const { buildX402PaymentHeader } = await import("./evm");
    const v1Header = await buildX402PaymentHeader({
      key: KEY,
      requirement: {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: "10000",
        payTo: PAY_TO,
        asset: USDC_BASE_SEPOLIA,
        extra: { name: "USDC", version: "2" },
      },
      from: FROM,
      now: 1_700_000_000,
      nonceHex: "0x" + "cd".repeat(32),
    });
    const v1 = JSON.parse(Buffer.from(v1Header, "base64").toString("utf8")) as {
      payload: V2SignatureBundle;
    };
    const requirement = v2Accept();
    const resource = (v2Body() as { resource: Record<string, unknown> }).resource;
    const payload = buildV2PaymentPayload(requirement, resource, undefined, v1.payload);
    expect(payload.payload.authorization.validAfter).toBe("0");
    expect(payload.payload.authorization).toEqual(v1.payload.authorization);
    expect(payload.payload.signature).toBe(v1.payload.signature);
    expect(payload.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
    const header = Buffer.from(JSON.stringify(payload)).toString("base64");
    const round = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    expect(round).toEqual(payload);
  });
});

describe("parseV2SettleResponse", () => {
  test("success txHash surfaced from PAYMENT-RESPONSE header", () => {
    const headers = new Headers({ "PAYMENT-RESPONSE": b64(vectors.settlementSuccess) });
    const parsed = parseV2SettleResponse(headers, {});
    expect(parsed).toEqual({
      success: true,
      txHash: (vectors.settlementSuccess as { transaction: string }).transaction,
      errorReason: undefined,
      network: "eip155:84532",
      payer: (vectors.settlementSuccess as { payer: string }).payer,
    });
  });

  test("errorReason surfaced on failure", () => {
    const headers = new Headers({ "PAYMENT-RESPONSE": b64(vectors.settlementFailure) });
    const parsed = parseV2SettleResponse(headers, {});
    expect(parsed?.success).toBe(false);
    expect(parsed?.errorReason).toBe("insufficient_funds");
  });

  test("falls back to JSON body paymentResponse when header is absent", () => {
    const parsed = parseV2SettleResponse(new Headers(), { paymentResponse: vectors.settlementSuccess });
    expect(parsed?.success).toBe(true);
    expect(parsed?.txHash).toBe((vectors.settlementSuccess as { transaction: string }).transaction);
  });
});

describe("settleUsdcX402 v2 dispatch", () => {
  test("v2 402 via header signs PAYMENT-SIGNATURE not X-PAYMENT", async () => {
    const calls: { payment?: string | null; sig?: string | null }[] = [];
    const fetchFn = mockFetch(async (_input, init) => {
      const h = init?.headers as Record<string, string> | undefined;
      calls.push({ payment: h?.["X-PAYMENT"] ?? null, sig: h?.["PAYMENT-SIGNATURE"] ?? null });
      if (!h?.["PAYMENT-SIGNATURE"]) {
        return jsonResponse(402, {}, { "PAYMENT-REQUIRED": b64(v2Body()) });
      }
      const settle = { success: true, transaction: "0x" + "11".repeat(32), network: "eip155:84532", payer: FROM };
      return jsonResponse(200, { data: "premium" }, { "PAYMENT-RESPONSE": b64(settle) });
    });
    const r = await settleUsdcX402({
      url: "https://api.example.com/premium-data",
      key: KEY,
      from: FROM,
      pocket,
      killfileOn: false,
      usage: { spentToday: 0, spentLifetime: 0 },
      fetchFn,
      now: 1_700_000_000,
    });
    expect(r.ok).toBe(true);
    expect(r.txHash).toBe("0x" + "11".repeat(32));
    expect(calls).toHaveLength(2);
    expect(calls[1].payment).toBeNull();
    expect(calls[1].sig).toBeTruthy();
    const payload = JSON.parse(Buffer.from(calls[1].sig!, "base64").toString("utf8"));
    expect(payload.x402Version).toBe(2);
    expect(payload.payload.authorization.validAfter).toBe("0");
    expect(payload.payload.authorization.from).toBe(FROM);
    expect(payload.payload.authorization.to).toBe(PAY_TO);
    expect(payload.payload.authorization.value).toBe("10000");
    expect(JSON.stringify(payload.accepted)).toBe(JSON.stringify(v2Accept()));
  });

  test("v2 402 via body (no PAYMENT-REQUIRED header) still dispatches to v2", async () => {
    const calls: { sig?: string | null }[] = [];
    const fetchFn = mockFetch(async (_input, init) => {
      const h = init?.headers as Record<string, string> | undefined;
      calls.push({ sig: h?.["PAYMENT-SIGNATURE"] ?? null });
      if (!h?.["PAYMENT-SIGNATURE"]) return jsonResponse(402, v2Body());
      return jsonResponse(200, { data: "premium" }, {
        "PAYMENT-RESPONSE": b64({ success: true, transaction: "0x" + "33".repeat(32), network: "eip155:84532" }),
      });
    });
    const r = await settleUsdcX402({
      url: "https://api.example.com/premium-data",
      key: KEY,
      from: FROM,
      pocket,
      killfileOn: false,
      usage: { spentToday: 0, spentLifetime: 0 },
      fetchFn,
      now: 1_700_000_000,
    });
    expect(r.ok).toBe(true);
    expect(calls[1].sig).toBeTruthy();
    expect(JSON.parse(Buffer.from(calls[1].sig!, "base64").toString("utf8")).x402Version).toBe(2);
  });

  test("v1 402s still route to v1 X-PAYMENT", async () => {
    const v1PayTo = "0x209693Bc6afc0C5328bA36FaF03C18EF3122C5EA";
    const v1Pocket: EvmAssetPolicy = { ...pocket, allowlist: [v1PayTo.toLowerCase()] };
    const calls: { payment?: string | null; sig?: string | null }[] = [];
    const fetchFn = mockFetch(async (_input, init) => {
      const h = init?.headers as Record<string, string> | undefined;
      calls.push({ payment: h?.["X-PAYMENT"] ?? null, sig: h?.["PAYMENT-SIGNATURE"] ?? null });
      if (!h?.["X-PAYMENT"]) return jsonResponse(402, v1Body());
      return jsonResponse(200, { data: "premium" }, {
        "X-PAYMENT-RESPONSE": b64({ success: true, transaction: "0x" + "44".repeat(32), network: "base", payer: FROM }),
      });
    });
    const r = await settleUsdcX402({
      url: "https://api.example.com/premium",
      key: KEY,
      from: FROM,
      pocket: v1Pocket,
      killfileOn: false,
      usage: { spentToday: 0, spentLifetime: 0 },
      fetchFn,
      now: 1_700_000_000,
    });
    expect(r.ok).toBe(true);
    expect(calls[1].sig).toBeNull();
    expect(calls[1].payment).toBeTruthy();
    expect(JSON.parse(Buffer.from(calls[1].payment!, "base64").toString("utf8")).x402Version).toBe(1);
  });

  test("settle failure surfaces errorReason and logs nothing", async () => {
    const fetchFn = mockFetch(async (_input, init) => {
      const h = init?.headers as Record<string, string> | undefined;
      if (!h?.["PAYMENT-SIGNATURE"]) return jsonResponse(402, v2Body());
      return jsonResponse(402, {}, { "PAYMENT-RESPONSE": b64(vectors.settlementFailure) });
    });
    const spends: unknown[] = [];
    await expect(
      settleUsdcX402({
        url: "https://api.example.com/premium-data",
        key: KEY,
        from: FROM,
        pocket,
        killfileOn: false,
        usage: { spentToday: 0, spentLifetime: 0 },
        fetchFn,
        onSpend: (row) => spends.push(row),
      }),
    ).rejects.toMatchObject({ code: "SETTLE_FAILED", message: expect.stringContaining("insufficient_funds") });
    expect(spends).toHaveLength(0);
  });

  test("policy cap blocks BEFORE signing", async () => {
    const calls: string[] = [];
    let reserved = false;
    const fetchFn = mockFetch(async (input) => {
      calls.push(String(input));
      return jsonResponse(402, v2Body({ accepts: [v2Accept({ amount: "2000000" })] }));
    });
    await expect(
      settleUsdcX402({
        url: "https://api.example.com/premium-data",
        key: KEY,
        from: FROM,
        pocket,
        killfileOn: false,
        usage: { spentToday: 0, spentLifetime: 0 },
        fetchFn,
        beforeSign: () => {
          reserved = true;
        },
      }),
    ).rejects.toMatchObject({ code: "CAP" });
    expect(calls).toHaveLength(1);
    expect(reserved).toBe(false);
  });

  test("allowlist denial blocks BEFORE signing", async () => {
    let reserved = false;
    const fetchFn = mockFetch(async () => jsonResponse(402, v2Body()));
    await expect(
      settleUsdcX402({
        url: "https://api.example.com/premium-data",
        key: KEY,
        from: FROM,
        pocket: { ...pocket, allowlist: ["0x" + "00".repeat(20)] },
        killfileOn: false,
        usage: { spentToday: 0, spentLifetime: 0 },
        fetchFn,
        beforeSign: () => {
          reserved = true;
        },
      }),
    ).rejects.toMatchObject({ code: "ALLOWLIST" });
    expect(reserved).toBe(false);
  });

  test("BRC-181 off-allowlist dest refuses before signing", async () => {
    const fetchFn = mockFetch(async () => jsonResponse(402, v2Body()));
    let reserved = false;
    await expect(
      settleUsdcX402({
        url: "https://api.example.com/premium-data",
        key: KEY,
        from: FROM,
        pocket,
        killfileOn: false,
        usage: { spentToday: 0, spentLifetime: 0 },
        fetchFn,
        beforeSign: () => {
          reserved = true;
        },
        policyEnvelope: signEnvelope(makePayload({ dest_allowlist: [`evm:0x${"0".repeat(40)}`] })),
        origin: "test-origin",
      }),
    ).rejects.toMatchObject({ code: "POLICY" });
    expect(reserved).toBe(false);
  });

  test("no acceptable v2 requirement throws UNSUPPORTED so CLI can fall through", async () => {
    const fetchFn = mockFetch(async () => jsonResponse(402, v2Body({ accepts: [v2Accept({ network: "eip155:1" })] })));
    await expect(
      settleUsdcX402({
        url: "https://api.example.com/premium-data",
        key: KEY,
        from: FROM,
        pocket,
        killfileOn: false,
        usage: { spentToday: 0, spentLifetime: 0 },
        fetchFn,
      }),
    ).rejects.toBeInstanceOf(UsdcX402Error);
    await expect(
      settleUsdcX402({
        url: "https://api.example.com/premium-data",
        key: KEY,
        from: FROM,
        pocket,
        killfileOn: false,
        usage: { spentToday: 0, spentLifetime: 0 },
        fetchFn,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});

test("CLI x402-inspect pretty-prints v2 PaymentRequired", async () => {
  const encoded = b64(vectors.httpPaymentRequired);
  const child = Bun.spawn(
    [process.execPath, "src/cli.ts", "x402-inspect", encoded],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, DOGFOOD_WALLET_DIR: resolve(import.meta.dir, "test-support/nonexistent-vault") },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exit).toBe(0);
  const printed = JSON.parse(stdout);
  expect(printed.x402Version).toBe(2);
  expect(printed.accepts[0].network).toBe("eip155:84532");
}, 30000);
