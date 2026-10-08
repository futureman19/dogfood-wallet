import type { PrivateKey } from "@bsv/sdk";
import { buildX402PaymentHeader, USDC_BASE, type X402ExactRequirement } from "./evm";
import { evaluateEvmSend, type EvmAssetPolicy, type Usage } from "./policy";

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
  for (const a of accepts as Record<string, unknown>[]) {
    if (
      a?.scheme === "exact" &&
      a?.network === "base" &&
      typeof a?.maxAmountRequired === "string" &&
      typeof a?.payTo === "string" &&
      typeof a?.asset === "string" &&
      (a.asset as string).toLowerCase() === USDC_BASE.toLowerCase()
    ) {
      return {
        scheme: "exact",
        network: "base",
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
  onSpend?: (row: Record<string, unknown>) => void;
  now?: number;
}): Promise<UsdcSettleResult> {
  const fetchFn = opts.fetchFn ?? fetch;

  const first = await fetchFn(opts.url);
  if (first.status !== 402) {
    throw new UsdcX402Error("NOT_GATED", `REJECTED: expected a 402 from ${opts.url}, got HTTP ${first.status}.`);
  }
  const body: unknown = await first.json();
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

  const header = await buildX402PaymentHeader({ key: opts.key, requirement: req, from: opts.from, now: opts.now });
  const paid = await fetchFn(opts.url, { headers: { "X-PAYMENT": header } });

  let settle: { success?: boolean; transaction?: string; error?: string } | null = null;
  const settleHeader = paid.headers.get("X-PAYMENT-RESPONSE");
  if (settleHeader) {
    try {
      settle = JSON.parse(Buffer.from(settleHeader, "base64").toString("utf8")) as typeof settle;
    } catch {
      settle = null;
    }
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
