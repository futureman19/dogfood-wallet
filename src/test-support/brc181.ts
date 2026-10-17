import { PrivateKey } from "@bsv/sdk";
import { POLICY_TYPE, canonicalPayloadBytes, type PolicyEnvelope } from "../brc181";

// Test-only helpers: build a complete BRC-181 payload and sign it with the
// frozen privkey=1 test key, so gate tests exercise the real verify path.

export function makePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_id: 1,
    can_create_children: false,
    cb_burst_per_s: 0,
    cb_max_new_dests: 0,
    child_budget_ceiling: 0,
    delegation_depth: 0,
    dest_allowlist: [] as string[],
    dest_caps: [] as Array<[string, number]>,
    escalate_off_allowlist: false,
    escalate_over_per_tx: false,
    expiry_epoch: 0,
    issued_at: 1752710400,
    issuer: "",
    max_fee: 100,
    nonce: "deadbeefcafebabe",
    origin_token: "test-origin",
    per_tx_cap: 10_000,
    period_cap: 1_000_000_000,
    period_window_s: 3600,
    purpose: "test envelope",
    rate_limit: 1_000_000,
    rate_window_s: 60,
    total_budget: 100_000,
    type: POLICY_TYPE,
    ...overrides,
  };
}

export function signEnvelope(payload: Record<string, unknown>): PolicyEnvelope {
  const key = PrivateKey.fromHex("1".padStart(64, "0"));
  const issuer = key.toPublicKey().toString();
  const full = { ...payload, issuer };
  const sig = key.sign(Array.from(canonicalPayloadBytes(full)));
  return {
    payload: full,
    sig: {
      alg: "ECDSA-SHA256-secp256k1",
      issuer,
      signature: Buffer.from(sig.toDER()).toString("hex"),
    },
  };
}
