// agent-message-crypto.test.ts — S7 pure BRC-78 encrypt/decrypt (design §13.4).
// No vault, no network, no funds: fixed ONE/TWO keys. Proves confidentiality,
// wrong-recipient rejection, authorship cross-check, tamper detection, the
// msgId/expiry plaintext binding, and filing-parity inner-body validation.
import { describe, expect, test } from "bun:test";
import { EncryptedMessage, PrivateKey, Utils } from "@bsv/sdk";
import {
  encryptMessageBody, parseBrc78, decryptMessageBody,
} from "./agent-message-crypto";
import { MESSAGE_APP, MESSAGE_V, MESSAGE_ENC_ALG, randomNonce } from "./agent-message";
import { jcs } from "./osp-scope";

const ONE = PrivateKey.fromString("1".padStart(64, "0"), 16);
const TWO = PrivateKey.fromString("2".padStart(64, "0"), 16);
const THREE = PrivateKey.fromString("3".padStart(64, "0"), 16);
const ADDR_ONE = ONE.toAddress();
const ADDR_TWO = TWO.toAddress();
const PUB_ONE = ONE.toPublicKey().toString();
const PUB_TWO = TWO.toPublicKey().toString();
const NONCE = "000102030405060708090a0b0c0d0e0f";
const TS = 1763000000;

const p2pkh = (addr: string) => {
  const raw = Buffer.from(Utils.fromBase58Check(addr).data as number[]);
  return "76a914" + raw.toString("hex") + "88ac";
};
const validRequest = () => ({
  scope: jcs({ payment: { amount_sats: 100, script: p2pkh(ADDR_ONE) }, salt: "aa".repeat(16), expires_at_height: 2000000, max_egress_bytes: 4096 }),
  doorGenesisTxid: "ab".repeat(32), doorOwnerAddress: ADDR_ONE, reason: "encrypted handoff",
  sessionPubHex: PUB_TWO, expiryHeight: 2000000, maxEgressBytes: 4096,
});
const validReceipt = () => ({ grantTxid: "a".repeat(64), scopeHash: "b".repeat(64), doorGenesisTxid: "c".repeat(64) });

const envOf = (ciphertextB64: string, type = "message") => ({
  app: MESSAGE_APP, v: MESSAGE_V, type, from: ADDR_ONE, to: ADDR_TWO,
  nonce: NONCE, ts: TS, enc: MESSAGE_ENC_ALG, body: ciphertextB64,
});

describe("S7 crypto: encryptMessageBody / parseBrc78", () => {
  test("encrypt returns base64 ciphertext + a 32-hex msgId", () => {
    const { ciphertextB64, msgId } = encryptMessageBody(ONE, PUB_TWO, "secret terms");
    expect(msgId).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof ciphertextB64).toBe("string");
    const raw = Array.from(Buffer.from(ciphertextB64, "base64"));
    expect(Utils.toHex(raw.slice(0, 4))).toBe("42421033");
  });

  test("parseBrc78 extracts the sender and recipient pubkeys", () => {
    const { ciphertextB64 } = encryptMessageBody(ONE, PUB_TWO, "x");
    const p = parseBrc78(ciphertextB64);
    expect(p.senderPubHex).toBe(PUB_ONE);
    expect(p.recipientPubHex).toBe(PUB_TWO);
    expect(p.keyIdHex).toMatch(/^[0-9a-f]+$/);
  });

  test("encrypt rejects a malformed recipient pubkey", () => {
    expect(() => encryptMessageBody(ONE, "not-a-pubkey", "x")).toThrow();
    expect(() => encryptMessageBody(ONE, "04" + "ab".repeat(64), "x")).toThrow(); // uncompressed
  });

  test("parseBrc78 rejects malformed / short / non-base64 input", () => {
    expect(() => parseBrc78("!!!")).toThrow();
    expect(() => parseBrc78(Utils.toBase64([0x42, 0x42, 0x10, 0x33]))).toThrow();
    expect(() => parseBrc78(Utils.toBase64([0, 0, 0, 0, ...new Array(120).fill(1)]))).toThrow();
  });

  test("msgId override and expiryHeight are honored", () => {
    const msgId = "cd".repeat(16);
    const r = encryptMessageBody(ONE, PUB_TWO, "x", { msgId, expiryHeight: 12345 });
    expect(r.msgId).toBe(msgId);
    expect(r.expiryHeight).toBe(12345);
  });
});

describe("S7 crypto: decryptMessageBody", () => {
  test("round-trips the body and msgId for the right recipient", () => {
    const { ciphertextB64, msgId } = encryptMessageBody(ONE, PUB_TWO, "secret terms");
    const out = decryptMessageBody(TWO, envOf(ciphertextB64), PUB_ONE);
    expect(out.body).toBe("secret terms");
    expect(out.msgId).toBe(msgId);
    expect(out.senderPubHex).toBe(PUB_ONE);
    expect(out.recipientPubHex).toBe(PUB_TWO);
  });

  test("wrong recipient key is rejected (fail-closed)", () => {
    const { ciphertextB64 } = encryptMessageBody(ONE, PUB_TWO, "secret");
    expect(() => decryptMessageBody(THREE, envOf(ciphertextB64), PUB_ONE)).toThrow();
  });

  test("BRC-78 sender must match the AIP authorship pubkey", () => {
    const { ciphertextB64 } = encryptMessageBody(ONE, PUB_TWO, "secret");
    // authorship claims THREE, but the ciphertext sender is ONE -> reject.
    expect(() => decryptMessageBody(TWO, envOf(ciphertextB64), THREE.toPublicKey().toString())).toThrow();
  });

  test("tampered ciphertext is rejected (GCM auth)", () => {
    const { ciphertextB64 } = encryptMessageBody(ONE, PUB_TWO, "secret");
    const raw = Array.from(Buffer.from(ciphertextB64, "base64"));
    raw[raw.length - 1] ^= 0x01;
    expect(() => decryptMessageBody(TWO, envOf(Utils.toBase64(raw)), PUB_ONE)).toThrow();
  });

  test("envelope without enc marker is rejected", () => {
    const { ciphertextB64 } = encryptMessageBody(ONE, PUB_TWO, "secret");
    const env = { ...envOf(ciphertextB64) } as Record<string, unknown>;
    delete env.enc;
    expect(() => decryptMessageBody(TWO, env, PUB_ONE)).toThrow();
  });

  test("expiry is enforced against currentHeight", () => {
    const { ciphertextB64 } = encryptMessageBody(ONE, PUB_TWO, "secret", { expiryHeight: 1000 });
    expect(() => decryptMessageBody(TWO, envOf(ciphertextB64), PUB_ONE, { currentHeight: 1001 })).toThrow(/expir/i);
    expect(decryptMessageBody(TWO, envOf(ciphertextB64), PUB_ONE, { currentHeight: 1000 }).body).toBe("secret");
    expect(decryptMessageBody(TWO, envOf(ciphertextB64), PUB_ONE).body).toBe("secret"); // no height -> no expiry check
  });

  test("typed osp.grant.receipt body round-trips at filing parity", () => {
    const body = validReceipt();
    const { ciphertextB64 } = encryptMessageBody(ONE, PUB_TWO, body);
    const out = decryptMessageBody(TWO, envOf(ciphertextB64, "osp.grant.receipt"), PUB_ONE);
    expect(out.body).toEqual(body);
  });

  test("typed osp.grant.request body round-trips at filing parity", () => {
    const body = validRequest();
    const { ciphertextB64 } = encryptMessageBody(ONE, PUB_TWO, body);
    const out = decryptMessageBody(TWO, envOf(ciphertextB64, "osp.grant.request"), PUB_ONE);
    expect(out.body).toEqual(body);
  });

  test("invalid inner body is rejected at filing parity", () => {
    const bad = { grantTxid: "zz", scopeHash: "b".repeat(64), doorGenesisTxid: "c".repeat(64) };
    const { ciphertextB64 } = encryptMessageBody(ONE, PUB_TWO, bad);
    expect(() => decryptMessageBody(TWO, envOf(ciphertextB64, "osp.grant.receipt"), PUB_ONE)).toThrow();
  });

  test("inner plaintext missing the msgId binding is rejected", () => {
    // Re-encrypt a malformed inner (no msgId) with the sender key directly.
    const inner = jcs({ body: "no binding" });
    const ct = EncryptedMessage.encrypt(Utils.toArray(inner, "utf8"), ONE, TWO.toPublicKey());
    expect(() => decryptMessageBody(TWO, envOf(Utils.toBase64(ct)), PUB_ONE)).toThrow(/msgId/);
  });
});
