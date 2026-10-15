import { describe, expect, test } from "bun:test";
import { bestQuote, planRebalance, type BridgeOrder, type BridgeProvider, type SwapQuote } from "./bridge";
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
