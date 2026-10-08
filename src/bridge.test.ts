import { describe, expect, test } from "bun:test";
import { bestQuote, executeRebalance, planRebalance, recordFinishedArrival, type BridgeOrder, type BridgeProvider, type SwapQuote } from "./bridge";
import { evaluateBridgeSwap, type BridgePolicy } from "./policy";

const OUR_POCKET = "0x3285Bb4b72eCa1d2955928Fb8437Ac7ED167abdd";

function quote(toAmountUsdcUnits: number, provider = "mock"): SwapQuote {
  return {
    provider,
    fromAsset: "bsv",
    toAsset: "usdc-base",
    fromAmountSats: 100_000,
    toAmount: toAmountUsdcUnits,
  };
}

function order(over: Partial<BridgeOrder> = {}): BridgeOrder {
  return {
    provider: "mock",
    id: "ord-1",
    depositAddress: "1DepositAddressxxxxxxxxxxxxxxxxx",
    depositAmountSats: 100_000,
    payoutAddress: OUR_POCKET,
    payoutAmount: 6900,
    status: "waiting",
    ...over,
  };
}

function provider(over: Partial<BridgeProvider> = {}): BridgeProvider {
  return {
    name: "mock",
    quote: async () => quote(6900),
    create: async () => order(),
    status: async () => order({ status: "finished", payoutHash: "0xabc" }),
    ...over,
  };
}

describe("bestQuote", () => {
  test("picks the highest payout across providers; skips failing ones", async () => {
    const good = provider({ name: "good", quote: async () => quote(7000, "good") });
    const better = provider({ name: "better", quote: async () => quote(7200, "better") });
    const broken = provider({
      name: "broken",
      quote: async () => {
        throw new Error("down");
      },
    });
    const q = await bestQuote([good, broken, better], { fromAmountSats: 100_000 });
    expect(q.provider).toBe("better");
    expect(q.toAmount).toBe(7200);
  });

  test("throws NO_ROUTE when every provider fails", async () => {
    const broken = provider({
      quote: async () => {
        throw new Error("down");
      },
    });
    await expect(bestQuote([broken], { fromAmountSats: 1 })).rejects.toMatchObject({ code: "NO_ROUTE" });
  });
});

describe("planRebalance", () => {
  const thresholds = { usdcLowWater: 5_000_000, swapSizeSats: 100_000 };

  test("triggers a swap when the USDC float is below low water", () => {
    const plan = planRebalance({ usdcBalance: 1_000_000, bsvBalanceSats: 9_000_000, thresholds });
    expect(plan).toEqual({ fromAmountSats: 100_000 });
  });

  test("stays quiet above low water", () => {
    expect(planRebalance({ usdcBalance: 6_000_000, bsvBalanceSats: 9_000_000, thresholds })).toBeNull();
  });

  test("clamps to available BSV minus fee reserve; null when the vault cannot cover the minimum", () => {
    expect(planRebalance({ usdcBalance: 0, bsvBalanceSats: 60_000, thresholds })).toEqual({ fromAmountSats: 59_000 });
    expect(planRebalance({ usdcBalance: 0, bsvBalanceSats: 800, thresholds })).toBeNull();
  });
});

describe("evaluateBridgeSwap", () => {
  const bridge: BridgePolicy = { maxSatsPerSwap: 500_000, maxSatsPerDay: 1_000_000 };

  test("missing bridge block is DISABLED; killfile is KILL; over cap is CAP", () => {
    expect(evaluateBridgeSwap(undefined, false, 100, { spentToday: 0, spentLifetime: 0 })).toMatchObject({ ok: false, code: "DISABLED" });
    expect(evaluateBridgeSwap(bridge, true, 100, { spentToday: 0, spentLifetime: 0 })).toMatchObject({ ok: false, code: "KILL" });
    expect(evaluateBridgeSwap(bridge, false, 500_001, { spentToday: 0, spentLifetime: 0 })).toMatchObject({ ok: false, code: "CAP" });
    expect(evaluateBridgeSwap(bridge, false, 400_000, { spentToday: 700_000, spentLifetime: 0 })).toMatchObject({ ok: false, code: "DAY" });
    expect(evaluateBridgeSwap(bridge, false, 400_000, { spentToday: 500_000, spentLifetime: 0 }).ok).toBe(true);
  });
});

describe("executeRebalance", () => {
  const bridge: BridgePolicy = { maxSatsPerSwap: 500_000, maxSatsPerDay: null };
  const baseArgs = () => ({
    bridge,
    killfileOn: false,
    usage: { spentToday: 0, spentLifetime: 0 },
    providers: [provider()],
    fromAmountSats: 100_000,
    ourPocket: OUR_POCKET,
    send: async () => ({ txid: "dep-txid-1" }),
    log: [] as Record<string, unknown>[],
    logRow(row: Record<string, unknown>) {
      this.log.push(row);
    },
  });

  test("happy path: quotes, creates order with payout forced to our pocket, sends deposit, logs both legs", async () => {
    const args = baseArgs();
    let createdWith: { payoutAddress?: string } | undefined;
    args.providers = [
      provider({
        create: async (req) => {
          createdWith = req;
          return order({ payoutAddress: req.payoutAddress });
        },
      }),
    ];
    const r = await executeRebalance(args);
    expect(r).toMatchObject({ orderId: "ord-1", depositTxid: "dep-txid-1", toAmount: 6900 });
    expect(createdWith?.payoutAddress).toBe(OUR_POCKET);
    expect(args.log).toHaveLength(2);
    expect(args.log[0]).toMatchObject({ kind: "bridge-out", asset: "bridge-bsv", amount: 100_000, to: order().depositAddress, orderId: "ord-1" });
    expect(args.log[1]).toMatchObject({ kind: "bridge-in", asset: "bridge-usdc", amount: 6900, orderId: "ord-1", pending: true });
  });

  test("policy refusal: no provider calls, no send, no log", async () => {
    const args = baseArgs();
    args.bridge = undefined;
    let providerCalled = false;
    args.providers = [
      provider({
        quote: async () => {
          providerCalled = true;
          return quote(1);
        },
      }),
    ];
    await expect(executeRebalance(args)).rejects.toMatchObject({ code: "DISABLED" });
    expect(providerCalled).toBe(false);
    expect(args.log).toHaveLength(0);
  });

  test("refuses when the provider order's payout address is not our pocket (BAD_PAYOUT), no deposit sent", async () => {
    const args = baseArgs();
    let sent = false;
    args.send = async () => {
      sent = true;
      return { txid: "x" };
    };
    args.providers = [provider({ create: async () => order({ payoutAddress: "0x1111111111111111111111111111111111111111" }) })];
    await expect(executeRebalance(args)).rejects.toMatchObject({ code: "BAD_PAYOUT" });
    expect(sent).toBe(false);
    expect(args.log).toHaveLength(0);
  });
});

describe("recordFinishedArrival", () => {
  test("logs the USDC arrival once for a finished order; skips pending and duplicates", () => {
    const log: Record<string, unknown>[] = [
      { kind: "bridge-in", asset: "bridge-usdc", amount: 6900, orderId: "ord-1", pending: true },
    ];
    const pending = recordFinishedArrival(order({ status: "exchanging" }), log);
    expect(pending).toBe(false);
    expect(log).toHaveLength(1);

    const done = recordFinishedArrival(order({ status: "finished", payoutHash: "0xabc" }), log);
    expect(done).toBe(true);
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ kind: "bridge-in", asset: "bridge-usdc", amount: 6900, orderId: "ord-1", txid: "0xabc" });
    expect(log[1]).not.toHaveProperty("pending");

    const dup = recordFinishedArrival(order({ status: "finished", payoutHash: "0xabc" }), log);
    expect(dup).toBe(false);
    expect(log).toHaveLength(2);
  });
});
