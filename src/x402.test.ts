import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { P2PKH, PrivateKey } from "@bsv/sdk";
import {
  canonicalJson,
  challengeSha256,
  decodeChallengeHeader,
  inspectChallenge,
  p2pkhAddressFromLock,
  toBase64Url,
} from "./x402";
import { evaluateSend } from "./policy";
import { DEFAULT_MAX_SATS } from "./policy";

const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "testdata", "x402-vectors-v1.json"), "utf8"),
) as {
  vectors: Array<{
    name: string;
    expected_result: string;
    challenge?: Record<string, unknown>;
    canonical_challenge_json?: string;
    challenge_sha256?: string;
    challenge_base64url?: string;
  }>;
};

function byName(name: string) {
  const v = vectors.vectors.find((x) => x.name === name);
  if (!v) throw new Error(name);
  return v;
}

describe("x402 codec vs merkleworks vectors", () => {
  test("canonical JSON and hash match valid_get_empty", () => {
    const v = byName("valid_get_empty");
    expect(canonicalJson(v.challenge)).toBe(v.canonical_challenge_json);
    expect(challengeSha256(v.challenge!)).toBe(v.challenge_sha256);
    expect(toBase64Url(v.canonical_challenge_json!)).toBe(v.challenge_base64url);
  });

  test("decodeChallengeHeader round-trips valid_get_empty", () => {
    const v = byName("valid_get_empty");
    const decoded = decodeChallengeHeader(v.challenge_base64url!);
    expect(decoded.amount_sats).toBe(100);
    expect(decoded.scheme).toBe("bsv-tx-v1");
    expect(challengeSha256(decoded)).toBe(v.challenge_sha256);
  });

  test("inspectChallenge rejects expired_challenge", () => {
    const v = byName("expired_challenge");
    const d = inspectChallenge(v.challenge!, new Date("2026-10-07T00:00:00.000Z"));
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("EXPIRED");
  });
});

describe("x402 payee + policy", () => {
  test("p2pkhAddressFromLock inverts P2PKH.lock", () => {
    const address = PrivateKey.fromRandom().toAddress();
    const hex = new P2PKH().lock(address).toHex();
    expect(p2pkhAddressFromLock(hex)).toBe(address);
  });

  test("non-P2PKH payee is rejected", () => {
    expect(p2pkhAddressFromLock("006a")).toBeNull();
  });

  test("policy still blocks an allowed-looking challenge when allowlist is empty", () => {
    const v = byName("valid_get_empty");
    const payee = p2pkhAddressFromLock(String(v.challenge!.payee_locking_script_hex));
    expect(payee).toBeTruthy();
    const d = evaluateSend(
      {
        maxSatsPerTx: DEFAULT_MAX_SATS,
        maxSatsPerDay: 50_000,
        maxSatsLifetime: null,
        allowlist: [],
        killfileOn: false,
      },
      Number(v.challenge!.amount_sats),
      payee!,
    );
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("ALLOWLIST");
  });
});
