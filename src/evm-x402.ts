import type { PaymentIntent } from "./payment-guard";
import type { PrivateKey } from "@bsv/sdk";
import { buildX402PaymentHeader, USDC_BASE, USDC_BASE_SEPOLIA, type X402ExactRequirement } from "./evm";
import { evaluateEvmSend, type EvmAssetPolicy, type Usage } from "./policy";
import { canonicalEvmDest, gateAgentSend, type PolicyEnvelope } from "./brc181";
import {
  buildV2PaymentPayload,
  caipToV1Network,
  parseV2SettleResponse,
  pickV2ExactEvm,
  readV2PaymentRequired,
  type V2SignatureBundle,
} from "./x402-v2";

// Coinbase x402 (`exact` scheme, EIP-3009) settlement for the EVM pocket.
// Flow: GET resource -> 402 with JSON body -> pick the exact/base/USDC
// requirement -> policy gate -> sign -> retry with X-PAYMENT -> read the
// X-PAYMENT-RESPONSE settlement header. Fail-closed everywhere.

export class UsdcX402Error extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UsdcX402Error";
    this.code = code;
  }
}

export function pickExactBaseUsdc(body: unknown): X402ExactRequirement | null {
  const accepts = (body as { accepts?: unknown })?.accepts;
  if (!Array.isArray(accepts)) return null;
  const assets: Record<string, string> = { base: USDC_BASE, "base-sepolia": USDC_BASE_SEPOLIA };
  for (const a of accepts as Record<string, unknown>[]) {
    const network = typeof a?.network === "string" ? a.network : "";
    const expectedAsset = assets[network];
    if (
      a?.scheme === "exact" &&
      expectedAsset &&
      typeof a?.maxAmountRequired === "string" &&
      typeof a?.payTo === "string" &&
      typeof a?.asset === "string" &&
      (a.asset as string).toLowerCase() === expectedAsset.toLowerCase()
    ) {
      return {
        scheme: "exact",
        network,
        maxAmountRequired: a.maxAmountRequired as string,
        payTo: a.payTo as string,
        asset: a.asset as string,
        extra: a.extra as { name?: string; version?: string } | undefined,
      };
    }
  }
  return null;
}

export type UsdcSettleResult = {
  ok: true;
  txHash: string | null;
  amountUsdc: string;
  payTo: string;
  body: string;
};

export async function settleUsdcX402(opts: {
  url: string;
  key: PrivateKey;
  from: string;
  pocket: EvmAssetPolicy | undefined;
  killfileOn: boolean;
  usage: Usage;
  fetchFn?: typeof fetch;
  requireReceipt?: boolean;
  beforeSign?: (intent: PaymentIntent) => void;
  onSpend?: (row: Record<string, unknown>) => void;
  now?: number;
  /** Signed BRC-181 policy envelope. When present it ANDs with policy.json. */
  policyEnvelope?: PolicyEnvelope | null;
  /** Lifetime spend inside the envelope's own brc181-usdc-base scope. */
  brc181SpentTotal?: number;
  origin?: string;
}): Promise<UsdcSettleResult> {
  const fetchFn = opts.fetchFn ?? fetch;

  const first = await fetchFn(opts.url);
  if (first.status !== 402) {
    throw new UsdcX402Error("NOT_GATED", `REJECTED: expected a 402 from ${opts.url}, got HTTP ${first.status}.`);
  }
  const body: unknown = await first.json();
  const v2 = readV2PaymentRequired(first.headers, body);
  if (v2) return settleUsdcX402V2({ ...opts, fetchFn, paymentRequired: v2 });
  const req = pickExactBaseUsdc(body);
  if (!req) {
    throw new UsdcX402Error(
      "UNSUPPORTED",
      "REJECTED: no acceptable requirement (scheme=exact, network=base, asset=USDC) in the 402 response.",
    );
  }

  const amount = Number(req.maxAmountRequired);
  const decision = evaluateEvmSend(opts.pocket, opts.killfileOn, amount, req.payTo, opts.usage);
  if (!decision.ok) throw new UsdcX402Error(decision.code, decision.message);

  // A signed BRC-181 envelope gates this rail too. Its numeric fields are read
  // in the rail's native units (USDC base units here); the facilitator pays
  // gas, so the client-side fee is 0.
  let dest: string;
  try {
    dest = canonicalEvmDest(req.payTo);
  } catch {
    throw new UsdcX402Error("BAD_ADDRESS", "REJECTED: USDC payee is not a valid EVM address.");
  }
  const gate = gateAgentSend({
    envelope: opts.policyEnvelope,
    dest,
    amount,
    fee: 0,
    spentTotal: opts.brc181SpentTotal ?? opts.usage.spentLifetime,
    origin: opts.origin,
  });
  if (!gate.ok) throw new UsdcX402Error(gate.code, gate.message);

  opts.beforeSign?.({ asset: "usdc-base", amount, to: req.payTo });
  const header = await buildX402PaymentHeader({ key: opts.key, requirement: req, from: opts.from, now: opts.now });
  const paid = await fetchFn(opts.url, { headers: { "X-PAYMENT": header } });

  type SettlementReceipt = { success?: boolean; transaction?: string; error?: string };
  let settle: SettlementReceipt | null = null;
  const settleHeader = paid.headers.get("X-PAYMENT-RESPONSE");
  if (settleHeader) {
    try {
      settle = JSON.parse(Buffer.from(settleHeader, "base64").toString("utf8")) as SettlementReceipt | null;
    } catch {
      settle = null;
    }
  }
  if (opts.requireReceipt && (settle?.success !== true || typeof settle.transaction !== "string" || !settle.transaction)) {
    throw new UsdcX402Error("SETTLE_FAILED", "REJECTED: missing or invalid settlement receipt; hold retained.");
  }
  if (settle && settle.success === false) {
    throw new UsdcX402Error(
      "SETTLE_FAILED",
      `REJECTED: facilitator settlement failed: ${settle.error ?? "unknown error"}.`,
    );
  }
  if (paid.status >= 400) {
    throw new UsdcX402Error("SETTLE_FAILED", `REJECTED: merchant returned HTTP ${paid.status} after payment.`);
  }

  const text = await paid.text();
  opts.onSpend?.({
    t: new Date().toISOString(),
    kind: "send",
    asset: "usdc-base",
    amount,
    to: req.payTo,
    txid: settle?.transaction ?? null,
    resource: opts.url,
  });
  return { ok: true, txHash: settle?.transaction ?? null, amountUsdc: req.maxAmountRequired, payTo: req.payTo, body: text };
}

async function settleUsdcX402V2(opts: Parameters<typeof settleUsdcX402>[0] & {
  fetchFn: typeof fetch;
  paymentRequired: Record<string, unknown>;
}): Promise<UsdcSettleResult> {
  let req;
  try {
    req = pickV2ExactEvm(opts.paymentRequired);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.includes("BAD_ADDRESS") ? "BAD_ADDRESS" : "BAD_REQUIREMENT";
    throw new UsdcX402Error(code, `REJECTED: ${msg}`);
  }
  if (!req) {
    throw new UsdcX402Error(
      "UNSUPPORTED",
      "REJECTED: no acceptable requirement (scheme=exact, network=eip155:8453|84532, asset=USDC) in the 402 response.",
    );
  }
  const resource = opts.paymentRequired.resource;
  if (!resource || typeof resource !== "object") {
    throw new UsdcX402Error("BAD_REQUIREMENT", "REJECTED: v2 PaymentRequired is missing resource.");
  }

  const amount = Number(req.amount);
  const decision = evaluateEvmSend(opts.pocket, opts.killfileOn, amount, req.payTo, opts.usage);
  if (!decision.ok) throw new UsdcX402Error(decision.code, decision.message);

  let dest: string;
  try {
    dest = canonicalEvmDest(req.payTo);
  } catch {
    throw new UsdcX402Error("BAD_ADDRESS", "REJECTED: USDC payee is not a valid EVM address.");
  }
  const gate = gateAgentSend({
    envelope: opts.policyEnvelope,
    dest,
    amount,
    fee: 0,
    spentTotal: opts.brc181SpentTotal ?? opts.usage.spentLifetime,
    origin: opts.origin,
  });
  if (!gate.ok) throw new UsdcX402Error(gate.code, gate.message);

  opts.beforeSign?.({ asset: "usdc-base", amount, to: req.payTo });
  const v1Header = await buildX402PaymentHeader({
    key: opts.key,
    from: opts.from,
    now: opts.now,
    requirement: {
      scheme: "exact",
      network: caipToV1Network(req.network),
      maxAmountRequired: req.amount,
      payTo: req.payTo,
      asset: req.asset,
      extra: req.extra as { name?: string; version?: string } | undefined,
    },
  });
  const v1 = JSON.parse(Buffer.from(v1Header, "base64").toString("utf8")) as { payload: V2SignatureBundle };
  const extensions = Object.prototype.hasOwnProperty.call(opts.paymentRequired, "extensions")
    ? opts.paymentRequired.extensions
    : undefined;
  const payload = buildV2PaymentPayload(req, resource, extensions, v1.payload);
  const paid = await opts.fetchFn(opts.url, {
    headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") },
  });

  const text = await paid.text();
  let paidBody: unknown = null;
  try {
    paidBody = JSON.parse(text);
  } catch {
    paidBody = null;
  }
  const settle = parseV2SettleResponse(paid.headers, paidBody);
  if (settle && settle.success === false) {
    throw new UsdcX402Error(
      "SETTLE_FAILED",
      `REJECTED: facilitator settlement failed: ${settle.errorReason ?? "unknown error"}.`,
    );
  }
  if (opts.requireReceipt && (settle?.success !== true || !settle.txHash)) {
    throw new UsdcX402Error("SETTLE_FAILED", "REJECTED: missing or invalid settlement receipt; hold retained.");
  }
  if (paid.status >= 400) {
    throw new UsdcX402Error("SETTLE_FAILED", `REJECTED: merchant returned HTTP ${paid.status} after payment.`);
  }

  opts.onSpend?.({
    t: new Date().toISOString(),
    kind: "send",
    asset: "usdc-base",
    amount,
    to: req.payTo,
    txid: settle?.txHash ?? null,
    resource: opts.url,
  });
  return { ok: true, txHash: settle?.txHash ?? null, amountUsdc: req.amount, payTo: req.payTo, body: text };
}
