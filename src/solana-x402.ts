import type { PaymentIntent } from "./payment-guard";
import type { PrivateKey } from "@bsv/sdk";
import {
  buildSolanaX402PaymentHeader,
  USDC_SOLANA,
  USDC_SOLANA_DEVNET,
  type SolanaExactRequirement,
} from "./solana";
import { evaluateSolanaSend, type EvmAssetPolicy, type Usage } from "./policy";
import { canonicalSolanaDest, gateAgentSend, type PolicyEnvelope } from "./brc181";

// x402 (`exact` scheme) settlement for the Solana pocket, mirroring
// evm-x402.ts: GET -> 402 -> pick exact/solana(-devnet)/USDC -> policy gate ->
// build partially-signed tx -> retry with X-PAYMENT -> settlement header.
// Fail-closed everywhere.

export class SolanaX402Error extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SolanaX402Error";
    this.code = code;
  }
}

export function pickExactSolanaUsdc(body: unknown): SolanaExactRequirement | null {
  const accepts = (body as { accepts?: unknown })?.accepts;
  if (!Array.isArray(accepts)) return null;
  const assets: Record<string, string> = { solana: USDC_SOLANA, "solana-devnet": USDC_SOLANA_DEVNET };
  for (const a of accepts as Record<string, unknown>[]) {
    const network = typeof a?.network === "string" ? a.network : "";
    const expectedAsset = assets[network];
    if (
      a?.scheme === "exact" &&
      expectedAsset &&
      typeof a?.maxAmountRequired === "string" &&
      typeof a?.payTo === "string" &&
      a?.asset === expectedAsset
    ) {
      return {
        scheme: "exact",
        network,
        maxAmountRequired: a.maxAmountRequired as string,
        payTo: a.payTo as string,
        asset: a.asset as string,
        extra: a.extra as { feePayer?: string } | undefined,
      };
    }
  }
  return null;
}

export type SolanaSettleResult = {
  ok: true;
  txHash: string | null;
  amountUsdc: string;
  payTo: string;
  body: string;
};

export async function settleSolanaX402(opts: {
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
  /** Signed BRC-181 policy envelope. When present it ANDs with policy.json. */
  policyEnvelope?: PolicyEnvelope | null;
  /** Lifetime spend inside the envelope's own brc181-usdc-solana scope. */
  brc181SpentTotal?: number;
  origin?: string;
}): Promise<SolanaSettleResult> {
  const fetchFn = opts.fetchFn ?? fetch;

  const first = await fetchFn(opts.url);
  if (first.status !== 402) {
    throw new SolanaX402Error("NOT_GATED", `REJECTED: expected a 402 from ${opts.url}, got HTTP ${first.status}.`);
  }
  const body: unknown = await first.json();
  const req = pickExactSolanaUsdc(body);
  if (!req) {
    throw new SolanaX402Error(
      "UNSUPPORTED",
      "REJECTED: no acceptable requirement (scheme=exact, network=solana, asset=USDC) in the 402 response.",
    );
  }

  const amount = Number(req.maxAmountRequired);
  const decision = evaluateSolanaSend(opts.pocket, opts.killfileOn, amount, req.payTo, opts.usage);
  if (!decision.ok) throw new SolanaX402Error(decision.code, decision.message);

  // A signed BRC-181 envelope gates this rail too. Its numeric fields are read
  // in the rail's native units (USDC base units here); the merchant is the
  // feePayer, so the client-side fee is 0.
  let dest: string;
  try {
    dest = canonicalSolanaDest(req.payTo);
  } catch {
    throw new SolanaX402Error("BAD_ADDRESS", "REJECTED: USDC payee is not a valid Solana address.");
  }
  const gate = gateAgentSend({
    envelope: opts.policyEnvelope,
    dest,
    amount,
    fee: 0,
    spentTotal: opts.brc181SpentTotal ?? opts.usage.spentLifetime,
    origin: opts.origin,
  });
  if (!gate.ok) throw new SolanaX402Error(gate.code, gate.message);

  opts.beforeSign?.({ asset: "usdc-solana", amount, to: req.payTo });
  const header = await buildSolanaX402PaymentHeader({ key: opts.key, requirement: req, fetchFn });
  const paid = await fetchFn(opts.url, { headers: { "X-PAYMENT": header } });

  type SettlementReceipt = { success?: boolean; transaction?: string; txHash?: string; error?: string; errorReason?: string };
  let settle: SettlementReceipt | null = null;
  const settleHeader = paid.headers.get("X-PAYMENT-RESPONSE");
  if (settleHeader) {
    try {
      settle = JSON.parse(Buffer.from(settleHeader, "base64").toString("utf8")) as SettlementReceipt | null;
    } catch {
      settle = null;
    }
  }
  const txHash = settle?.transaction ?? settle?.txHash ?? null;
  if (opts.requireReceipt && (settle?.success !== true || typeof txHash !== "string" || !txHash)) {
    throw new SolanaX402Error("SETTLE_FAILED", "REJECTED: missing or invalid settlement receipt; hold retained.");
  }
  if (settle && settle.success === false) {
    throw new SolanaX402Error(
      "SETTLE_FAILED",
      `REJECTED: facilitator settlement failed: ${settle.errorReason ?? settle.error ?? "unknown error"}.`,
    );
  }
  if (paid.status >= 400) {
    throw new SolanaX402Error("SETTLE_FAILED", `REJECTED: merchant returned HTTP ${paid.status} after payment.`);
  }

  const text = await paid.text();
  opts.onSpend?.({
    t: new Date().toISOString(),
    kind: "send",
    asset: "usdc-solana",
    amount,
    to: req.payTo,
    txid: txHash,
    resource: opts.url,
  });
  return { ok: true, txHash, amountUsdc: req.maxAmountRequired, payTo: req.payTo, body: text };
}
