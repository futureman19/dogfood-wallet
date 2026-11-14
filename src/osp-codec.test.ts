import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import {
  OSP_GRANT_LEN,
  OSP_REVOKE_LEN,
  buildEnvelopeScript,
  bytesToHex,
  decode,
  encodeGrant,
  encodeRevoke,
  hexToBytes,
  reverseHexBytes,
  validatePub,
} from "./osp-envelope";
import { canonicalScope, jcs, scopeHashHex, scopePayment } from "./osp-scope";
import { OSP_DOMAIN, ospAddress, ospKey, ospTipScriptHex, p2pkhScriptHex, strictP2pkhAddress } from "./osp-address";
import { evaluateOspTransition, parseOspPolicy, usageFromLog } from "./policy";

const VECTORS = JSON.parse(
  readFileSync(join(resolve(import.meta.dir, ".."), "testdata", "osp-vectors.json"), "utf8"),
) as {
  params: {
    ownerPrivHex: string;
    ownerAddress: string;
    sessionPubCompressed: string;
    doorIdInternalHex: string;
    tipLockingScriptHex: string;
    expiryHeight: number;
    maxEgressBytes: number;
    scopeCanonical: string;
    scopeHashHex: string;
    knownAnswers: { grantEnvelopeHex: string; revokeCloseEnvelopeHex: string };
  };
  pushOpcodeCoverage: { directPush: string; pushdata1: string };
  transitions: Array<{ name: string; sourceTxid: string }>;
};
const P = VECTORS.params;

describe("osp-envelope is byte-pinned to the audited upstream vectors", () => {
  test("encodeGrant reproduces the golden grant envelope byte-for-byte", () => {
    const env = encodeGrant({
      doorId: hexToBytes(P.doorIdInternalHex),
      expiryHeight: P.expiryHeight,
      maxEgress: P.maxEgressBytes,
      scopeHash: hexToBytes(P.scopeHashHex),
      sessionPub: hexToBytes(P.sessionPubCompressed),
    });
    expect(env.length).toBe(OSP_GRANT_LEN);
    expect(bytesToHex(env)).toBe(P.knownAnswers.grantEnvelopeHex);
  });

  test("encodeRevoke(flag 0) reproduces the golden revoke-close envelope", () => {
    const env = encodeRevoke({ doorId: hexToBytes(P.doorIdInternalHex), flag: 0 });
    expect(env.length).toBe(OSP_REVOKE_LEN);
    expect(bytesToHex(env)).toBe(P.knownAnswers.revokeCloseEnvelopeHex);
  });

  test("buildEnvelopeScript picks the minimal push opcode (direct / PUSHDATA1)", () => {
    const revokeScript = buildEnvelopeScript(hexToBytes(P.knownAnswers.revokeCloseEnvelopeHex));
    expect(bytesToHex(revokeScript)).toBe(VECTORS.pushOpcodeCoverage.directPush);
    const grantScript = buildEnvelopeScript(hexToBytes(P.knownAnswers.grantEnvelopeHex));
    expect(bytesToHex(grantScript)).toBe(VECTORS.pushOpcodeCoverage.pushdata1);
  });

  test("decode roundtrips both golden envelopes", () => {
    const grant = decode(hexToBytes(P.knownAnswers.grantEnvelopeHex));
    if (grant.type !== "grant") throw new Error("expected grant");
    expect(bytesToHex(grant.doorId)).toBe(P.doorIdInternalHex);
    expect(grant.expiryHeight).toBe(P.expiryHeight);
    expect(grant.maxEgress).toBe(BigInt(P.maxEgressBytes));
    expect(bytesToHex(grant.scopeHash)).toBe(P.scopeHashHex);
    expect(bytesToHex(grant.sessionPub)).toBe(P.sessionPubCompressed);
    const revoke = decode(hexToBytes(P.knownAnswers.revokeCloseEnvelopeHex));
    if (revoke.type !== "revoke") throw new Error("expected revoke");
    expect(revoke.flag).toBe(0);
    expect(bytesToHex(revoke.doorId)).toBe(P.doorIdInternalHex);
  });

  test("door id is the byte-reversed (display) genesis txid", () => {
    expect(reverseHexBytes(P.doorIdInternalHex)).toBe(VECTORS.transitions[0]!.sourceTxid);
  });

  test("validatePub accepts the vector session key and rejects junk", () => {
    expect(() => validatePub(hexToBytes(P.sessionPubCompressed))).not.toThrow();
    expect(() => validatePub(hexToBytes(P.sessionPubCompressed.slice(0, 64)))).toThrow(/33-byte/);
    const offCurve = hexToBytes(P.sessionPubCompressed);
    offCurve[32] = (offCurve[32]! + 1) % 256;
    expect(() => validatePub(offCurve)).toThrow(/secp256k1|range/);
    expect(() => validatePub(Uint8Array.from([0x04, ...new Array(32).fill(1)]))).toThrow(/02\/03/);
  });
});

describe("osp-scope canonicalization matches the door's admission rules", () => {
  test("the vector scope blob is canonical and hashes to the golden scope hash", () => {
    const obj = canonicalScope(P.scopeCanonical);
    expect(jcs(obj)).toBe(P.scopeCanonical);
    expect(scopeHashHex(P.scopeCanonical)).toBe(P.scopeHashHex);
  });

  test("non-canonical blobs are rejected before any key or chain access", () => {
    expect(() => canonicalScope('{"rate":"60/min","allow":["read:users"],"salt":"00112233445566778899aabbccddeeff"}')).toThrow(/canonical/);
    expect(() => canonicalScope('{"allow":["read:users"],"salt":"00112233445566778899AABBCCDDEEFF"}')).toThrow(/salt/);
    expect(() => canonicalScope('{"allow":["read:users"],"salt":"00112233"}')).toThrow(/salt/);
    expect(() => canonicalScope('{"allow":["read:users"]}')).toThrow(/salt/);
    expect(() => canonicalScope('{"allow":["read:users"],"quota":1.5,"salt":"00112233445566778899aabbccddeeff"}')).toThrow(/floats/);
    expect(() => canonicalScope('["read:users"]')).toThrow(/object/);
    expect(() => canonicalScope("not json")).toThrow(/JSON/);
  });

  test("OSP-0005 payment terms ride inside the scope blob", () => {
    const paid = '{"allow":["read:users"],"payment":{"amount_sats":10,"script":"76a914751e76e8199196d454941c45d1b3a323f1433bd688ac"},"salt":"00112233445566778899aabbccddeeff"}';
    const obj = canonicalScope(paid);
    expect(jcs(obj)).toBe(paid);
    expect(scopePayment(obj)).toEqual({ amount_sats: 10, script: "76a914751e76e8199196d454941c45d1b3a323f1433bd688ac" });
    expect(scopePayment(canonicalScope(P.scopeCanonical))).toBeUndefined();
    expect(() => scopePayment({ payment: { amount_sats: 0, script: "ab" } })).toThrow(/payment/);
    expect(() => scopePayment({ payment: { amount_sats: 1, script: "XYZ" } })).toThrow(/payment/);
  });
});

describe("osp-address derives a distinct door-owner identity", () => {
  test("derived tip identity is deterministic, P2PKH, and never the raw vault key", () => {
    const key = PrivateKey.fromString(P.ownerPrivHex, 16);
    expect(key.toAddress()).toBe(P.ownerAddress); // the well-known priv=1 address
    const a1 = ospAddress(key);
    const a2 = ospAddress(PrivateKey.fromString(P.ownerPrivHex, 16));
    expect(a1).toBe(a2);
    expect(a1).not.toBe(P.ownerAddress);
    const tip = ospTipScriptHex(key);
    expect(tip).toMatch(/^76a914[0-9a-f]{40}88ac$/);
    expect(tip).not.toBe(P.tipLockingScriptHex); // distinct domain, distinct script
    // same doctrine as btcKey: self-ECDH child under the OSP domain
    expect(ospKey(key).toString()).toBe(key.deriveChild(key.toPublicKey(), OSP_DOMAIN).toString());
  });

  test("strictP2pkhAddress refuses script-hash and junk", () => {
    expect(strictP2pkhAddress(P.ownerAddress)).toBe(true);
    expect(strictP2pkhAddress("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).toBe(false);
    expect(strictP2pkhAddress("not-an-address")).toBe(false);
    expect(strictP2pkhAddress(undefined)).toBe(false);
    expect(p2pkhScriptHex(P.ownerAddress)).toBe(P.tipLockingScriptHex); // priv=1 P2PKH script, golden
    expect(() => p2pkhScriptHex("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).toThrow(/BAD_ADDRESS/);
  });
});

describe("osp policy block (fail-closed caps over everything that leaves the vault)", () => {
  const usage = { spentToday: 0, spentLifetime: 0 };
  test("parseOspPolicy validates shape", () => {
    expect(parseOspPolicy(undefined)).toBeUndefined();
    expect(parseOspPolicy({ maxSatsPerTx: 100, maxSatsPerDay: null })).toEqual({ maxSatsPerTx: 100, maxSatsPerDay: null });
    expect(() => parseOspPolicy(null)).toThrow(/osp policy/);
    expect(() => parseOspPolicy({ maxSatsPerTx: -1, maxSatsPerDay: null })).toThrow(/maxSatsPerTx/);
    expect(() => parseOspPolicy({ maxSatsPerTx: 1.5, maxSatsPerDay: null })).toThrow(/maxSatsPerTx/);
    expect(() => parseOspPolicy({ maxSatsPerTx: 100, maxSatsPerDay: "x" })).toThrow(/maxSatsPerDay/);
  });

  test("evaluateOspTransition: absent block disables; killfile wins; caps bind payment+fee", () => {
    const code = (d: ReturnType<typeof evaluateOspTransition>) => (d.ok ? null : d.code);
    expect(code(evaluateOspTransition(undefined, false, 1, usage))).toBe("DISABLED");
    const osp = { maxSatsPerTx: 100, maxSatsPerDay: 200 };
    expect(code(evaluateOspTransition(osp, true, 1, usage))).toBe("KILL");
    expect(code(evaluateOspTransition(osp, false, 101, usage))).toBe("CAP");
    expect(code(evaluateOspTransition(osp, false, 100, { spentToday: 101, spentLifetime: 0 }))).toBe("DAY");
    expect(evaluateOspTransition(osp, false, 100, { spentToday: 100, spentLifetime: 0 }).ok).toBe(true);
    expect(evaluateOspTransition({ maxSatsPerTx: 100, maxSatsPerDay: null }, false, 100, { spentToday: 10_000, spentLifetime: 0 }).ok).toBe(true);
    expect(code(evaluateOspTransition(osp, false, -1, usage))).toBe("BAD_AMOUNT");
  });

  test("usageFromLog counts osp transitions payment+fee inclusive, nothing else", () => {
    const rows = [
      JSON.stringify({ t: new Date().toISOString(), asset: "bsv", kind: "osp-door-init", amount: 0, fee: 7 }),
      JSON.stringify({ t: new Date().toISOString(), asset: "bsv", kind: "osp-grant", amount: 10, fee: 5 }),
      JSON.stringify({ t: new Date().toISOString(), asset: "bsv", kind: "osp-revoke", amount: 0, fee: 6 }),
      JSON.stringify({ t: new Date().toISOString(), asset: "bsv", kind: "send", amount: 999, fee: 3 }),
    ];
    const u = usageFromLog(rows, new Date(), "osp");
    expect(u.spentToday).toBe(28);
    expect(u.spentLifetime).toBe(28);
  });
});
