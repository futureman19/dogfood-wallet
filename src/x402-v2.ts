import { USDC_BASE, USDC_BASE_SEPOLIA } from "./evm";

// Coinbase / x402-foundation x402 v2 (CAIP-2) client dialect.
// HTTP: PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE (base64 JSON).
// This module is parse/select/wrap only — EIP-3009 signing stays in src/evm.ts.

export const V2_CAIP_BASE = "eip155:8453";
export const V2_CAIP_BASE_SEPOLIA = "eip155:84532";

const USDC_BY_CAIP: Record<string, string> = {
  [V2_CAIP_BASE]: USDC_BASE,
  [V2_CAIP_BASE_SEPOLIA]: USDC_BASE_SEPOLIA,
};

export type HeaderBag =
  | { get(name: string): string | null }
  | Record<string, string | undefined>
  | null
  | undefined;

export type V2PaymentRequirements = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
};

export type V2SignatureBundle = {
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

export type V2PaymentPayload = {
  x402Version: 2;
  resource: unknown;
  accepted: unknown;
  payload: V2SignatureBundle;
  extensions?: unknown;
};

export type V2SettleParsed = {
  success: boolean;
  txHash: string | null;
  errorReason?: string;
  network?: string;
  payer?: string;
};

function getHeader(headers: HeaderBag, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name);
  }
  const rec = headers as Record<string, string | undefined>;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === want && typeof v === "string") return v;
  }
  return null;
}

function decodeJsonB64(raw: string): unknown {
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function isV2Object(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const v = (value as { x402Version?: unknown }).x402Version;
  return v === 2 || v === "2";
}

/** Header is canonical; fall back to JSON body. */
export function readV2PaymentRequired(headers: HeaderBag, body: unknown): Record<string, unknown> | null {
  const raw = getHeader(headers, "PAYMENT-REQUIRED");
  if (raw) {
    const decoded = decodeJsonB64(raw);
    if (isV2Object(decoded)) return decoded;
  }
  if (isV2Object(body)) return body;
  return null;
}

export function isV2PaymentRequired(headers: HeaderBag, body: unknown): boolean {
  return readV2PaymentRequired(headers, body) !== null;
}

function paymentFlowOf(entry: Record<string, unknown>): string | undefined {
  const extra = entry.extra;
  if (!extra || typeof extra !== "object") return undefined;
  const flow = (extra as { paymentFlow?: unknown }).paymentFlow;
  return typeof flow === "string" ? flow : undefined;
}

export function pickV2ExactEvm(paymentRequired: unknown): V2PaymentRequirements | null {
  const accepts = (paymentRequired as { accepts?: unknown })?.accepts;
  if (!Array.isArray(accepts)) return null;
  const eligible: Record<string, unknown>[] = [];
  for (const item of accepts) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (a.scheme !== "exact") continue;
    if (typeof a.network !== "string") continue;
    const expectedAsset = USDC_BY_CAIP[a.network];
    if (!expectedAsset) continue;
    if (typeof a.asset !== "string" || a.asset.toLowerCase() !== expectedAsset.toLowerCase()) continue;
    const flow = paymentFlowOf(a);
    if (flow !== undefined && flow !== "authorization") continue;
    if (typeof a.amount !== "string" || !/^\d+$/.test(a.amount) || !Number.isSafeInteger(Number(a.amount))) {
      throw new Error("BAD_REQUIREMENT: malformed amount");
    }
    if (typeof a.payTo !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a.payTo)) {
      throw new Error("BAD_ADDRESS: malformed payTo");
    }
    eligible.push(a);
  }
  const preferred = eligible.filter((a) => paymentFlowOf(a) === "authorization");
  const chosen = preferred[0] ?? eligible[0];
  return (chosen as V2PaymentRequirements | undefined) ?? null;
}

export function buildV2PaymentPayload(
  requirements: unknown,
  resource: unknown,
  extensions: unknown,
  signatureBundle: V2SignatureBundle,
): V2PaymentPayload {
  const payload: V2PaymentPayload = {
    x402Version: 2,
    resource,
    accepted: requirements,
    payload: {
      signature: signatureBundle.signature,
      authorization: signatureBundle.authorization,
    },
  };
  if (extensions !== undefined && extensions !== null) payload.extensions = extensions;
  return payload;
}

export function parseV2SettleResponse(headers: HeaderBag, body: unknown): V2SettleParsed | null {
  const raw = getHeader(headers, "PAYMENT-RESPONSE");
  let obj: unknown;
  if (raw) {
    obj = decodeJsonB64(raw);
  } else if (body && typeof body === "object" && body !== null && "paymentResponse" in body) {
    obj = (body as { paymentResponse: unknown }).paymentResponse;
  } else {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const tx = typeof o.transaction === "string" && o.transaction.length > 0 ? o.transaction : null;
  return {
    success: o.success === true,
    txHash: tx,
    errorReason: typeof o.errorReason === "string" ? o.errorReason : undefined,
    network: typeof o.network === "string" ? o.network : undefined,
    payer: typeof o.payer === "string" ? o.payer : undefined,
  };
}

export function caipToV1Network(network: string): "base" | "base-sepolia" {
  return network === V2_CAIP_BASE_SEPOLIA ? "base-sepolia" : "base";
}
