import { existsSync, readFileSync } from "node:fs";
import { evaluateBridgeSwap, type BridgePolicy, type Usage } from "./policy";

// The bridge: batched BSV->USDC conversions between our own vault and our
// own EVM pocket, via instant-swap providers. Safety shape: the payout
// address is FORCED to our pocket and verified against the created order —
// a rebalance can only ever move value vault -> provider -> our pocket.
// Legs log under synthetic assets (bridge-bsv / bridge-usdc) so conversions
// never count against payment caps.

export class BridgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

export type SwapQuote = {
  provider: string;
  fromAsset: "bsv";
  toAsset: "usdc-base";
  fromAmountSats: number;
  toAmount: number; // USDC base units
};

export type BridgeOrderStatus = "waiting" | "pending" | "finished" | "failed";

export type BridgeOrder = {
  provider: string;
  id: string;
  depositAddress: string;
  depositAmountSats: number;
  payoutAddress: string;
  payoutAmount: number;
  status: BridgeOrderStatus;
  payoutHash?: string;
};

export type BridgeProvider = {
  name: string;
  quote(opts: { fromAmountSats: number }): Promise<SwapQuote>;
  create(opts: { quote: SwapQuote; payoutAddress: string }): Promise<BridgeOrder>;
  status(id: string): Promise<BridgeOrder>;
};

export const BRIDGE_FEE_RESERVE_SATS = 1_000;
export const MIN_SWAP_SATS = 2_000; // sane floor; provider minimums are ~$1-2

export async function bestQuote(
  providers: BridgeProvider[],
  opts: { fromAmountSats: number },
): Promise<SwapQuote> {
  const settled = await Promise.allSettled(providers.map((p) => p.quote({ fromAmountSats: opts.fromAmountSats })));
  const ok = settled
    .filter((r): r is PromiseFulfilledResult<SwapQuote> => r.status === "fulfilled")
    .map((r) => r.value);
  if (ok.length === 0) {
    throw new BridgeError("NO_ROUTE", "REJECTED: no bridge provider returned a quote.");
  }
  return ok.sort((a, b) => b.toAmount - a.toAmount)[0];
}

export type BridgeThresholds = { usdcLowWater: number; swapSizeSats: number };

export function planRebalance(opts: {
  usdcBalance: number;
  bsvBalanceSats: number;
  thresholds: BridgeThresholds;
}): { fromAmountSats: number } | null {
  if (opts.usdcBalance >= opts.thresholds.usdcLowWater) return null;
  const available = opts.bsvBalanceSats - BRIDGE_FEE_RESERVE_SATS;
  const fromAmountSats = Math.min(opts.thresholds.swapSizeSats, available);
  if (fromAmountSats < MIN_SWAP_SATS) return null;
  return { fromAmountSats };
}

export async function executeRebalance(opts: {
  bridge: BridgePolicy | undefined;
  killfileOn: boolean;
  usage: Usage;
  providers: BridgeProvider[];
  fromAmountSats: number;
  ourPocket: string;
  send: (to: string, sats: number) => Promise<{ txid: string }>;
  logRow: (row: Record<string, unknown>) => void;
}): Promise<{ orderId: string; depositTxid: string; toAmount: number }> {
  const decision = evaluateBridgeSwap(opts.bridge, opts.killfileOn, opts.fromAmountSats, opts.usage);
  if (!decision.ok) throw new BridgeError(decision.code, decision.message);

  const q = await bestQuote(opts.providers, { fromAmountSats: opts.fromAmountSats });
  const chosen = opts.providers.find((p) => p.name === q.provider)!;
  const ord = await chosen.create({ quote: q, payoutAddress: opts.ourPocket });

  if (ord.payoutAddress.toLowerCase() !== opts.ourPocket.toLowerCase()) {
    throw new BridgeError(
      "BAD_PAYOUT",
      `REJECTED: provider order ${ord.id} pays out to ${ord.payoutAddress}, not our pocket ${opts.ourPocket}. Deposit NOT sent.`,
    );
  }

  const { txid } = await opts.send(ord.depositAddress, ord.depositAmountSats);
  const t = new Date().toISOString();
  opts.logRow({
    t,
    kind: "bridge-out",
    asset: "bridge-bsv",
    amount: ord.depositAmountSats,
    to: ord.depositAddress,
    orderId: ord.id,
    provider: ord.provider,
    txid,
  });
  opts.logRow({
    t,
    kind: "bridge-in",
    asset: "bridge-usdc",
    amount: ord.payoutAmount,
    orderId: ord.id,
    provider: ord.provider,
    pending: true,
  });
  return { orderId: ord.id, depositTxid: txid, toAmount: ord.payoutAmount };
}

// Records the arrived USDC leg once an order reports finished. Idempotent:
// an order with a non-pending bridge-in row already counts as recorded.
export function recordFinishedArrival(order: BridgeOrder, logRows: Record<string, unknown>[]): boolean {
  if (order.status !== "finished") return false;
  if (logRows.some((r) => r.kind === "bridge-in" && r.orderId === order.id && r.pending !== true)) return false;
  logRows.push({
    t: new Date().toISOString(),
    kind: "bridge-in",
    asset: "bridge-usdc",
    amount: order.payoutAmount,
    orderId: order.id,
    provider: order.provider,
    txid: order.payoutHash ?? null,
  });
  return true;
}

export type BridgeConfig = {
  changenowApiKey?: string;
  thresholds: BridgeThresholds;
};

export const DEFAULT_BRIDGE_THRESHOLDS: BridgeThresholds = { usdcLowWater: 5_000_000, swapSizeSats: 100_000 };

// bridge.json lives in the vault dir (never the repo): holds provider API
// keys and float thresholds. Missing file = defaults with no providers.
export function loadBridgeConfig(path: string): BridgeConfig {
  if (!existsSync(path)) return { thresholds: { ...DEFAULT_BRIDGE_THRESHOLDS } };
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return { thresholds: { ...DEFAULT_BRIDGE_THRESHOLDS } };
  }
  const t = (parsed.thresholds ?? {}) as Record<string, unknown>;
  return {
    changenowApiKey: typeof parsed.changenowApiKey === "string" && parsed.changenowApiKey ? parsed.changenowApiKey : undefined,
    thresholds: {
      usdcLowWater:
        typeof t.usdcLowWater === "number" && t.usdcLowWater > 0 ? Math.floor(t.usdcLowWater) : DEFAULT_BRIDGE_THRESHOLDS.usdcLowWater,
      swapSizeSats:
        typeof t.swapSizeSats === "number" && t.swapSizeSats > 0 ? Math.floor(t.swapSizeSats) : DEFAULT_BRIDGE_THRESHOLDS.swapSizeSats,
    },
  };
}
