import { createHash } from "node:crypto";
import { evaluateSend, type Policy, type Usage } from "./policy";

export type X402Challenge = {
  v: number;
  scheme: string;
  amount_sats: number;
  payee_locking_script_hex: string;
  expires_at: number;
  domain?: string;
  method?: string;
  path?: string;
  query?: string;
  req_headers_sha256?: string;
  req_body_sha256?: string;
  nonce_utxo?: {
    txid: string;
    vout: number;
    satoshis: number;
    locking_script_hex: string;
  };
  require_mempool_accept?: boolean;
};

export type X402Inspect =
  | {
      ok: true;
      amountSats: number;
      payeeAddress: string;
      scheme: string;
      expiresAt: number;
      challengeSha256: string;
    }
  | { ok: false; code: "EXPIRED" | "SCHEME" | "VERSION" | "BAD_PAYEE" | "BAD_CHALLENGE"; message: string };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    if (Number.isInteger(value)) return String(value);
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new Error("unsupported json value");
}

export function toBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

export function sha256Hex(buf: Buffer): string {
  return sha256(buf).toString("hex");
}

export function challengeSha256(challenge: unknown): string {
  return sha256Hex(Buffer.from(canonicalJson(challenge), "utf8"));
}

export function headerBindingSha256(bindingString: string): string {
  return sha256Hex(Buffer.from(bindingString, "utf8"));
}

export function bodySha256FromHex(bodyBytesHex: string): string {
  return sha256Hex(Buffer.from(bodyBytesHex, "hex"));
}

export function txidFromRawHex(rawtxHex: string): string {
  const raw = Buffer.from(rawtxHex, "hex");
  const d = sha256(sha256(raw));
  return Buffer.from(d).reverse().toString("hex");
}

export function decodeChallengeHeader(header: string): X402Challenge {
  const json = Buffer.from(header.trim(), "base64url").toString("utf8");
  const parsed = JSON.parse(json) as X402Challenge;
  if (typeof parsed !== "object" || parsed === null) throw new Error("invalid challenge");
  return parsed;
}

function base58Encode(bytes: Buffer): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  return "1".repeat(zeros) + s;
}

export function p2pkhAddressFromLock(hex: string): string | null {
  const h = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(h)) return null;
  if (h.length !== 50 || !h.startsWith("76a914") || !h.endsWith("88ac")) return null;
  const hash160 = Buffer.from(h.slice(6, 46), "hex");
  const payload = Buffer.concat([Buffer.from([0x00]), hash160]);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

export function inspectChallenge(challenge: X402Challenge, now: Date = new Date()): X402Inspect {
  if (challenge.v !== 1) {
    return { ok: false, code: "VERSION", message: "REJECTED: Unsupported x402 version." };
  }
  if (challenge.scheme !== "bsv-tx-v1") {
    return { ok: false, code: "SCHEME", message: "REJECTED: Unsupported x402 scheme (need bsv-tx-v1)." };
  }
  if (!Number.isInteger(challenge.amount_sats) || challenge.amount_sats <= 0) {
    return { ok: false, code: "BAD_CHALLENGE", message: "REJECTED: amount_sats is not a positive integer." };
  }
  const expiresAt = Number(challenge.expires_at);
  if (!Number.isFinite(expiresAt) || now.getTime() / 1000 > expiresAt) {
    return {
      ok: false,
      code: "EXPIRED",
      message: "REJECTED: x402 challenge expired.",
    };
  }
  const payeeAddress = p2pkhAddressFromLock(String(challenge.payee_locking_script_hex ?? ""));
  if (!payeeAddress) {
    return {
      ok: false,
      code: "BAD_PAYEE",
      message: "REJECTED: payee locking script is not P2PKH. Dogfood v0 only pays P2PKH.",
    };
  }
  return {
    ok: true,
    amountSats: challenge.amount_sats,
    payeeAddress,
    scheme: challenge.scheme,
    expiresAt,
    challengeSha256: challengeSha256(challenge),
  };
}

export function decideX402(
  policy: Policy,
  usage: Usage,
  challenge: X402Challenge,
  now: Date = new Date(),
): {
  ok: boolean;
  wouldPay: boolean;
  settle: "NOT_IMPLEMENTED";
  code?: string;
  message: string;
  inspect?: X402Inspect;
} {
  const inspect = inspectChallenge(challenge, now);
  if (!inspect.ok) {
    return { ok: false, wouldPay: false, settle: "NOT_IMPLEMENTED", code: inspect.code, message: inspect.message, inspect };
  }
  const decision = evaluateSend(policy, inspect.amountSats, inspect.payeeAddress, usage);
  if (!decision.ok) {
    return {
      ok: false,
      wouldPay: false,
      settle: "NOT_IMPLEMENTED",
      code: decision.code,
      message: decision.message,
      inspect,
    };
  }
  return {
    ok: true,
    wouldPay: true,
    settle: "NOT_IMPLEMENTED",
    message:
      "Policy would allow this x402 pay. Settlement is not implemented: the challenge nonce UTXO must be spent, which needs the merchant delegator.",
    inspect,
  };
}
