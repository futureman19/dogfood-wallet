import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  POLICY_TYPE,
  canonicalDest,
  canonicalEvmDest,
  canonicalSolanaDest,
  canonicalPayloadBytes,
  payloadDigest,
  verifyPolicyEnvelope,
  evaluatePolicyRequest,
  gateAgentSend,
} from "./brc181";
import { makePayload, signEnvelope } from "./test-support/brc181";

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

describe("BRC-181 multi-chain canonical destinations", () => {
  const EVM_TO = "0x209693Bc6afc0C5328bA36FaF03C18EF3122C5EA";
  const SOL_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  test("EVM dest is evm:<lowercase address>", () => {
    expect(canonicalEvmDest(EVM_TO)).toBe("evm:0x209693bc6afc0c5328ba36faf03c18ef3122c5ea");
  });

  test("EVM dest rejects malformed addresses", () => {
    for (const bad of [
      "",
      "0x1234",
      "209693Bc6afc0C5328bA36FaF03C18EF3122C5EA",
      "0xZZ9693Bc6afc0C5328bA36FaF03C18EF3122C5EA",
      "0x209693Bc6afc0C5328bA36FaF03C18EF3122C5EA00",
    ]) {
      expect(() => canonicalEvmDest(bad)).toThrow();
    }
  });

  test("Solana dest is solana:<base58 address> unchanged", () => {
    expect(canonicalSolanaDest(SOL_TO)).toBe(`solana:${SOL_TO}`);
  });

  test("Solana dest rejects malformed addresses", () => {
    for (const bad of ["", "short", "0OIl" + "1".repeat(40), "x".repeat(45)]) {
      expect(() => canonicalSolanaDest(bad)).toThrow();
    }
  });
});

describe("gateAgentSend with a pre-canonical multi-chain dest", () => {
  const EVM_TO = "0x209693Bc6afc0C5328bA36FaF03C18EF3122C5EA";
  const EVM_DEST = "evm:0x209693bc6afc0c5328ba36faf03c18ef3122c5ea";
  const SOL_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const SOL_DEST = `solana:${SOL_TO}`;

  test("allowlisted EVM dest under caps is allowed (no BSV address involved)", () => {
    const env = signEnvelope(makePayload({ dest_allowlist: [EVM_DEST] }));
    const r = gateAgentSend({ envelope: env, dest: EVM_DEST, amount: 100, fee: 0, spentTotal: 0, origin: "test-origin" });
    expect(r.ok).toBe(true);
  });

  test("off-allowlist EVM dest is rejected", () => {
    const env = signEnvelope(makePayload({ dest_allowlist: [`evm:0x${"0".repeat(40)}`] }));
    const r = gateAgentSend({ envelope: env, dest: EVM_DEST, amount: 100, fee: 0, spentTotal: 0, origin: "test-origin" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("POLICY");
      expect(r.message).toMatch(/allowlist/i);
    }
  });

  test("over per-tx cap is rejected in the rail's native units", () => {
    const env = signEnvelope(makePayload({ dest_allowlist: [EVM_DEST], per_tx_cap: 50 }));
    const r = gateAgentSend({ envelope: env, dest: EVM_DEST, amount: 51, fee: 0, spentTotal: 0, origin: "test-origin" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("POLICY");
  });

  test("over total budget via spentTotal is rejected", () => {
    const env = signEnvelope(makePayload({ dest_allowlist: [EVM_DEST], total_budget: 1_000 }));
    const r = gateAgentSend({ envelope: env, dest: EVM_DEST, amount: 100, fee: 0, spentTotal: 950, origin: "test-origin" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("POLICY");
  });

  test("dest_caps entry bounds a single destination", () => {
    const env = signEnvelope(makePayload({ dest_caps: [[EVM_DEST, 60]] }));
    expect(gateAgentSend({ envelope: env, dest: EVM_DEST, amount: 60, fee: 0, spentTotal: 0, origin: "test-origin" }).ok).toBe(true);
    expect(gateAgentSend({ envelope: env, dest: EVM_DEST, amount: 61, fee: 0, spentTotal: 0, origin: "test-origin" }).ok).toBe(false);
  });

  test("wrong origin is rejected", () => {
    const env = signEnvelope(makePayload({ dest_allowlist: [EVM_DEST] }));
    const r = gateAgentSend({ envelope: env, dest: EVM_DEST, amount: 1, fee: 0, spentTotal: 0, origin: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("POLICY");
  });

  test("allowlisted Solana dest is allowed", () => {
    const env = signEnvelope(makePayload({ dest_allowlist: [SOL_DEST] }));
    expect(gateAgentSend({ envelope: env, dest: SOL_DEST, amount: 100, fee: 0, spentTotal: 0, origin: "test-origin" }).ok).toBe(true);
  });

  test("off-allowlist Solana dest is rejected", () => {
    const env = signEnvelope(makePayload({ dest_allowlist: [EVM_DEST] }));
    const r = gateAgentSend({ envelope: env, dest: SOL_DEST, amount: 100, fee: 0, spentTotal: 0, origin: "test-origin" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("POLICY");
  });

  test("tampered envelope is BAD_SIG on multi-chain dests too", () => {
    const env = signEnvelope(makePayload({ dest_allowlist: [EVM_DEST] }));
    env.payload.per_tx_cap = 1;
    const r = gateAgentSend({ envelope: env, dest: EVM_DEST, amount: 1, fee: 0, spentTotal: 0, origin: "test-origin" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_SIG");
  });
});

