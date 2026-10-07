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
  headerBindingSha256,
  bodySha256FromHex,
  txidFromRawHex,
  bindRequestHeaders,
  buildProof,
  inspectProof,
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
    header_binding_string?: string;
    headers_sha256?: string;
    body_sha256?: string;
    body_bytes?: string;
    rawtx_hex?: string;
    txid?: string;
    proof?: {
      v: number;
      scheme: string;
      challenge_sha256: string;
      payment: { txid: string; rawtx_b64: string };
      request: {
        method: string;
        path: string;
        query: string;
        req_headers_sha256: string;
        req_body_sha256: string;
      };
    };
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

  test("canonical JSON and hash match valid_post_with_body", () => {
    const v = byName("valid_post_with_body");
    expect(canonicalJson(v.challenge)).toBe(v.canonical_challenge_json);
    expect(challengeSha256(v.challenge!)).toBe(v.challenge_sha256);
    expect(toBase64Url(v.canonical_challenge_json!)).toBe(v.challenge_base64url);
  });

  test("header binding hash matches frozen vector", () => {
    const v = byName("header_binding_canonical");
    expect(headerBindingSha256(v.header_binding_string!)).toBe(v.headers_sha256);
  });

  test("body hash matches frozen vector", () => {
    const v = byName("body_hash_examples");
    expect(bodySha256FromHex(v.body_bytes!)).toBe(v.body_sha256);
    expect(bodySha256FromHex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("txid is double-SHA256 byte-reversed", () => {
    const v = byName("txid_derivation");
    expect(txidFromRawHex(v.rawtx_hex!)).toBe(v.txid);
  });

  test("invalid_txid_mismatch is detected", () => {
    const v = byName("invalid_txid_mismatch");
    expect(txidFromRawHex(v.rawtx_hex!)).not.toBe(v.txid);
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

describe("x402 proof + header binding", () => {
  test("bindRequestHeaders matches header_binding_canonical", () => {
    const v = byName("header_binding_canonical");
    const s = bindRequestHeaders({
      Accept: "application/json",
      "Content-Type": "text/plain",
      "X402-Client": "test-client/1.0",
    });
    expect(s).toBe(v.header_binding_string);
    expect(headerBindingSha256(s)).toBe(v.headers_sha256);
  });

  test("inspectProof rejects invalid_proof_version", () => {
    const v = byName("invalid_proof_version");
    const d = inspectProof(v.proof!);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("VERSION");
  });

  test("inspectProof rejects invalid_txid_mismatch", () => {
    const v = byName("invalid_txid_mismatch");
    const d = inspectProof(
      {
        v: 1,
        scheme: "bsv-tx-v1",
        challenge_sha256: "aa".repeat(32),
        payment: { txid: v.txid!, rawtx_b64: Buffer.from(v.rawtx_hex!, "hex").toString("base64") },
        request: { method: "GET", path: "/", query: "", req_headers_sha256: "", req_body_sha256: "" },
      },
      { rawtxHex: v.rawtx_hex },
    );
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("TXID");
  });

  test("inspectProof rejects path mismatch against challenge.path", () => {
    const v = byName("invalid_binding_path_mismatch");
    const d = inspectProof(
      {
        v: 1,
        scheme: "bsv-tx-v1",
        challenge_sha256: "aa".repeat(32),
        payment: {
          txid: txidFromRawHex("00"),
          rawtx_b64: Buffer.from("00", "hex").toString("base64"),
        },
        request: { method: "GET", path: "/other", query: "", req_headers_sha256: "", req_body_sha256: "" },
      },
      { challenge: v.challenge as never, requestPath: "/other", rawtxHex: "00" },
    );
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("PATH");
  });

  test("buildProof txid matches frozen rawtx vector", () => {
    const raw = byName("txid_derivation");
    const ch = byName("valid_get_empty");
    const proof = buildProof({
      challenge: ch.challenge as never,
      rawtxHex: raw.rawtx_hex!,
      method: "GET",
      path: "/v1/resource",
    });
    expect(proof.v).toBe(1);
    expect(proof.payment.txid).toBe(raw.txid);
    expect(inspectProof(proof).ok).toBe(true);
  });
});
