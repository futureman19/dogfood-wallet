// agent-message-crypto.ts — S7: BRC-78 encrypted message bodies (design §13.4).
//
// Pure crypto helpers around @bsv/sdk EncryptedMessage (BRC-78 "Portable
// Encrypted Messages": BRC-42/43 key derivation + AES-256-GCM). No vault, no
// chain, no policy, no broadcast — those live in the gated decrypt operation
// (agent-message-decrypt.ts) and the guarded send rail (agent-message-send.ts).
//
// Security ceiling (recorded in §13.4, do not overclaim): BRC-78 is a
// NON-AUTHENTICATED key exchange. It gives confidentiality against passive
// on-chain readers and GCM tamper detection, but NO forward secrecy, NO replay
// protection and NO peer-identity authentication. Authorship is established
// separately by the AIP/BSM signature over the ciphertext; this module
// cross-checks the BRC-78 sender field against that authorship key. Replay is
// rejected by the application via the msgId binding + the decrypt dedupe store.
// Messages must never carry keys, credentials or private data.
//
// Plaintext binding: the encrypted plaintext is the canonical JSON of
//   { msgId: <32 hex>, body: <typed body>, expiryHeight?: <int> }
// so a ciphertext replay is detectable after decrypt (msgId reuse) and stale
// messages expire. The inner body is validated at filing parity on decrypt.
import { EncryptedMessage, PrivateKey, PublicKey, Utils } from "@bsv/sdk";
import { jcs } from "./osp-scope";
import {
  MESSAGE_ENC_ALG, BRC78_VERSION_HEX, MAX_ENCRYPTED_BODY_BYTES,
  randomNonce, assertValidBody, type Envelope,
} from "./agent-message";
import { parseGrantRequestBody, parseGrantReceiptBody } from "./agent-message-osp";

const PUB33_RE = /^(02|03)[0-9a-f]{64}$/;
const MSGID_RE = /^[0-9a-f]{32}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const INNER_KEYS = new Set(["msgId", "body", "expiryHeight"]);

function fail(m: string): never { throw new Error(`REJECTED: ${m}`); }
function safeNonNegInt(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail(`${label} must be a non-negative safe integer`);
  return v;
}

export type EncryptResult = { ciphertextB64: string; msgId: string; expiryHeight?: number };
export type Brc78Fields = { senderPubHex: string; recipientPubHex: string; keyIdHex: string; raw: number[] };
export type DecryptResult = {
  body: unknown; msgId: string; expiryHeight?: number;
  senderPubHex: string; recipientPubHex: string;
};

/**
 * Encrypt a typed message body for `recipientPubHex` (compressed secp256k1).
 * `senderKey` is the authorship key (its pubkey is embedded as the BRC-78
 * sender). Returns base64 ciphertext plus the msgId/expiry binding. The caller
 * (send rail) validates the plaintext body by type BEFORE calling this.
 */
export function encryptMessageBody(
  senderKey: PrivateKey, recipientPubHex: string, body: unknown,
  opts?: { msgId?: string; expiryHeight?: number },
): EncryptResult {
  if (typeof recipientPubHex !== "string" || !PUB33_RE.test(recipientPubHex)) fail("recipientPubHex must be a compressed pubkey hex");
  const recipientPub = PublicKey.fromString(recipientPubHex);
  const msgId = opts?.msgId ?? randomNonce();
  if (!MSGID_RE.test(msgId)) fail("msgId must be 32 lowercase hex chars");
  let expiryHeight: number | undefined;
  if (opts?.expiryHeight !== undefined) expiryHeight = safeNonNegInt(opts.expiryHeight, "expiryHeight");
  const inner: Record<string, unknown> = { msgId, body };
  if (expiryHeight !== undefined) inner.expiryHeight = expiryHeight;
  const plain = jcs(inner); // throws on floats / undefined / unsupported
  const ct = EncryptedMessage.encrypt(Utils.toArray(plain, "utf8"), senderKey, recipientPub);
  if (ct.length > MAX_ENCRYPTED_BODY_BYTES) fail(`ciphertext exceeds ${MAX_ENCRYPTED_BODY_BYTES} bytes`);
  return { ciphertextB64: Utils.toBase64(ct), msgId, ...(expiryHeight !== undefined ? { expiryHeight } : {}) };
}

/** Strictly parse a base64 BRC-78 message into its framing fields (no decrypt). */
export function parseBrc78(ciphertextB64: string): Brc78Fields {
  if (typeof ciphertextB64 !== "string" || !B64_RE.test(ciphertextB64)) fail("ciphertext must be a base64 string");
  const raw = Array.from(Buffer.from(ciphertextB64, "base64"));
  if (Buffer.from(raw).toString("base64") !== ciphertextB64) fail("ciphertext is not exact base64");
  if (raw.length < 103) fail("ciphertext too short for BRC-78 framing");
  if (raw.length > MAX_ENCRYPTED_BODY_BYTES) fail(`ciphertext exceeds ${MAX_ENCRYPTED_BODY_BYTES} bytes`);
  if (Utils.toHex(raw.slice(0, 4)) !== BRC78_VERSION_HEX) fail("not a BRC-78 message (version header)");
  const senderPubHex = Utils.toHex(raw.slice(4, 37));
  const recipientPubHex = Utils.toHex(raw.slice(37, 70));
  const keyIdHex = Utils.toHex(raw.slice(70, 102));
  if (!PUB33_RE.test(senderPubHex) || !PUB33_RE.test(recipientPubHex)) fail("BRC-78 pubkey fields are not compressed keys");
  return { senderPubHex, recipientPubHex, keyIdHex, raw };
}

/**
 * Decrypt an encrypted envelope body with the recipient key. Fail-closed:
 *  - envelope must carry enc=brc78;
 *  - the BRC-78 recipient field must equal this key's pubkey (wrong recipient);
 *  - the BRC-78 sender field must equal the verified AIP authorship pubkey;
 *  - GCM authentication must pass (tamper);
 *  - the inner plaintext must carry a valid msgId binding and a filing-parity
 *    valid body for envelope.type;
 *  - if currentHeight is given and an expiryHeight is bound, it must not be past.
 * Replay (msgId reuse) is NOT handled here — the gated decrypt operation owns
 * the dedupe store. Returns the plaintext body + binding, or throws.
 */
export function decryptMessageBody(
  recipientKey: PrivateKey, envelope: Envelope, authorshipPubHex: string,
  opts?: { currentHeight?: number },
): DecryptResult {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) fail("envelope must be an object");
  if (envelope.enc !== MESSAGE_ENC_ALG) fail("envelope is not encrypted (enc=brc78 required)");
  if (typeof authorshipPubHex !== "string" || !PUB33_RE.test(authorshipPubHex)) fail("authorshipPubHex must be a compressed pubkey hex");
  const fields = parseBrc78(envelope.body as string);
  const recipientPubHex = recipientKey.toPublicKey().toString();
  if (fields.recipientPubHex !== recipientPubHex) fail("ciphertext recipient does not match this vault key");
  if (fields.senderPubHex !== authorshipPubHex) fail("BRC-78 sender does not match the AIP authorship key");
  let plainBytes: number[];
  try { plainBytes = EncryptedMessage.decrypt(fields.raw, recipientKey); } catch { fail("decryption failed (wrong key or tampered ciphertext)"); }
  let inner: unknown;
  try { inner = JSON.parse(Buffer.from(plainBytes).toString("utf8")); } catch { fail("decrypted plaintext is not JSON"); }
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) fail("decrypted plaintext must be a JSON object");
  const rec = inner as Record<string, unknown>;
  for (const k of Object.keys(rec)) if (!INNER_KEYS.has(k)) fail(`unknown inner plaintext field '${k}'`);
  if (typeof rec.msgId !== "string" || !MSGID_RE.test(rec.msgId)) fail("inner msgId binding missing or invalid");
  if (!("body" in rec)) fail("inner plaintext missing body");
  let expiryHeight: number | undefined;
  if (rec.expiryHeight !== undefined) {
    expiryHeight = safeNonNegInt(rec.expiryHeight, "inner expiryHeight");
    if (opts?.currentHeight !== undefined && opts.currentHeight > expiryHeight) fail(`message expired at height ${expiryHeight}`);
  }
  // Filing parity: anything decryptable must be filable (same rules as filing).
  const type = envelope.type as string;
  if (type === "osp.grant.request") parseGrantRequestBody(rec.body);
  else if (type === "osp.grant.receipt") parseGrantReceiptBody(rec.body);
  else assertValidBody(type, rec.body);
  return {
    body: rec.body, msgId: rec.msgId,
    ...(expiryHeight !== undefined ? { expiryHeight } : {}),
    senderPubHex: fields.senderPubHex, recipientPubHex: fields.recipientPubHex,
  };
}
