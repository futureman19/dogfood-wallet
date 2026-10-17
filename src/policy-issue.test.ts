import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import {
  buildPolicyPayload,
  issuePolicyEnvelope,
  parsePolicyIssueFlags,
  validateCanonicalDest,
  writePolicyEnvelope,
} from "./policy-issue";
import { verifyPolicyEnvelope, gateAgentSend, POLICY_TYPE } from "./brc181";

const KEY = PrivateKey.fromHex("1".padStart(64, "0"));
const ISSUER = KEY.toPublicKey().toString();
const EVM_DEST = "evm:0x" + "42".repeat(20);
const SOL_DEST = "solana:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const P2PKH_DEST = "p2pkh:" + "11".repeat(20);
const SCRIPT_DEST = "script:" + "aa".repeat(32);

const BASE_OPTS = {
  origin: "owner-console",
  perTxCap: 100,
  totalBudget: 1_000,
  maxFee: 50,
  purpose: "test allowance",
  allowlist: [] as string[],
  destCaps: [] as Array<[string, number]>,
};

describe("validateCanonicalDest", () => {
  test("accepts the four prefixed canonical forms", () => {
    expect(validateCanonicalDest(P2PKH_DEST)).toBe(P2PKH_DEST);
    expect(validateCanonicalDest(SCRIPT_DEST)).toBe(SCRIPT_DEST);
    expect(validateCanonicalDest(EVM_DEST)).toBe(EVM_DEST);
    expect(validateCanonicalDest(SOL_DEST)).toBe(SOL_DEST);
  });

  test("rejects unprefixed, malformed, or non-canonical destinations", () => {
    for (const bad of [
      "",
      "0x" + "42".repeat(20), // raw EVM address: no guessing, prefix required
      "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", // raw BSV address: prefix required
      "p2pkh:zz",
      "script:aa",
      "evm:0x" + "AB".repeat(20), // mixed case is not the canonical form
      "solana:short",
      "solana:0O" + "1".repeat(42),
      "bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    ]) {
      expect(() => validateCanonicalDest(bad)).toThrow();
    }
  });
});

describe("buildPolicyPayload", () => {
  test("emits exactly the 24 envelope fields with neutral delegation/rate defaults", () => {
    const p = buildPolicyPayload({ issuer: ISSUER, ...BASE_OPTS, now: 1_700_000_000, nonce: "a1b2c3d4e5f60718" });
    expect(Object.keys(p)).toHaveLength(24);
    expect(p.type).toBe(POLICY_TYPE);
    expect(p.issuer).toBe(ISSUER);
    expect(p.origin_token).toBe("owner-console");
    expect(p.per_tx_cap).toBe(100);
    expect(p.total_budget).toBe(1_000);
    expect(p.max_fee).toBe(50);
    expect(p.issued_at).toBe(1_700_000_000);
    expect(p.nonce).toBe("a1b2c3d4e5f60718");
    expect(p.expiry_epoch).toBe(0);
    expect(p.dest_allowlist).toEqual([]);
    expect(p.dest_caps).toEqual([]);
    // Fields this implementation never relaxes: no children, no escalation.
    expect(p.can_create_children).toBe(false);
    expect(p.delegation_depth).toBe(0);
    expect(p.escalate_off_allowlist).toBe(false);
    expect(p.escalate_over_per_tx).toBe(false);
  });

  test("numeric caps must be safe non-negative integers", () => {
    expect(() => buildPolicyPayload({ issuer: ISSUER, ...BASE_OPTS, perTxCap: -1 })).toThrow();
    expect(() => buildPolicyPayload({ issuer: ISSUER, ...BASE_OPTS, perTxCap: 1.5 })).toThrow();
    expect(() => buildPolicyPayload({ issuer: ISSUER, ...BASE_OPTS, totalBudget: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => buildPolicyPayload({ issuer: ISSUER, ...BASE_OPTS, maxFee: Number.NaN })).toThrow();
  });

  test("origin and purpose must be non-empty", () => {
    expect(() => buildPolicyPayload({ issuer: ISSUER, ...BASE_OPTS, origin: "" })).toThrow();
    expect(() => buildPolicyPayload({ issuer: ISSUER, ...BASE_OPTS, origin: "   " })).toThrow();
    expect(() => buildPolicyPayload({ issuer: ISSUER, ...BASE_OPTS, purpose: "" })).toThrow();
  });

  test("allowlist and dest_caps destinations are validated and normalized", () => {
    const p = buildPolicyPayload({
      issuer: ISSUER,
      ...BASE_OPTS,
      allowlist: [EVM_DEST, SOL_DEST],
      destCaps: [[P2PKH_DEST, 250]],
    });
    expect(p.dest_allowlist).toEqual([EVM_DEST, SOL_DEST]);
    expect(p.dest_caps).toEqual([[P2PKH_DEST, 250]]);
    expect(() => buildPolicyPayload({ issuer: ISSUER, ...BASE_OPTS, allowlist: ["nonsense"] })).toThrow();
    expect(() => buildPolicyPayload({ issuer: ISSUER, ...BASE_OPTS, destCaps: [["evm:0xZZ", 1] as [string, number]] })).toThrow();
    expect(() => buildPolicyPayload({ issuer: ISSUER, ...BASE_OPTS, destCaps: [[EVM_DEST, -5] as [string, number]] })).toThrow();
  });
});

describe("issuePolicyEnvelope", () => {
  test("signs with the vault key and the envelope verifies", () => {
    const env = issuePolicyEnvelope(KEY, { ...BASE_OPTS, allowlist: [EVM_DEST] });
    expect(env.sig.alg).toBe("ECDSA-SHA256-secp256k1");
    expect(env.sig.issuer).toBe(ISSUER);
    expect(verifyPolicyEnvelope(env).ok).toBe(true);
  });

  test("a freshly issued envelope gates sends on every rail form", () => {
    const env = issuePolicyEnvelope(KEY, { ...BASE_OPTS, allowlist: [EVM_DEST, SOL_DEST] });
    expect(gateAgentSend({ envelope: env, dest: EVM_DEST, amount: 100, fee: 0, spentTotal: 0, origin: "owner-console" }).ok).toBe(true);
    expect(gateAgentSend({ envelope: env, dest: SOL_DEST, amount: 100, fee: 0, spentTotal: 0, origin: "owner-console" }).ok).toBe(true);
    expect(gateAgentSend({ envelope: env, dest: P2PKH_DEST, amount: 100, fee: 0, spentTotal: 0, origin: "owner-console" }).ok).toBe(false);
    expect(gateAgentSend({ envelope: env, dest: EVM_DEST, amount: 101, fee: 0, spentTotal: 0, origin: "owner-console" }).ok).toBe(false);
  });

  test("each issue draws a fresh nonce", () => {
    const a = issuePolicyEnvelope(KEY, BASE_OPTS);
    const b = issuePolicyEnvelope(KEY, BASE_OPTS);
    expect(a.payload.nonce).not.toBe(b.payload.nonce);
  });
});

describe("writePolicyEnvelope", () => {
  test("installs brc181.json and refuses to overwrite without force", () => {
    const root = mkdtempSync(join(tmpdir(), "dogfood-policy-issue-"));
    try {
      const env = issuePolicyEnvelope(KEY, { ...BASE_OPTS, allowlist: [EVM_DEST] });
      writePolicyEnvelope(root, env);
      const written = join(root, "brc181.json");
      expect(existsSync(written)).toBe(true);
      const parsed = JSON.parse(readFileSync(written, "utf8"));
      expect(verifyPolicyEnvelope(parsed).ok).toBe(true);
      expect(() => writePolicyEnvelope(root, env)).toThrow(/exists|force/i);
      writePolicyEnvelope(root, env, { force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parsePolicyIssueFlags", () => {
  test("parses a full flag set", () => {
    const r = parsePolicyIssueFlags([
      "--origin", "owner-console",
      "--per-tx", "100",
      "--total", "1000",
      "--max-fee", "50",
      "--purpose", "agent metering",
      "--allow", EVM_DEST,
      "--allow", SOL_DEST,
      "--dest-cap", `${P2PKH_DEST}=250`,
      "--expires", "1893456000",
      "--write",
      "--force",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toMatchObject({
        origin: "owner-console",
        perTxCap: 100,
        totalBudget: 1_000,
        maxFee: 50,
        purpose: "agent metering",
        allowlist: [EVM_DEST, SOL_DEST],
        destCaps: [[P2PKH_DEST, 250]],
        expiryEpoch: 1893456000,
        write: true,
        force: true,
      });
    }
  });

  test("required flags are actually required", () => {
    const r = parsePolicyIssueFlags(["--origin", "x"]);
    expect(r.ok).toBe(false);
  });

  test("unknown flags and dangling values are rejected", () => {
    expect(parsePolicyIssueFlags(["--origin", "x", "--per-tx", "1", "--total", "1", "--max-fee", "1", "--purpose", "p", "--nope"]).ok).toBe(false);
    expect(parsePolicyIssueFlags(["--origin"]).ok).toBe(false);
  });

  test("bad dest-cap syntax is rejected", () => {
    const r = parsePolicyIssueFlags([
      "--origin", "x", "--per-tx", "1", "--total", "1", "--max-fee", "1", "--purpose", "p",
      "--dest-cap", "not-a-pair",
    ]);
    expect(r.ok).toBe(false);
  });
});
