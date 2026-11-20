// agent-message-enc.test.ts — S7 codec support for encrypted envelopes.
// The envelope gains an optional `enc: "brc78"` marker; when present the body
// is a base64 BRC-78 ciphertext (NOT plaintext). Authorship (BSM + AIP) covers
// the ciphertext bytes exactly as for plaintext. No vault, no network.
import { describe, expect, test } from "bun:test";
import { EncryptedMessage, PrivateKey, Utils } from "@bsv/sdk";
import {
  MESSAGE_APP, MESSAGE_V, MESSAGE_ENC_ALG, BRC78_VERSION_HEX, MAX_ENCRYPTED_BODY_BYTES,
  canonicalEnvelopeJson, signEnvelope, verifyEnvelope, randomNonce,
  buildMessageScript, parseMessageScript, verifyMessageScript, assertValidBody,
} from "./agent-message";
import { jcs } from "./osp-scope";

const ONE = PrivateKey.fromString("1".padStart(64, "0"), 16);
const TWO = PrivateKey.fromString("2".padStart(64, "0"), 16);
const ADDR_ONE = ONE.toAddress();
const ADDR_TWO = TWO.toAddress();
const NONCE = "000102030405060708090a0b0c0d0e0f";
const TS = 1763000000;

// A real BRC-78 ciphertext fixture (ONE -> TWO) built with the SDK directly so
// the codec test does not depend on the S7 crypto module.
const innerPlain = jcs({ msgId: "ab".repeat(16), body: "confidential terms" });
const CT_BYTES = EncryptedMessage.encrypt(Utils.toArray(innerPlain, "utf8"), ONE, TWO.toPublicKey());
const CT_B64 = Utils.toBase64(CT_BYTES);

const encEnv = (body: unknown = CT_B64, enc: unknown = MESSAGE_ENC_ALG) => ({
  app: MESSAGE_APP, v: MESSAGE_V, type: "message",
  from: ADDR_ONE, to: ADDR_TWO, nonce: NONCE, ts: TS, enc, body,
});

describe("S7 codec: encrypted envelope (enc=brc78)", () => {
  test("BRC-78 fixture has the pinned version header", () => {
    expect(Utils.toHex(CT_BYTES.slice(0, 4))).toBe(BRC78_VERSION_HEX);
  });

  test("encrypted envelope canonicalizes, signs and verifies", () => {
    const env = encEnv();
    const canon = canonicalEnvelopeJson(env);
    expect(JSON.parse(canon).enc).toBe(MESSAGE_ENC_ALG);
    const signed = signEnvelope(ONE, env);
    const { envelope, pubkey } = verifyEnvelope(signed);
    expect(envelope.enc).toBe(MESSAGE_ENC_ALG);
    expect(envelope.body).toBe(CT_B64);
    expect(pubkey).toBe(ONE.toPublicKey().toString());
  });

  test("Option A script round-trips the ciphertext and verifies AIP authorship", () => {
    const script = buildMessageScript(ONE, encEnv());
    const parsed = parseMessageScript(script);
    expect(parsed.envelope.enc).toBe(MESSAGE_ENC_ALG);
    expect(parsed.envelope.body).toBe(CT_B64);
    const v = verifyMessageScript(script);
    expect(v.pubkey).toBe(ONE.toPublicKey().toString());
    expect(v.aipAddress).toBe(ADDR_ONE);
    expect(v.envelope.body).toBe(CT_B64);
  });

  test("MAP type still matches envelope.type for encrypted messages", () => {
    const env = { ...encEnv(), type: "osp.grant.request" };
    // body is ciphertext; type is declared for MAP routing only.
    const script = buildMessageScript(ONE, env);
    expect(parseMessageScript(script).envelope.type).toBe("osp.grant.request");
  });

  test("unknown enc algorithm is rejected", () => {
    expect(() => canonicalEnvelopeJson(encEnv(CT_B64, "ecies"))).toThrow();
    expect(() => canonicalEnvelopeJson(encEnv(CT_B64, "brc2"))).toThrow();
  });

  test("enc present but body is not a BRC-78 ciphertext is rejected", () => {
    expect(() => canonicalEnvelopeJson(encEnv("not-base64!!"))).toThrow();
    // valid base64 but wrong version header
    const badHeader = Utils.toBase64([0x00, 0x00, 0x00, 0x00, ...CT_BYTES.slice(4)]);
    expect(() => canonicalEnvelopeJson(encEnv(badHeader))).toThrow();
    // too short to be a BRC-78 message
    expect(() => canonicalEnvelopeJson(encEnv(Utils.toBase64([0x42, 0x42, 0x10, 0x33])))).toThrow();
  });

  test("oversized ciphertext body is rejected", () => {
    const big = Utils.toBase64([...CT_BYTES.slice(0, 102), ...new Array(MAX_ENCRYPTED_BODY_BYTES).fill(0x41)]);
    expect(() => canonicalEnvelopeJson(encEnv(big))).toThrow();
  });

  test("plaintext envelopes (no enc) are unchanged", () => {
    const plain = { app: MESSAGE_APP, v: MESSAGE_V, type: "message", from: ADDR_ONE, to: ADDR_TWO, nonce: NONCE, ts: TS, body: "hello" };
    const signed = signEnvelope(ONE, plain);
    expect(verifyEnvelope(signed).envelope.body).toBe("hello");
    expect(verifyEnvelope(signed).envelope.enc).toBeUndefined();
  });

  test("assertValidBody validates plaintext bodies by type", () => {
    expect(() => assertValidBody("message", "ok")).not.toThrow();
    expect(() => assertValidBody("message", 123)).toThrow();
    expect(() => assertValidBody("osp.grant.receipt", { grantTxid: "a".repeat(64), scopeHash: "b".repeat(64), doorGenesisTxid: "c".repeat(64) })).not.toThrow();
  });
});
