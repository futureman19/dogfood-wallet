import { existsSync, readFileSync, lstatSync, openSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { withPaymentGuard } from "./payment-guard";
import { Utils } from "@bsv/sdk";
import { evaluateBridgeSwap, type BridgePolicy, type Usage } from "./policy";

// Bridge order quarantine for BSV -> our own Base USDC pocket.
// This bounded slice NEVER signs, deposits, logs arrivals, or releases orders.
// Provider responses are evidence, not proof of chain settlement.

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
  depositHash?: string;
};

export type BridgeProvider = {
  name: string;
  quote(opts: { fromAmountSats: number }): Promise<SwapQuote>;
  create(opts: { quote: SwapQuote; payoutAddress: string }): Promise<BridgeOrder>;
  status(id: string): Promise<BridgeOrder>;
};

// Provider decimal values must not coerce booleans/null/objects into money.
export function bridgeAmount(value: unknown): number {
  if (typeof value !== "number" && !(typeof value === "string" && /^[0-9]+(?:\.[0-9]+)?$/.test(value))) return NaN;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : NaN;
}

export const BRIDGE_FEE_RESERVE_SATS = 1_000;
export const MIN_SWAP_SATS = 2_000; // sane floor; provider minimums are ~$1-2

export async function bestQuote(
  providers: BridgeProvider[],
  opts: { fromAmountSats: number },
): Promise<SwapQuote> {
  const settled = await Promise.allSettled(providers.map((p) => p.quote({ fromAmountSats: opts.fromAmountSats })));
  const ok = settled
    .flatMap((r, n) => r.status === "fulfilled" && r.value && r.value.provider === providers[n].name
      && r.value.fromAsset === "bsv" && r.value.toAsset === "usdc-base"
      && r.value.fromAmountSats === opts.fromAmountSats && positive(r.value.toAmount)
      ? [{ provider: providers[n].name, fromAsset: "bsv" as const, toAsset: "usdc-base" as const,
        fromAmountSats: opts.fromAmountSats, toAmount: r.value.toAmount }] : []);
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

// Bounded order-only lifecycle. Deposits and arrival accounting are deliberately
// disabled until a separately verified funding/reconciliation implementation exists.
export type BridgePreparation = {
  bridge: BridgePolicy | undefined;
  killfileOn: boolean;
  usage: Usage;
  providers: BridgeProvider[];
  fromAmountSats: number;
  ourPocket: string;
};
const held = () => new BridgeError("BRIDGE_ORDER_HELD", "Bridge order quarantined. No deposit is submitted by this path. Do not retry or clear; inspect bridge-status and docs/payment-recovery.md.");
const token = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v) && !["undefined", "null"].includes(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const evm = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
function validPayin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 35) return false;
  try {
    const decoded = Utils.fromBase58Check(value);
    return decoded.prefix.length === 1 && decoded.prefix[0] === 0 && decoded.data.length === 20;
  } catch { return false; }
}
function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw held(); }
}
function saveBridge(root: string, name: string, row: unknown) {
  const fd = openSync(join(root, name), "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(row) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  if (process.platform !== "win32") {
    const dir = openSync(root, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
}
// Historical bridge logs cannot establish whether the float arrived. Refuse
// history/corruption rather than silently reconstructing order state or usage.
function checkBridgeHistory(root: string) {
  const path = join(root, "spends.jsonl");
  if (!present(path)) return;
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)) {
      const row = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row)
        || String(row.kind).startsWith("bridge-") || String(row.asset).startsWith("bridge-")) throw new Error();
    }
  } catch { throw new BridgeError("BRIDGE_HISTORY", "Bridge history or unreadable accounting requires independent owner reconciliation. No order created."); }
}
export async function executeRebalance(opts: {
  root: string;
  prepare: () => Promise<BridgePreparation>;
}): Promise<never> {
  return withPaymentGuard(opts.root, "bridge-order", async (guard) => {
    for (const name of ["bridge.intent.json", "bridge.order.json"]) if (present(join(opts.root, name))) throw held();
    checkBridgeHistory(opts.root);
    const prepared = await opts.prepare();
    const { bridge, killfileOn, usage, fromAmountSats, ourPocket } = prepared;
    const decision = evaluateBridgeSwap(bridge, killfileOn, fromAmountSats, usage);
    if (!decision.ok) throw new BridgeError(decision.code, decision.message);
    if (!evm(ourPocket)) throw new BridgeError("BAD_PAYOUT", "Invalid own pocket address.");
    const providers = [...prepared.providers];
    if (providers.some(p => !token(p.name)) || new Set(providers.map(p => p.name)).size !== providers.length) throw new BridgeError("NO_ROUTE", "Invalid provider identity.");
    const q = await bestQuote(providers, { fromAmountSats });
    const chosen = providers.find(p => p.name === q.provider)!;
    const intent = { version: 1, intentId: randomUUID(), started: new Date().toISOString(), provider: chosen.name,
      fromAmountSats, payoutAddress: ourPocket, expectedPayoutAmount: q.toAmount };
    // Reserve before any order POST. Even failure while writing the separate
    // intent retains payment.lock; there is no automatic retry after this point.
    guard.reserve({ asset: "bsv", amount: fromAmountSats, to: ourPocket });
    try {
      saveBridge(opts.root, "bridge.intent.json", intent);
      let ord: BridgeOrder;
      try { ord = await chosen.create({ quote: { ...q }, payoutAddress: ourPocket }); }
      catch (e) {
        const candidate = (e as { candidateOrderId?: unknown })?.candidateOrderId;
        if (token(candidate)) saveBridge(opts.root, "bridge.order.json", {version: 1, intentId: intent.intentId, provider: intent.provider, orderId: candidate, validated: false});
        throw e;
      }
      // Whitelist public evidence only; never persist provider response bodies,
      // arbitrary extras, credentials, or error strings. Keep a usable candidate
      // identity even if other response fields fail validation.
      const evidence = { version: 1, intentId: intent.intentId, provider: intent.provider,
        ...(token(ord?.id) ? { orderId: ord.id } : {}),
        ...(typeof ord?.depositAddress === "string" && validPayin(ord.depositAddress) ? { depositAddress: ord.depositAddress } : {}),
        ...(positive(ord?.depositAmountSats) ? { depositAmountSats: ord.depositAmountSats } : {}),
        ...(evm(ord?.payoutAddress) ? { payoutAddress: ord.payoutAddress } : {}),
        ...(positive(ord?.payoutAmount) ? { expectedPayoutAmount: ord.payoutAmount } : {}),
        validated: !!ord && ord.provider === intent.provider && token(ord.id) && validPayin(ord.depositAddress)
          && ord.depositAmountSats === fromAmountSats && evm(ord.payoutAddress)
          && ord.payoutAddress.toLowerCase() === ourPocket.toLowerCase() && positive(ord.payoutAmount) && ord.status === "waiting",
      };
      saveBridge(opts.root, "bridge.order.json", evidence);
    } catch { throw held(); }
    // A known order is NOT a deposit or swap completion. Intentionally retain
    // the shared hold, including on valid order creation. No signing capability
    // or log callback exists in this API.
    throw held();
  });
}

/** Local, read-only diagnostics; no provider call, accounting or hold removal. */
export function inspectBridgeOrder(root: string) {
  const base = { deposit: "not-submitted-by-this-path", arrival: "unverified" };
  try {
    const ip = join(root, "bridge.intent.json"), op = join(root, "bridge.order.json");
    if (!present(ip)) return { ...base, state: present(op) ? "invalid" : "absent" };
    const i = JSON.parse(readFileSync(ip, "utf8"));
    if (i.version !== 1 || !/^[0-9a-f-]{36}$/.test(i.intentId) || !token(i.provider) || !positive(i.fromAmountSats)
      || !positive(i.expectedPayoutAmount) || !evm(i.payoutAddress) || !Number.isFinite(Date.parse(i.started))) throw held();
    if (!present(op)) return { ...base, state: "creation-unresolved", intentId: i.intentId, provider: i.provider };
    const o = JSON.parse(readFileSync(op, "utf8"));
    if (o.version !== 1 || o.intentId !== i.intentId || o.provider !== i.provider || o.validated !== true
      || !token(o.orderId) || !validPayin(o.depositAddress) || o.depositAmountSats !== i.fromAmountSats
      || !evm(o.payoutAddress) || o.payoutAddress.toLowerCase() !== i.payoutAddress.toLowerCase() || !positive(o.expectedPayoutAmount)) throw held();
    return { ...base, state: "order-recorded", intentId: i.intentId, provider: i.provider, orderId: o.orderId,
      depositAddress: o.depositAddress, depositAmountSats: o.depositAmountSats, payoutAddress: o.payoutAddress, expectedPayoutAmount: o.expectedPayoutAmount };
  } catch { return { ...base, state: "invalid" }; }
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
