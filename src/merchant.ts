import { getAddress, recoverTypedDataAddress } from "viem";
import { createBsvMerchant } from "./merchant-bsv";
import { createSolanaMerchant, SolanaMerchantError } from "./merchant-solana";
import { evmTransferAuthorizationTypes, USDC_BASE, USDC_BASE_SEPOLIA } from "./evm";
import type { ReplayStore } from "./replay-store";
import type { PrivateKey } from "@bsv/sdk";

// The cash register: a Coinbase-x402 (`exact`) merchant endpoint that
// accepts USDC straight into the vault's EVM pocket. "Any coin in" starts
// here — revenue funds the float; no conversion needed. Settlement goes
// through a configured facilitator (x402.org testnet facilitator, or
// Coinbase CDP for mainnet).

export class MerchantError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MerchantError";
    this.code = code;
  }
}

const CHAIN_IDS: Record<string, number> = { base: 8453, "base-sepolia": 84532 };

export type MerchantConfig = {
  payTo: string;
  priceBaseUnits: number;
  resourcePath: string;
  facilitatorUrl: string;
  network: string;
  facilitatorFetch?: typeof fetch;
  bsvPayTo?: string;
  bsvSatoshis?: number;
  fetchFn?: typeof fetch;
  replayStore?: ReplayStore;
  /** Local self-facilitation: settle mainnet USDC ourselves instead of calling
   *  a hosted facilitator. Local runs only — keys never leave this machine. */
  settleFn?: (payment: unknown, requirement: PaymentRequirement) => Promise<{ success: boolean; txHash?: string | null; errorReason?: string }>;
  /** Local Solana self-facilitation (fee payer = vault-derived key). Omit on fly. */
  solanaPayTo?: string;
  solanaNetwork?: string;
  solanaFeePayerKey?: PrivateKey;
  solanaRpcUrl?: string;
  solanaConfirmTries?: number;
  solanaConfirmDelayMs?: number;
};

export type PaymentRequirement = {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { name: string; version: string };
};

export function buildUsdcRequirement(cfg: MerchantConfig, baseUrl: string): PaymentRequirement {
  return {
    scheme: "exact",
    network: cfg.network,
    maxAmountRequired: String(cfg.priceBaseUnits),
    resource: `${baseUrl.replace(/\/$/, "")}${cfg.resourcePath}`,
    description: "Dogfood paid endpoint",
    mimeType: "application/json",
    payTo: getAddress(cfg.payTo),
    maxTimeoutSeconds: 60,
    asset: cfg.network === "base" ? USDC_BASE : USDC_BASE_SEPOLIA,
    extra: { name: cfg.network === "base" ? "USD Coin" : "USDC", version: "2" },
  };
}

export type PaymentPayload = {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
};

export function parsePaymentHeader(header: string): PaymentPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new MerchantError("BAD_HEADER", "X-PAYMENT is not base64 JSON.");
  }
  const p = parsed as PaymentPayload;
  if (!p || typeof p !== "object" || !p.payload?.authorization || typeof p.payload.signature !== "string") {
    throw new MerchantError("BAD_HEADER", "X-PAYMENT is missing payload.authorization.");
  }
  return p;
}

export type VerifyResult = { ok: true; payer: string } | { ok: false; reason: string };

export async function verifyPayment(
  payment: PaymentPayload,
  requirement: PaymentRequirement,
  opts: { now?: number } = {},
): Promise<VerifyResult> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (payment.x402Version !== 1 || payment.scheme !== "exact") return { ok: false, reason: "unsupported scheme" };
  if (payment.network !== requirement.network) return { ok: false, reason: "wrong network" };
  const a = payment.payload.authorization;
  let to: string;
  try {
    to = getAddress(a.to);
  } catch {
    return { ok: false, reason: "bad payee address" };
  }
  if (to !== getAddress(requirement.payTo)) return { ok: false, reason: "payee mismatch" };
  if (BigInt(a.value) < BigInt(requirement.maxAmountRequired)) return { ok: false, reason: "underpaid" };
  if (BigInt(a.validBefore) <= BigInt(now)) return { ok: false, reason: "authorization expired" };
  if (BigInt(a.validAfter) > BigInt(now)) return { ok: false, reason: "authorization not yet valid" };

  const chainId = CHAIN_IDS[requirement.network];
  if (!chainId) return { ok: false, reason: "unknown network" };
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: requirement.extra.name,
        version: requirement.extra.version,
        chainId,
        verifyingContract: getAddress(requirement.asset),
      },
      types: evmTransferAuthorizationTypes(),
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(a.from),
        to,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce as `0x${string}`,
      },
      signature: payment.payload.signature as `0x${string}`,
    });
  } catch {
    return { ok: false, reason: "bad signature encoding" };
  }
  if (recovered.toLowerCase() !== a.from.toLowerCase()) return { ok: false, reason: "signature mismatch" };
  return { ok: true, payer: getAddress(a.from) };
}

const FORTUNES = [
  "The cheap rail wins in the end.",
  "Any coin in. BSV inside.",
  "Agents pay agents; the ledger remembers.",
  "Sub-cent is a moat.",
  "Floats stay small; volume stays high.",
  "You just paid $0.001 for this sentence.",
];

export function createMerchantApp(cfg: MerchantConfig): (req: Request) => Promise<Response> {
  const bsv = createBsvMerchant(cfg);
  const sol = createSolanaMerchant({
    solanaPayTo: cfg.solanaPayTo,
    solanaNetwork: cfg.solanaNetwork,
    solanaFeePayerKey: cfg.solanaFeePayerKey,
    solanaRpcUrl: cfg.solanaRpcUrl,
    fetchFn: cfg.fetchFn,
    replayStore: cfg.replayStore,
    priceBaseUnits: cfg.priceBaseUnits,
    solanaConfirmTries: cfg.solanaConfirmTries,
    solanaConfirmDelayMs: cfg.solanaConfirmDelayMs,
  });
  const facilitatorFetch = cfg.facilitatorFetch ?? fetch;
  const seenNonces = new Set<string>(); // fast-path replay guard; the USDC contract is the hard guard

  function paymentRequired(baseUrl: string, error?: string): Response {
    return Response.json(
      { x402Version: 1, error: error ?? "Payment required", accepts: [buildUsdcRequirement(cfg, baseUrl), ...(bsv ? [bsv.requirement] : []), ...(sol ? [sol.requirement] : [])] },
      { status: 402, headers: bsv ? {
        "x-bsv-payment-satoshis-required": String(bsv.requirement.satoshis),
        "x-bsv-payment-address": bsv.requirement.payTo,
      } : {} },
    );
  }

  return async (req: Request) => {
    const url = new URL(req.url);
    const baseUrl = `${url.protocol}//${url.host}`;
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, role: "dogfood-merchant", network: cfg.network, payTo: cfg.payTo });
    }
    if (req.method !== "GET" || url.pathname !== cfg.resourcePath) {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    const bsvHeader = req.headers.get("X-BSV-PAYMENT");
    if (bsvHeader !== null) {
      if (!bsv) return paymentRequired(baseUrl, "BSV payments are not enabled");
      try {
        const txid = await bsv.settle(bsvHeader);
        const receipt = Buffer.from(JSON.stringify({ success: true, transaction: txid, network: "bsv-main" })).toString("base64");
        return Response.json(
          { fortune: FORTUNES[Math.floor(Math.random() * FORTUNES.length)], price: bsv.requirement.satoshis, asset: "BSV" },
          { status: 200, headers: { "X-PAYMENT-RESPONSE": receipt } },
        );
      } catch (err) {
        return paymentRequired(baseUrl, `BSV payment invalid: ${err instanceof Error ? err.message : "settlement failed"}`);
      }
    }

    const header = req.headers.get("X-PAYMENT");
    if (!header) return paymentRequired(baseUrl);

    // Solana payments carry a partially-signed transaction, not an EIP-712 sig.
    // (The header is base64 — decode before sniffing the shape.)
    let isSolanaPayment = false;
    try {
      const peek = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload?: { transaction?: unknown } };
      isSolanaPayment = typeof peek?.payload?.transaction === "string";
    } catch { /* not JSON — fall through to the EVM parser, which will reject it */ }
    if (isSolanaPayment) {
      if (!sol) return paymentRequired(baseUrl, "Solana payments are not enabled");
      try {
        const signature = await sol.settle(header);
        const receipt = Buffer.from(
          JSON.stringify({ success: true, transaction: signature, network: sol.requirement.network }),
        ).toString("base64");
        return Response.json(
          { fortune: FORTUNES[Math.floor(Math.random() * FORTUNES.length)], price: cfg.priceBaseUnits, asset: "USDC" },
          { status: 200, headers: { "X-PAYMENT-RESPONSE": receipt } },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "settlement failed";
        const prefix = err instanceof SolanaMerchantError && err.kind === "SETTLE" ? "Settlement failed" : "Solana payment invalid";
        return paymentRequired(baseUrl, `${prefix}: ${msg}`);
      }
    }

    let payment: PaymentPayload;
    try {
      payment = parsePaymentHeader(header);
    } catch (err) {
      return paymentRequired(baseUrl, err instanceof MerchantError ? err.message : "bad X-PAYMENT");
    }
    const requirement = buildUsdcRequirement(cfg, baseUrl);
    const verdict = await verifyPayment(payment, requirement);
    if (!verdict.ok) return paymentRequired(baseUrl, `Payment invalid: ${verdict.reason}`);

    const nonceKey = `${verdict.payer.toLowerCase()}:${payment.payload.authorization.nonce.toLowerCase()}`;
    if (seenNonces.has(nonceKey)) return paymentRequired(baseUrl, "Payment invalid: nonce already used");

    let settled: { success: boolean; txHash?: string | null; errorReason?: string };
    if (cfg.settleFn) {
      try {
        settled = await cfg.settleFn(payment, requirement);
      } catch (err) {
        settled = { success: false, errorReason: err instanceof Error ? err.message : "settle failed" };
      }
    } else {
      const settleRes = await facilitatorFetch(`${cfg.facilitatorUrl.replace(/\/$/, "")}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 1, paymentPayload: payment, paymentRequirements: requirement }),
      });
      const settleBody = (await settleRes.json().catch(() => ({}))) as {
        success?: boolean;
        transaction?: string;
        txHash?: string;
        error?: string;
        errorReason?: string;
      };
      settled = {
        success: settleRes.ok && settleBody.success === true,
        txHash: settleBody.transaction ?? settleBody.txHash ?? null,
        errorReason: settleBody.errorReason ?? settleBody.error ?? `HTTP ${settleRes.status}`,
      };
    }
    if (!settled.success) {
      return paymentRequired(baseUrl, `Settlement failed: ${settled.errorReason ?? "unknown"}`);
    }
    seenNonces.add(nonceKey);

    const fortune = FORTUNES[Math.floor(Math.random() * FORTUNES.length)];
    const receipt = Buffer.from(
      JSON.stringify({
        success: true,
        transaction: settled.txHash ?? null,
        network: cfg.network,
        payer: verdict.payer,
      }),
    ).toString("base64");
    return Response.json(
      { fortune, price: cfg.priceBaseUnits, asset: "USDC" },
      { status: 200, headers: { "X-PAYMENT-RESPONSE": receipt } },
    );
  };
}
