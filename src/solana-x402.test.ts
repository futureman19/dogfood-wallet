import { describe, expect, test } from "bun:test";
import { PrivateKey } from "@bsv/sdk";

// Solana x402 (`exact` scheme) client settlement, mirroring evm-x402.ts:
// GET -> 402 -> pick exact/solana(-devnet)/USDC -> policy gate -> build the
// partially-signed transaction -> retry with X-PAYMENT -> settlement header.
// Fail-closed everywhere.

const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MERCHANT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OUR_ADDR = "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt";

function keyOne() {
  return PrivateKey.fromHex("1".padStart(64, "0"));
}

const requirement = {
  scheme: "exact",
  network: "solana-devnet",
  maxAmountRequired: "1000",
  resource: "https://merchant.test/fortune",
  payTo: MERCHANT,
  asset: USDC_DEVNET,
  maxTimeoutSeconds: 60,
  extra: { feePayer: "CkTDQfii4biNwDuWGbLCBxaY2M9VLsDu3fMNvWEbZvTa" },
};

function settleHeader(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function world(opts?: {
  firstBody?: unknown;
  paidStatus?: number;
  paidHeaders?: Record<string, string>;
}): { fetchFn: typeof fetch; spent: Record<string, unknown>[] } {
  const spent: Record<string, unknown>[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    if (body.includes("getLatestBlockhash")) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { blockhash: "4uHCe4FhA1RqVhVPe7LBDhMvVKjCPyUKBiLfkPePbZZ7", lastValidBlockHeight: 100 } } }));
    }
    const headers = new Headers(init?.headers);
    if (!headers.has("X-PAYMENT")) {
      return new Response(JSON.stringify(opts?.firstBody ?? { x402Version: 1, accepts: [requirement] }), { status: 402 });
    }
    return new Response("fortune!", {
      status: opts?.paidStatus ?? 200,
      headers: opts?.paidHeaders ?? { "X-PAYMENT-RESPONSE": settleHeader({ success: true, transaction: "5xTxHash" }) },
    });
  }) as typeof fetch;
  return { fetchFn, spent };
}

const POCKET = { maxPerTx: 1000000, maxPerDay: 5000000, maxLifetime: null, allowlist: [MERCHANT.toLowerCase()] };
const USAGE = { spentToday: 0, spentLifetime: 0 };

describe("pickExactSolanaUsdc", () => {
  test("picks the solana-devnet USDC requirement", async () => {
    const { pickExactSolanaUsdc } = await import("./solana-x402");
    const picked = pickExactSolanaUsdc({ x402Version: 1, accepts: [requirement] });
    expect(picked?.network).toBe("solana-devnet");
    expect(picked?.payTo).toBe(MERCHANT);
    expect(picked?.maxAmountRequired).toBe("1000");
  });

  test("ignores wrong scheme, wrong network, wrong asset, and junk", async () => {
    const { pickExactSolanaUsdc } = await import("./solana-x402");
    expect(pickExactSolanaUsdc({ accepts: [{ ...requirement, scheme: "upto" }] })).toBe(null);
    expect(pickExactSolanaUsdc({ accepts: [{ ...requirement, network: "solana-mainnet-beta" }] })).toBe(null);
    expect(pickExactSolanaUsdc({ accepts: [{ ...requirement, asset: "So11111111111111111111111111111111111111112" }] })).toBe(null);
    expect(pickExactSolanaUsdc({})).toBe(null);
    expect(pickExactSolanaUsdc("nope")).toBe(null);
  });

  test("accepts mainnet solana USDC", async () => {
    const { pickExactSolanaUsdc, } = await import("./solana-x402");
    const main = { ...requirement, network: "solana", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
    expect(pickExactSolanaUsdc({ accepts: [main] })?.network).toBe("solana");
  });
});

describe("settleSolanaX402", () => {
  test("happy path: 402 -> sign -> 200 with settlement header + spend log", async () => {
    const { settleSolanaX402 } = await import("./solana-x402");
    const { fetchFn, spent } = world();
    const result = await settleSolanaX402({
      url: "https://merchant.test/fortune",
      key: keyOne(),
      from: OUR_ADDR,
      pocket: POCKET,
      killfileOn: false,
      usage: USAGE,
      fetchFn,
      onSpend: (row) => spent.push(row),
    });
    expect(result.ok).toBe(true);
    expect(result.txHash).toBe("5xTxHash");
    expect(result.body).toBe("fortune!");
    expect(spent).toHaveLength(1);
    expect(spent[0].asset).toBe("usdc-solana");
    expect(spent[0].amount).toBe(1000);
    expect(spent[0].to).toBe(MERCHANT);
  });

  test("REJECTED when no solana requirement is offered", async () => {
    const { settleSolanaX402, SolanaX402Error } = await import("./solana-x402");
    const { fetchFn } = world({ firstBody: { x402Version: 1, accepts: [] } });
    const err = await settleSolanaX402({
      url: "https://merchant.test/fortune",
      key: keyOne(),
      from: OUR_ADDR,
      pocket: POCKET,
      killfileOn: false,
      usage: USAGE,
      fetchFn,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SolanaX402Error);
    expect((err as InstanceType<typeof SolanaX402Error>).code).toBe("UNSUPPORTED");
  });

  test("policy refusal happens before any payment is signed", async () => {
    const { settleSolanaX402, SolanaX402Error } = await import("./solana-x402");
    const { fetchFn, spent } = world();
    const err = await settleSolanaX402({
      url: "https://merchant.test/fortune",
      key: keyOne(),
      from: OUR_ADDR,
      pocket: { ...POCKET, maxPerTx: 500 },
      killfileOn: false,
      usage: USAGE,
      fetchFn,
      onSpend: (row) => spent.push(row),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SolanaX402Error);
    expect((err as InstanceType<typeof SolanaX402Error>).code).toBe("CAP");
    expect(spent).toHaveLength(0);
  });

  test("killfile blocks payment", async () => {
    const { settleSolanaX402, SolanaX402Error } = await import("./solana-x402");
    const { fetchFn } = world();
    const err = await settleSolanaX402({
      url: "https://merchant.test/fortune",
      key: keyOne(),
      from: OUR_ADDR,
      pocket: POCKET,
      killfileOn: true,
      usage: USAGE,
      fetchFn,
    }).catch((e) => e);
    expect((err as InstanceType<typeof SolanaX402Error>).code).toBe("KILL");
  });

  test("facilitator failure surfaces as SETTLE_FAILED", async () => {
    const { settleSolanaX402, SolanaX402Error } = await import("./solana-x402");
    const { fetchFn } = world({
      paidStatus: 402,
      paidHeaders: { "X-PAYMENT-RESPONSE": settleHeader({ success: false, errorReason: "insufficient_funds" }) },
    });
    const err = await settleSolanaX402({
      url: "https://merchant.test/fortune",
      key: keyOne(),
      from: OUR_ADDR,
      pocket: POCKET,
      killfileOn: false,
      usage: USAGE,
      fetchFn,
    }).catch((e) => e);
    expect((err as InstanceType<typeof SolanaX402Error>).code).toBe("SETTLE_FAILED");
    expect(String(err)).toContain("insufficient_funds");
  });
});
