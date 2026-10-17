import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { P2PKH, PublicKey, Signature } from "@bsv/sdk";

export const POLICY_TYPE = "brc-181/agent-policy/1";

const MUST_FIELDS = [
  "account_id",
  "can_create_children",
  "cb_burst_per_s",
  "cb_max_new_dests",
  "child_budget_ceiling",
  "delegation_depth",
  "dest_allowlist",
  "dest_caps",
  "escalate_off_allowlist",
  "escalate_over_per_tx",
  "expiry_epoch",
  "issued_at",
  "issuer",
  "max_fee",
  "nonce",
  "origin_token",
  "per_tx_cap",
  "period_cap",
  "period_window_s",
  "purpose",
  "rate_limit",
  "rate_window_s",
  "total_budget",
  "type",
] as const;

export type PolicyVerdict = { verdict: "ALLOW_AUTO" | "REJECT"; reason?: string };

function scriptBytes(lockingScriptHex: string): Buffer {
  const hex = lockingScriptHex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("BAD_SCRIPT");
  return Buffer.from(hex, "hex");
}

export function canonicalDest(lockingScriptHex: string): string | null {
  const b = scriptBytes(lockingScriptHex);
  if (b.length >= 1 && b[0] === 0x6a) return null;
  if (b.length >= 2 && b[0] === 0x00 && b[1] === 0x6a) return null;
  if (
    b.length === 25 &&
    b[0] === 0x76 &&
    b[1] === 0xa9 &&
    b[2] === 0x14 &&
    b[23] === 0x88 &&
    b[24] === 0xac
  ) {
    return `p2pkh:${b.subarray(3, 23).toString("hex")}`;
  }
  return `script:${createHash("sha256").update(b).digest("hex")}`;
}

/** Canonical envelope destination for an EVM payee: evm:<lowercase address>. */
export function canonicalEvmDest(address: string): string {
  const a = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error("BAD_ADDRESS");
  return `evm:${a.toLowerCase()}`;
}

/** Canonical envelope destination for a Solana payee: solana:<base58 address>. */
export function canonicalSolanaDest(address: string): string {
  const a = address.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) throw new Error("BAD_ADDRESS");
  return `solana:${a}`;
}

function assertExactFields(payload: Record<string, unknown>): void {
  const keys = Object.keys(payload);
  if (keys.length !== MUST_FIELDS.length || MUST_FIELDS.some((k) => !(k in payload))) {
    throw new Error("BAD_FIELDS");
  }
  for (const k of keys) {
    if (!(MUST_FIELDS as readonly string[]).includes(k)) throw new Error("BAD_FIELDS");
  }
}

export function canonicalPayloadBytes(payload: Record<string, unknown>): Uint8Array {
  assertExactFields(payload);
  if (payload.type !== POLICY_TYPE) throw new Error("BAD_TYPE");
  const dests = Array.isArray(payload.dest_allowlist)
    ? [...(payload.dest_allowlist as string[])].sort()
    : [];
  const caps = Array.isArray(payload.dest_caps)
    ? [...(payload.dest_caps as Array<[string, number]>)].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    : [];
  const ordered: Record<string, unknown> = {};
  for (const k of [...MUST_FIELDS].sort()) {
    if (k === "dest_allowlist") ordered[k] = dests;
    else if (k === "dest_caps") ordered[k] = caps;
    else ordered[k] = payload[k];
  }
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

export function payloadDigest(payload: Record<string, unknown>): string {
  return createHash("sha256").update(Buffer.from(canonicalPayloadBytes(payload))).digest("hex");
}

export function verifyPolicyEnvelope(env: {
  payload: Record<string, unknown>;
  sig: { alg: string; issuer: string; signature: string };
}): { ok: true } | { ok: false; code: string; message: string } {
  try {
    if (env.sig.alg !== "ECDSA-SHA256-secp256k1") {
      return { ok: false, code: "BAD_SIG", message: "REJECTED: Unsupported policy signature algorithm." };
    }
    if (String(env.payload.issuer).toLowerCase() !== env.sig.issuer.toLowerCase()) {
      return { ok: false, code: "BAD_SIG", message: "REJECTED: Envelope issuer does not match payload.issuer." };
    }
    const C = canonicalPayloadBytes(env.payload);
    const pub = PublicKey.fromString(env.sig.issuer);
    const sig = Signature.fromDER(Array.from(Buffer.from(env.sig.signature, "hex")));
    const ok = pub.verify(Array.from(C), sig);
    if (!ok) return { ok: false, code: "BAD_SIG", message: "REJECTED: Policy signature is invalid." };
    return { ok: true };
  } catch {
    return { ok: false, code: "BAD_SIG", message: "REJECTED: Policy signature is invalid." };
  }
}

export function evaluatePolicyRequest(
  payload: Record<string, unknown>,
  req: { origin: string; payout: number; lockingScriptHex: string; fee: number; spentTotal: number },
): PolicyVerdict {
  assertExactFields(payload);
  return evaluateCore(payload, req, () => canonicalDest(req.lockingScriptHex));
}

/** Multi-chain form: the caller supplies the pre-canonical destination
 *  (p2pkh:… / script:… / evm:… / solana:…). Numeric envelope fields are
 *  interpreted in the native units of the asset being spent — sats on BSV,
 *  USDC base units on the dollar rails. No price conversion. */
export function evaluatePolicyDest(
  payload: Record<string, unknown>,
  req: { origin: string; payout: number; dest: string | null; fee: number; spentTotal: number },
): PolicyVerdict {
  assertExactFields(payload);
  return evaluateCore(payload, req, () => req.dest);
}

function evaluateCore(
  payload: Record<string, unknown>,
  req: { origin: string; payout: number; fee: number; spentTotal: number },
  destFn: () => string | null,
): PolicyVerdict {
  if (payload.type !== POLICY_TYPE) return { verdict: "REJECT", reason: "unrecognized policy type" };
  if (req.origin !== payload.origin_token) return { verdict: "REJECT", reason: "origin not bound" };
  const maxFee = payload.max_fee as number;
  if (req.fee > maxFee) return { verdict: "REJECT", reason: "over max fee" };
  const perTx = payload.per_tx_cap as number;
  if (req.payout > perTx) return { verdict: "REJECT", reason: "over per-tx cap" };
  const dest = destFn();
  const allow = payload.dest_allowlist as string[];
  const caps = payload.dest_caps as Array<[string, number]>;
  const capEntry = dest ? caps.find((c) => c[0] === dest) : undefined;
  if (dest && !allow.includes(dest) && !capEntry) {
    return { verdict: "REJECT", reason: "off-allowlist destination(s)" };
  }
  if (capEntry && req.payout > capEntry[1]) {
    return { verdict: "REJECT", reason: "over per-destination cap" };
  }
  const totalBudget = payload.total_budget as number;
  if (req.spentTotal + req.payout + req.fee > totalBudget) {
    return { verdict: "REJECT", reason: "over total budget" };
  }
  return { verdict: "ALLOW_AUTO" };
}

export type PolicyEnvelope = {
  payload: Record<string, unknown>;
  sig: { alg: string; issuer: string; signature: string };
};

export function gateAgentSend(opts: {
  envelope: PolicyEnvelope | null | undefined;
  to?: string;
  lockingScriptHex?: string;
  /** Pre-canonical destination for non-BSV rails ("evm:…" / "solana:…").
   *  When given, no BSV address or locking script is required. */
  dest?: string;
  amount: number;
  fee: number;
  spentTotal: number;
  origin?: string;
}): { ok: true } | { ok: false; code: string; message: string } {
  if (!opts.envelope) return { ok: true };
  const verified = verifyPolicyEnvelope(opts.envelope);
  if (!verified.ok) return verified;
  let dest: string | null;
  if (opts.dest !== undefined) {
    dest = opts.dest;
  } else {
    let lockingScriptHex = opts.lockingScriptHex;
    if (!lockingScriptHex) {
      if (!opts.to) return { ok: false, code: "BAD_ADDRESS", message: "REJECTED: Destination is missing." };
      try {
        lockingScriptHex = new P2PKH().lock(opts.to).toHex();
      } catch {
        return { ok: false, code: "BAD_ADDRESS", message: "REJECTED: Destination is not a P2PKH address." };
      }
    }
    dest = canonicalDest(lockingScriptHex);
  }
  const origin =
    opts.origin ?? process.env.DOGFOOD_ORIGIN_TOKEN ?? String(opts.envelope.payload.origin_token ?? "");
  const verdict = evaluatePolicyDest(opts.envelope.payload, {
    origin,
    payout: opts.amount,
    dest,
    fee: opts.fee,
    spentTotal: opts.spentTotal,
  });
  if (verdict.verdict !== "ALLOW_AUTO") {
    return { ok: false, code: "POLICY", message: `REJECTED: BRC-181 ${verdict.reason ?? "denied"}.` };
  }
  return { ok: true };
}

export function loadPolicyEnvelope(
  path: string,
): { ok: true; envelope: PolicyEnvelope | null } | { ok: false; code: string; message: string } {
  if (!existsSync(path)) return { ok: true, envelope: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PolicyEnvelope;
    if (!parsed?.payload || !parsed?.sig) {
      return { ok: false, code: "BAD_SIG", message: "REJECTED: brc181.json needs payload and sig." };
    }
    return { ok: true, envelope: parsed };
  } catch {
    return { ok: false, code: "BAD_SIG", message: "REJECTED: brc181.json is not valid JSON." };
  }
}
