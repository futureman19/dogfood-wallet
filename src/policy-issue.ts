import { randomBytes } from "node:crypto";
import {canonicalBtcDest} from './btc-address';
import { closeSync, existsSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import type { PrivateKey } from "@bsv/sdk";
import { POLICY_TYPE, canonicalPayloadBytes, type PolicyEnvelope } from "./brc181";
import { vaultPaths } from "./vault";

// Owner-side BRC-181 envelope issuer. Human-only CLI (`policy-issue`): mints a
// signed agent policy envelope and optionally installs it as the vault's
// brc181.json. Once installed it ANDs with policy.json on every payment rail.
// This command never runs over MCP.

export type PolicyIssueOptions = {
  origin: string;
  perTxCap: number;
  totalBudget: number;
  maxFee: number;
  purpose: string;
  allowlist: string[];
  destCaps: Array<[string, number]>;
  /** epoch seconds; 0 = no expiry (this implementation does not evaluate expiry) */
  expiryEpoch?: number;
  /** epoch seconds; default now. Injectable for tests. */
  now?: number;
  /** hex nonce; default random. Injectable for tests. */
  nonce?: string;
};

const DEST_PATTERNS: Record<string, RegExp> = {
  "p2pkh:": /^p2pkh:[0-9a-f]{40}$/,
  "script:": /^script:[0-9a-f]{64}$/,
  "evm:": /^evm:0x[0-9a-f]{40}$/,
  "solana:": /^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

/** Strict validation of a prefixed canonical destination. No raw-address
 *  guessing: a base58 string is ambiguous between chains, so callers must say
 *  `p2pkh:` / `script:` / `evm:` / `solana:` explicitly. EVM dests must be
 *  lowercase — that is the canonical form the gate computes. */
export function validateCanonicalDest(dest: string): string {
  if(dest.startsWith('btc:')) {
    if(canonicalBtcDest(dest.slice(4))!==dest)throw Error('BAD_DEST: BTC destination must be canonical.');
    return dest;
  }
  for (const [prefix, pattern] of Object.entries(DEST_PATTERNS)) {
    if (dest.startsWith(prefix)) {
      if (!pattern.test(dest)) throw new Error(`BAD_DEST: malformed ${prefix} destination.`);
      return dest;
    }
  }
  throw new Error("BAD_DEST: destination must start with p2pkh: / script: / evm: / solana: / btc:.");
}

function safeNonNegative(n: number, name: string): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`BAD_NUMBER: ${name} must be a non-negative safe integer.`);
  return n;
}

export function buildPolicyPayload(opts: {
  issuer: string;
  origin: string;
  perTxCap: number;
  totalBudget: number;
  maxFee: number;
  purpose: string;
  allowlist: string[];
  destCaps: Array<[string, number]>;
  expiryEpoch?: number;
  now?: number;
  nonce?: string;
}): Record<string, unknown> {
  const origin = opts.origin.trim();
  const purpose = opts.purpose.trim();
  if (!origin) throw new Error("BAD_ORIGIN: origin token must be non-empty.");
  if (!purpose) throw new Error("BAD_PURPOSE: purpose must be non-empty.");
  const perTxCap = safeNonNegative(opts.perTxCap, "per-tx cap");
  const totalBudget = safeNonNegative(opts.totalBudget, "total budget");
  const maxFee = safeNonNegative(opts.maxFee, "max fee");
  const expiryEpoch = safeNonNegative(opts.expiryEpoch ?? 0, "expiry");
  const allowlist = opts.allowlist.map((d) => validateCanonicalDest(d));
  const destCaps = opts.destCaps.map(([d, n]) => {
    if (n === undefined) throw new Error("BAD_DEST_CAP: expected dest=amount.");
    return [validateCanonicalDest(d), safeNonNegative(n, "dest cap")] as [string, number];
  });
  return {
    account_id: 0,
    can_create_children: false,
    cb_burst_per_s: 0,
    cb_max_new_dests: 0,
    child_budget_ceiling: 0,
    delegation_depth: 0,
    dest_allowlist: allowlist,
    dest_caps: destCaps,
    escalate_off_allowlist: false,
    escalate_over_per_tx: false,
    expiry_epoch: expiryEpoch,
    issued_at: opts.now ?? Math.floor(Date.now() / 1000),
    issuer: opts.issuer,
    max_fee: maxFee,
    nonce: opts.nonce ?? randomBytes(8).toString("hex"),
    origin_token: origin,
    per_tx_cap: perTxCap,
    period_cap: totalBudget,
    period_window_s: 3600,
    purpose,
    rate_limit: totalBudget,
    rate_window_s: 60,
    total_budget: totalBudget,
    type: POLICY_TYPE,
  };
}

/** Mint a signed envelope. The vault key is the issuer (owner identity). */
export function issuePolicyEnvelope(key: PrivateKey, opts: PolicyIssueOptions): PolicyEnvelope {
  const payload = buildPolicyPayload({ issuer: key.toPublicKey().toString(), ...opts });
  const sig = key.sign(Array.from(canonicalPayloadBytes(payload)));
  return {
    payload,
    sig: {
      alg: "ECDSA-SHA256-secp256k1",
      issuer: key.toPublicKey().toString(),
      signature: Buffer.from(sig.toDER()).toString("hex"),
    },
  };
}

/** Install the envelope as the vault's brc181.json. Refuses to clobber an
 *  existing installed policy unless forced — replacing a signed policy is a
 *  deliberate owner act. */
export function writePolicyEnvelope(root: string, envelope: PolicyEnvelope, opts: { force?: boolean } = {}): void {
  const path = vaultPaths(root).brc181;
  if (existsSync(path) && !opts.force) {
    throw new Error("REJECTED: brc181.json already exists; pass --force to replace the installed policy envelope.");
  }
  const fd = openSync(path, "w");
  try {
    writeFileSync(fd, JSON.stringify(envelope, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export type PolicyIssueFlags = PolicyIssueOptions & { write: boolean; force: boolean };

export function parsePolicyIssueFlags(
  args: string[],
): { ok: true; value: PolicyIssueFlags } | { ok: false; message: string } {
  const out: {
    origin?: string; perTxCap?: number; totalBudget?: number; maxFee?: number; purpose?: string;
    allowlist: string[]; destCaps: Array<[string, number]>; expiryEpoch?: number; write: boolean; force: boolean;
  } = { allowlist: [], destCaps: [], write: false, force: false };
  const VALUE_FLAGS = new Set(["--origin", "--per-tx", "--total", "--max-fee", "--purpose", "--allow", "--dest-cap", "--expires"]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--write") { out.write = true; continue; }
    if (flag === "--force") { out.force = true; continue; }
    if (!VALUE_FLAGS.has(flag)) return { ok: false, message: `REJECTED: unknown flag ${flag}.` };
    const value = args[++i];
    if (value === undefined) return { ok: false, message: `REJECTED: ${flag} needs a value.` };
    const num = (name: string): number | null => {
      const n = Number(value);
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    };
    switch (flag) {
      case "--origin": out.origin = value; break;
      case "--purpose": out.purpose = value; break;
      case "--allow": out.allowlist.push(value); break;
      case "--dest-cap": {
        const eq = value.indexOf("=");
        if (eq < 1) return { ok: false, message: "REJECTED: --dest-cap expects dest=amount." };
        const n = Number(value.slice(eq + 1));
        if (!Number.isSafeInteger(n) || n < 0) return { ok: false, message: "REJECTED: --dest-cap amount must be a non-negative integer." };
        out.destCaps.push([value.slice(0, eq), n]);
        break;
      }
      case "--per-tx": { const n = num("per-tx"); if (n === null) return { ok: false, message: "REJECTED: --per-tx must be a non-negative integer." }; out.perTxCap = n; break; }
      case "--total": { const n = num("total"); if (n === null) return { ok: false, message: "REJECTED: --total must be a non-negative integer." }; out.totalBudget = n; break; }
      case "--max-fee": { const n = num("max-fee"); if (n === null) return { ok: false, message: "REJECTED: --max-fee must be a non-negative integer." }; out.maxFee = n; break; }
      case "--expires": { const n = num("expires"); if (n === null) return { ok: false, message: "REJECTED: --expires must be a non-negative epoch." }; out.expiryEpoch = n; break; }
    }
  }
  if (!out.origin?.trim()) return { ok: false, message: "REJECTED: --origin is required." };
  if (!out.purpose?.trim()) return { ok: false, message: "REJECTED: --purpose is required." };
  if (out.perTxCap === undefined) return { ok: false, message: "REJECTED: --per-tx is required." };
  if (out.totalBudget === undefined) return { ok: false, message: "REJECTED: --total is required." };
  if (out.maxFee === undefined) return { ok: false, message: "REJECTED: --max-fee is required." };
  return {
    ok: true,
    value: {
      origin: out.origin,
      purpose: out.purpose,
      perTxCap: out.perTxCap,
      totalBudget: out.totalBudget,
      maxFee: out.maxFee,
      allowlist: out.allowlist,
      destCaps: out.destCaps,
      expiryEpoch: out.expiryEpoch,
      write: out.write,
      force: out.force,
    },
  };
}
