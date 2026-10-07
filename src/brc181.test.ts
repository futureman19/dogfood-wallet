import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  POLICY_TYPE,
  canonicalDest,
  canonicalPayloadBytes,
  payloadDigest,
  verifyPolicyEnvelope,
  evaluatePolicyRequest,
  gateAgentSend,
} from "./brc181";

const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "testdata", "brc-181-vectors.json"), "utf8"),
) as {
  vectorA: { canonical: string; digest: string; signature: string; issuer: string };
  vectorE: { canonical: string; digest: string };
};

describe("BRC-181 canonical destination", () => {
  test("P2PKH is p2pkh:hash160", () => {
    expect(canonicalDest("76a914" + "11".repeat(20) + "88ac")).toBe(
      "p2pkh:1111111111111111111111111111111111111111",
    );
  });

  test("non-P2PKH is script:sha256", () => {
    expect(canonicalDest("52210300ff210300ee52ae")).toBe(
      "script:76649d1560a19192282962c83a535b543b544dcf4da3d7ef89d428083435479f",
    );
  });

  test("OP_RETURN contributes no destination", () => {
    expect(canonicalDest("6a04deadbeef")).toBe(null);
  });
});

describe("BRC-181 Vector A", () => {
  test("canonical bytes and digest match the frozen vector", () => {
    const payload = JSON.parse(vectors.vectorA.canonical) as Record<string, unknown>;
    const bytes = canonicalPayloadBytes(payload);
    expect(Buffer.from(bytes).toString("utf8")).toBe(vectors.vectorA.canonical);
    expect(payloadDigest(payload)).toBe(vectors.vectorA.digest);
    expect(payload.type).toBe(POLICY_TYPE);
  });

  test("issuer signature verifies", () => {
    const payload = JSON.parse(vectors.vectorA.canonical) as Record<string, unknown>;
    const r = verifyPolicyEnvelope({
      payload,
      sig: {
        alg: "ECDSA-SHA256-secp256k1",
        issuer: vectors.vectorA.issuer,
        signature: vectors.vectorA.signature,
      },
    });
    expect(r.ok).toBe(true);
  });
});

describe("BRC-181 Vector E tamper", () => {
  test("Vector A signature over mutated per_tx_cap MUST fail", () => {
    const payload = JSON.parse(vectors.vectorE.canonical) as Record<string, unknown>;
    expect(payloadDigest(payload)).toBe(vectors.vectorE.digest);
    const r = verifyPolicyEnvelope({
      payload,
      sig: {
        alg: "ECDSA-SHA256-secp256k1",
        issuer: vectors.vectorA.issuer,
        signature: vectors.vectorA.signature,
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_SIG");
  });
});

describe("BRC-181 Vector D enforce (payout path, fee 0)", () => {
  const payload = JSON.parse(vectors.vectorA.canonical) as Record<string, unknown>;

  test("pay 100 to allowlisted P2PKH is ALLOW_AUTO", () => {
    const r = evaluatePolicyRequest(payload, {
      origin: "agt-marketplace-bidder-01",
      payout: 100,
      lockingScriptHex: "76a914" + "11".repeat(20) + "88ac",
      fee: 0,
      spentTotal: 0,
    });
    expect(r.verdict).toBe("ALLOW_AUTO");
  });

  test("pay 101 is REJECT over per-tx cap", () => {
    const r = evaluatePolicyRequest(payload, {
      origin: "agt-marketplace-bidder-01",
      payout: 101,
      lockingScriptHex: "76a914" + "11".repeat(20) + "88ac",
      fee: 0,
      spentTotal: 0,
    });
    expect(r.verdict).toBe("REJECT");
    expect(r.reason).toMatch(/per-tx cap/i);
  });

  test("off-allowlist P2PKH is REJECT", () => {
    const r = evaluatePolicyRequest(payload, {
      origin: "agt-marketplace-bidder-01",
      payout: 50,
      lockingScriptHex: "76a914" + "22".repeat(20) + "88ac",
      fee: 0,
      spentTotal: 0,
    });
    expect(r.verdict).toBe("REJECT");
    expect(r.reason).toMatch(/allowlist/i);
  });

  test("unlisted script is REJECT (bypass closed)", () => {
    const r = evaluatePolicyRequest(payload, {
      origin: "agt-marketplace-bidder-01",
      payout: 50,
      lockingScriptHex: "52210300ff210300ee52ae",
      fee: 0,
      spentTotal: 0,
    });
    expect(r.verdict).toBe("REJECT");
  });

  test("wrong origin is REJECT", () => {
    const r = evaluatePolicyRequest(payload, {
      origin: "local-unspecified",
      payout: 1,
      lockingScriptHex: "76a914" + "11".repeat(20) + "88ac",
      fee: 0,
      spentTotal: 0,
    });
    expect(r.verdict).toBe("REJECT");
  });
});

const VECTOR_DEST = "12ZEw5Hcv1hTb6YUQJ69y1V7uhcoDz92PH";
const OTHER_DEST = "1GjcRUKdwqsnrxCHiDoHtF57rKqDd8oibT";

function vectorAEnvelope() {
  return {
    payload: JSON.parse(vectors.vectorA.canonical) as Record<string, unknown>,
    sig: {
      alg: "ECDSA-SHA256-secp256k1",
      issuer: vectors.vectorA.issuer,
      signature: vectors.vectorA.signature,
    },
  };
}

describe("gateAgentSend", () => {
  test("no envelope is a no-op", () => {
    const r = gateAgentSend({ envelope: null, to: OTHER_DEST, amount: 50_000, fee: 0, spentTotal: 0 });
    expect(r.ok).toBe(true);
  });

  test("Vector A allows 100 to the listed P2PKH", () => {
    const r = gateAgentSend({
      envelope: vectorAEnvelope(),
      to: VECTOR_DEST,
      amount: 100,
      fee: 0,
      spentTotal: 0,
      origin: "agt-marketplace-bidder-01",
    });
    expect(r.ok).toBe(true);
  });

  test("Vector A rejects 101 (per-tx)", () => {
    const r = gateAgentSend({
      envelope: vectorAEnvelope(),
      to: VECTOR_DEST,
      amount: 101,
      fee: 0,
      spentTotal: 0,
      origin: "agt-marketplace-bidder-01",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("POLICY");
  });

  test("Vector A rejects an off-allowlist P2PKH", () => {
    const r = gateAgentSend({
      envelope: vectorAEnvelope(),
      to: OTHER_DEST,
      amount: 50,
      fee: 0,
      spentTotal: 0,
      origin: "agt-marketplace-bidder-01",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("POLICY");
  });

  test("tampered envelope is BAD_SIG", () => {
    const env = vectorAEnvelope();
    env.payload.per_tx_cap = 101;
    const r = gateAgentSend({
      envelope: env,
      to: VECTOR_DEST,
      amount: 50,
      fee: 0,
      spentTotal: 0,
      origin: "agt-marketplace-bidder-01",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_SIG");
  });

  test("typical P2PKH fee over max_fee is REJECT", () => {
    const r = gateAgentSend({
      envelope: vectorAEnvelope(),
      to: VECTOR_DEST,
      amount: 100,
      fee: 226,
      spentTotal: 0,
      origin: "agt-marketplace-bidder-01",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("POLICY");
  });
});

