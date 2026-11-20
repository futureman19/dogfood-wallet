// agent-message.ts — S1 codec for agent-to-agent messages (design §5).
// Pure byte-level encode/decode/sign/verify. NO broadcast, NO vault access,
// NO policy evaluation — those are S2+. Two wire formats, one envelope:
//
//   Option A (BitCom): OP_RETURN  B | MAP | AIP   (§5.3)
//   Option B (Locus):  canonical mint JSON, envelope embedded in `content` (§5.1)
//
// Envelope authorship is a Bitcoin Signed Message (BSM, @bsv/sdk compat —
// same primitive as auth-sign.ts) over the JCS-subset canonical envelope
// without `sig`. Option A additionally carries an AIP signature over the
// BitCom preimage; the two proofs are checked against the same `from`.
//
// AIP byte rules pinned from three references + one real-chain anchor tx
// (5633bb96…092c, verified in tests):
//   preimage = 0x6a || raw concat of ALL pushdata contents left of the AIP
//   prefix (pipes included; our layout has no empty pushes, so the
//   bitcoinfiles-sdk rule and @1sat/templates' per-protocol reconstruction
//   produce identical bytes).
//   signature push: canonical build = raw 65-byte compact (bitcoinfiles-sdk,
//   @1sat/templates); parse also accepts base64-ASCII (go-aip) and
//   uncompressed-key headers 27–30 (legacy interop). Envelope sigs are
//   always compressed (headers 31–34).

import { randomBytes } from "node:crypto";
import { BSM, BigNumber, Hash, PrivateKey, PublicKey, Signature, Utils } from "@bsv/sdk";
import { canonicalScope, jcs, scopePayment } from "./osp-scope";

export const MESSAGE_APP = "dogfood";
export const MESSAGE_V = 1;
export const MAX_BODY_BYTES = 4096;
export const MAX_REASON_BYTES = 280;
/** S7: the only supported envelope encryption algorithm marker. */
export const MESSAGE_ENC_ALG = "brc78";
/** BRC-78 version 0x42421033, serialized big-endian on the wire (§13.4 spike). */
export const BRC78_VERSION_HEX = "42421033";
/** Decoded-ciphertext cap: plaintext MAX_BODY_BYTES plus BRC-78 framing overhead. */
export const MAX_ENCRYPTED_BODY_BYTES = MAX_BODY_BYTES + 512;

// S5 live acceptance (2026-11-18): GorillaPool ARC rejects outputs below
// 546 sats as dust (peer policy; cf. bitcoin-sv node issue #35). The inbox
// notification tip and the minimum kept change are therefore 546 sats.
// Option B Locus pins stay 1 sat by protocol (deferred transport).
export const DUST_LIMIT_SATS = 546;
export const MESSAGE_TIP_SATS = DUST_LIMIT_SATS;

// BitCom protocol prefixes (bsv-standards references/bitcom-protocols.md).
export const B_PREFIX = "19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut";
export const MAP_PREFIX = "1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5";
export const AIP_PREFIX = "15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva";
const AIP_ALGORITHM = "BITCOIN_ECDSA";

export const LOCUS_P = "locus";
export const LOCUS_V = 3;
export const MESSAGE_SUBTYPE = "agent-message";

export type Envelope = Record<string, unknown>;

const ENVELOPE_KEYS = new Set(["app", "v", "type", "from", "to", "fromAgentPin", "toAgentPin", "nonce", "ts", "body", "sig", "enc"]);
const TYPE_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const AGENT_PIN_RE = /^[0-9a-f]{64}\.(0|[1-9][0-9]*)$/;
const PUBKEY_RE = /^(02|03)[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function fail(msg: string): never {
  throw new Error("agent-message: " + msg);
}

/** Mainnet P2PKH-format address (prefix 0x00, 20-byte hash). Accepts the
 * address form of both compressed and uncompressed keys; rejects testnet,
 * P2SH, and anything with a bad checksum. */
export function strictMainnetAddress(addr: unknown): string {
  if (typeof addr !== "string" || addr.length < 26 || addr.length > 35) fail("invalid address");
  let decoded: { data: number[] | string; prefix: number[] | string };
  try {
    decoded = Utils.fromBase58Check(addr);
  } catch {
    fail("invalid address (base58check)");
  }
  const prefix = decoded.prefix as number[];
  const data = decoded.data as number[];
  if (prefix.length !== 1 || prefix[0] !== 0x00 || data.length !== 20) fail("address must be mainnet P2PKH");
  return addr;
}

function safeNonNegInt(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail(`${what} must be a non-negative safe integer`);
  return v;
}

function validUtf8Text(s: string): boolean {
  // lone surrogates are not valid UTF-8; Buffer roundtrip replaces them
  return Buffer.from(s, "utf8").toString("utf8") === s;
}

function validateMessageBody(body: unknown): void {
  if (typeof body !== "string") fail("message body must be a string");
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) fail(`message body exceeds ${MAX_BODY_BYTES} bytes`);
  if (!validUtf8Text(body)) fail("message body is not valid UTF-8");
  for (const ch of body) {
    const c = ch.codePointAt(0)!;
    if ((c < 0x20 && c !== 0x0a && c !== 0x09) || c === 0x7f) fail("message body contains control characters");
  }
}

const GRANT_REQUEST_KEYS = new Set([
  "scope", "doorGenesisTxid", "doorOwnerAddress", "reason", "sessionPubHex", "expiryHeight", "maxEgressBytes",
]);

function validateGrantRequestBody(body: unknown): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) fail("osp.grant.request body must be an object");
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!GRANT_REQUEST_KEYS.has(k)) fail(`osp.grant.request body: unknown field '${k}'`);
  for (const k of ["scope", "doorGenesisTxid", "doorOwnerAddress", "reason", "sessionPubHex"]) {
    if (!(k in b)) fail(`osp.grant.request body: missing '${k}'`);
  }
  if (typeof b.scope !== "string") fail("scope must be a canonical JSON string");
  const scopeObj = canonicalScope(b.scope); // throws on non-canonical / missing salt
  scopePayment(scopeObj); // throws on malformed payment terms (wallet P2PKH profile)
  if (typeof b.doorGenesisTxid !== "string" || !HEX64_RE.test(b.doorGenesisTxid)) fail("doorGenesisTxid must be 64 lowercase hex");
  strictMainnetAddress(b.doorOwnerAddress);
  if (typeof b.reason !== "string") fail("reason must be a string");
  if (Buffer.byteLength(b.reason, "utf8") > MAX_REASON_BYTES) fail(`reason exceeds ${MAX_REASON_BYTES} bytes`);
  if (/[\x00-\x1f\x7f]/.test(b.reason)) fail("reason must be single-line");
  if (typeof b.sessionPubHex !== "string" || !PUBKEY_RE.test(b.sessionPubHex)) fail("sessionPubHex must be 33-byte compressed lowercase hex");
  if (b.expiryHeight !== undefined) safeNonNegInt(b.expiryHeight, "expiryHeight");
  if (b.maxEgressBytes !== undefined) safeNonNegInt(b.maxEgressBytes, "maxEgressBytes");
}

const GRANT_RECEIPT_KEYS = ["grantTxid", "scopeHash", "doorGenesisTxid"];

function validateGrantReceiptBody(body: unknown): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) fail("osp.grant.receipt body must be an object");
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length !== 3 || !GRANT_RECEIPT_KEYS.every((k) => keys.includes(k))) fail("osp.grant.receipt body must be exactly {grantTxid, scopeHash, doorGenesisTxid}");
  for (const k of GRANT_RECEIPT_KEYS) {
    if (typeof b[k] !== "string" || !HEX64_RE.test(b[k] as string)) fail(`${k} must be 64 lowercase hex`);
  }
}

function validateBody(type: string, body: unknown): void {
  if (type === "message") return validateMessageBody(body);
  if (type === "osp.grant.request") return validateGrantRequestBody(body);
  if (type === "osp.grant.receipt") return validateGrantReceiptBody(body);
  // Unknown types: uninterpreted, but JCS discipline + size cap still apply.
  const canon = jcs(body); // throws on floats / undefined / unsupported
  if (Buffer.byteLength(canon, "utf8") > MAX_BODY_BYTES) fail(`body exceeds ${MAX_BODY_BYTES} bytes`);
}

/** S7: a ciphertext body must be exact base64 decoding to a BRC-78-framed blob. */
function validateEncryptedBody(body: unknown): void {
  if (typeof body !== "string" || !B64_RE.test(body)) fail("encrypted body must be a base64 string");
  let raw: Buffer;
  try { raw = Buffer.from(body as string, "base64"); } catch { fail("encrypted body base64 decode failed"); }
  if (raw.toString("base64") !== body) fail("encrypted body is not exact base64");
  if (raw.length < 103) fail("encrypted body too short for BRC-78 framing");
  if (raw.length > MAX_ENCRYPTED_BODY_BYTES) fail(`encrypted body exceeds ${MAX_ENCRYPTED_BODY_BYTES} bytes`);
  if (raw.subarray(0, 4).toString("hex") !== BRC78_VERSION_HEX) fail("encrypted body is not a BRC-78 message");
}

/** S7: validate a decrypted inner plaintext body by type (filing parity hook). */
export function assertValidBody(type: string, body: unknown): void {
  validateBody(type, body);
}

function validateSigFormat(sig: unknown): Buffer {
  if (typeof sig !== "string" || !B64_RE.test(sig)) fail("sig must be base64");
  const raw = Buffer.from(sig, "base64");
  if (raw.length !== 65 || raw.toString("base64") !== sig) fail("sig must decode to exactly 65 bytes");
  if (raw[0] < 31 || raw[0] > 34) fail("envelope sig must use a compressed-key header (31-34)");
  return raw;
}

type SigPolicy = "forbidden" | "optional" | "required";

function validateEnvelope(env: unknown, sigPolicy: SigPolicy): Envelope {
  if (typeof env !== "object" || env === null || Array.isArray(env)) fail("envelope must be a JSON object");
  const e = env as Envelope;
  for (const k of Object.keys(e)) if (!ENVELOPE_KEYS.has(k)) fail(`unknown envelope field '${k}'`);
  for (const k of ["app", "v", "type", "from", "to", "nonce", "ts", "body"]) {
    if (!(k in e)) fail(`missing envelope field '${k}'`);
  }
  if (e.app !== MESSAGE_APP) fail(`app must be '${MESSAGE_APP}'`);
  if (e.v !== MESSAGE_V) fail(`v must be ${MESSAGE_V}`);
  if (typeof e.type !== "string" || !TYPE_RE.test(e.type)) fail("invalid type");
  strictMainnetAddress(e.from);
  strictMainnetAddress(e.to);
  if (typeof e.nonce !== "string" || !NONCE_RE.test(e.nonce)) fail("nonce must be 32 lowercase hex chars");
  safeNonNegInt(e.ts, "ts");
  for (const k of ["fromAgentPin", "toAgentPin"]) {
    if (e[k] !== undefined) {
      if (typeof e[k] !== "string" || !AGENT_PIN_RE.test(e[k] as string)) fail(`${k} must be <64hex>.<vout>`);
      const vout = Number((e[k] as string).split(".")[1]);
      if (!Number.isSafeInteger(vout) || vout > 0xffffffff) fail(`${k} vout out of range`);
    }
  }
  if (e.enc !== undefined) {
    // S7: encrypted envelope — body is a base64 BRC-78 ciphertext, NOT plaintext.
    // The inner plaintext body is validated at decrypt time (filing parity).
    if (e.enc !== MESSAGE_ENC_ALG) fail(`enc must be "${MESSAGE_ENC_ALG}" when present`);
    validateEncryptedBody(e.body);
  } else {
    validateBody(e.type as string, e.body);
  }
  if (e.sig !== undefined) {
    if (sigPolicy === "forbidden") fail("envelope must be unsigned here");
    validateSigFormat(e.sig);
  } else if (sigPolicy === "required") {
    fail("envelope sig is required");
  }
  return e;
}

/** Validate + canonicalize (JCS subset, sorted keys). `sig` optional. */
export function canonicalEnvelopeJson(env: unknown): string {
  return jcs(validateEnvelope(env, "optional"));
}

export function randomNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Sign an unsigned envelope with the vault root key. `from` must equal the
 * key's address. Deterministic (DRBG seeded by key+message, forceLowS). */
export function signEnvelope(key: PrivateKey, env: unknown): Envelope {
  const e = validateEnvelope(env, "forbidden");
  if (key.toAddress() !== e.from) fail("from must equal the signing key's address");
  const canonical = jcs(e);
  const sig = BSM.sign(Utils.toArray(canonical, "utf8"), key, "base64") as string;
  return { ...e, sig };
}

function verifyEnvelopeSig(e: Envelope): string {
  const raw = validateSigFormat(e.sig);
  const { sig: _drop, ...unsigned } = e;
  const message = Utils.toArray(jcs(unsigned), "utf8");
  const sig = Signature.fromCompact(e.sig as string, "base64");
  const pub = sig.RecoverPublicKey(raw[0] - 31, new BigNumber(BSM.magicHash(message)));
  if (pub.toAddress() !== e.from) fail("envelope sig does not recover from");
  if (!BSM.verify(message, sig, pub)) fail("envelope sig verification failed");
  return pub.toString();
}

/** Verify a signed envelope object. Returns the recovered compressed pubkey hex. */
export function verifyEnvelope(value: unknown): { envelope: Envelope; pubkey: string } {
  const e = validateEnvelope(value, "required");
  return { envelope: e, pubkey: verifyEnvelopeSig(e) };
}

/** Verify a signed envelope given as JSON text; input must be byte-exact canonical. */
export function verifyEnvelopeJson(json: string): { envelope: Envelope; pubkey: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail("envelope JSON is not parseable");
  }
  const e = validateEnvelope(parsed, "required");
  if (jcs(e) !== json) fail("envelope JSON is not canonical (byte-exact required)");
  return { envelope: e, pubkey: verifyEnvelopeSig(e) };
}

// ---- script push encoding / strict decoding ----

function minimalPush(data: Buffer): Buffer {
  const n = data.length;
  if (n === 0) return Buffer.from([0x00]);
  if (n <= 75) return Buffer.concat([Buffer.from([n]), data]);
  if (n <= 255) return Buffer.concat([Buffer.from([0x4c, n]), data]);
  if (n <= 65535) {
    const len = Buffer.alloc(2);
    len.writeUInt16LE(n);
    return Buffer.concat([Buffer.from([0x4d]), len, data]);
  }
  fail("push too large");
}

interface DecodedScript {
  prefix: string; // "6a" | "006a"
  pushes: Buffer[];
}

/** Strict OP_RETURN data-script decoder: minimal pushes only, no opcodes
 * other than data pushes (OP_0 accepted as an empty push for interop). */
function decodeScript(scriptHex: string): DecodedScript {
  if (typeof scriptHex !== "string" || scriptHex.length === 0 || scriptHex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(scriptHex)) {
    fail("script must be non-empty lowercase hex");
  }
  const b = Buffer.from(scriptHex, "hex");
  let i = 0;
  let prefix: string;
  if (b[0] === 0x00 && b[1] === 0x6a) {
    prefix = "006a";
    i = 2;
  } else if (b[0] === 0x6a) {
    prefix = "6a";
    i = 1;
  } else {
    fail("script must start with OP_RETURN (6a or 006a)");
  }
  const pushes: Buffer[] = [];
  while (i < b.length) {
    const op = b[i];
    let data: Buffer;
    if (op === 0x00) {
      data = Buffer.alloc(0);
      i += 1;
    } else if (op >= 1 && op <= 75) {
      if (i + 1 + op > b.length) fail("truncated push");
      data = b.subarray(i + 1, i + 1 + op);
      i += 1 + op;
    } else if (op === 0x4c) {
      if (i + 2 > b.length) fail("truncated PUSHDATA1");
      const n = b[i + 1];
      if (n <= 75) fail("non-minimal PUSHDATA1");
      if (i + 2 + n > b.length) fail("truncated PUSHDATA1 payload");
      data = b.subarray(i + 2, i + 2 + n);
      i += 2 + n;
    } else if (op === 0x4d) {
      if (i + 3 > b.length) fail("truncated PUSHDATA2");
      const n = b.readUInt16LE(i + 1);
      if (n <= 255) fail("non-minimal PUSHDATA2");
      if (i + 3 + n > b.length) fail("truncated PUSHDATA2 payload");
      data = b.subarray(i + 3, i + 3 + n);
      i += 3 + n;
    } else if (op === 0x4e) {
      if (i + 5 > b.length) fail("truncated PUSHDATA4");
      const n = b.readUInt32LE(i + 1);
      if (n <= 65535) fail("non-minimal PUSHDATA4");
      if (i + 5 + n > b.length) fail("truncated PUSHDATA4 payload");
      data = b.subarray(i + 5, i + 5 + n);
      i += 5 + n;
    } else {
      fail(`unexpected opcode 0x${op.toString(16)} in data script`);
    }
    pushes.push(data);
  }
  return { prefix, pushes };
}

function encodeScript(prefix: string, pushes: Buffer[]): string {
  return Buffer.concat([Buffer.from(prefix, "hex"), ...pushes.map(minimalPush)]).toString("hex");
}

const utf8 = (s: string) => Buffer.from(s, "utf8");
const asText = (b: Buffer) => b.toString("utf8");

/** AIP preimage: 0x6a || raw concat of pushdata contents (no length prefixes). */
export function aipPreimage(pushesLeftOfAip: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([0x6a]), ...pushesLeftOfAip]);
}

function uncompressedAddress(pub: PublicKey): string {
  const enc = pub.encode(false) as number[];
  return Utils.toBase58Check(Hash.ripemd160(Hash.sha256(enc)), [0x00]);
}

/** Decode an AIP signature push: raw 65 bytes (canonical) or base64 ASCII
 * (go-aip interop). Returns compact bytes + whether the key is compressed. */
function decodeAipSigPush(push: Buffer): { raw: Buffer; compressed: boolean } {
  const tryRaw = (raw: Buffer) => {
    if (raw.length === 65 && raw[0] >= 27 && raw[0] <= 34) {
      return { raw, compressed: raw[0] >= 31 };
    }
    return null;
  };
  const direct = tryRaw(push);
  if (direct) return direct;
  const text = asText(push);
  if (B64_RE.test(text)) {
    const raw = Buffer.from(text, "base64");
    if (raw.length === 65 && raw.toString("base64") === text) {
      const viaB64 = tryRaw(raw);
      if (viaB64) return viaB64;
    }
  }
  fail("AIP signature push must be 65-byte compact (raw or base64 ASCII), header 27-34");
}

function verifyAipAt(pushes: Buffer[], aipIdx: number): { address: string; pubkey: string; preimage: Buffer } {
  if (asText(pushes[aipIdx]) !== AIP_PREFIX) fail("not an AIP section");
  if (pushes.length < aipIdx + 4) fail("AIP section needs algorithm, address, signature");
  if (asText(pushes[aipIdx + 1]) !== AIP_ALGORITHM) fail(`unsupported AIP algorithm (want ${AIP_ALGORITHM})`);
  const address = strictMainnetAddress(asText(pushes[aipIdx + 2]));
  const { raw, compressed } = decodeAipSigPush(pushes[aipIdx + 3]);
  const preimage = aipPreimage(pushes.slice(0, aipIdx));
  const message = Array.from(preimage);
  const flag = compressed ? raw[0] - 31 : raw[0] - 27;
  const sig = Signature.fromCompact(raw.toString("base64"), "base64");
  let pub: PublicKey;
  try {
    pub = sig.RecoverPublicKey(flag, new BigNumber(BSM.magicHash(message)));
  } catch {
    fail("AIP signature recovery failed");
  }
  const recoveredAddr = compressed ? pub.toAddress() : uncompressedAddress(pub);
  if (recoveredAddr !== address) fail("AIP signature does not recover the claimed address");
  if (!BSM.verify(message, sig, pub)) fail("AIP signature verification failed");
  const pubkey = compressed ? pub.toString() : Buffer.from(pub.encode(false) as number[]).toString("hex");
  return { address, pubkey, preimage };
}

/** Verify the FIRST AIP section of any BitCom OP_RETURN script (interop
 * helper; works on B-only chains like the real-chain anchor fixture). */
export function verifyAipSection(scriptHex: string): { address: string; pubkey: string; preimage: Buffer } {
  const { pushes } = decodeScript(scriptHex);
  const idx = pushes.findIndex((p) => asText(p) === AIP_PREFIX);
  if (idx < 0) fail("no AIP section found");
  return verifyAipAt(pushes, idx);
}

// ---- Option A: BitCom B|MAP|AIP ----

/** Build the Option A message OP_RETURN script (OP_FALSE OP_RETURN / 006a
 * per design §6.2, amended 2026-11-18: post-Genesis BSV nodes treat bare 6a
 * 0-sat outputs as spendable dust and ARC peers reject them; only 006a is
 * provably unspendable. The AIP preimage stays 0x6a-based, so signatures are
 * prefix-independent). The envelope is embedded WITHOUT sig — the AIP
 * signature is the authorship proof over the whole preimage (which includes
 * the envelope bytes). */
export function buildMessageScript(key: PrivateKey, env: unknown): string {
  const e = validateEnvelope(env, "forbidden");
  if (key.toAddress() !== e.from) fail("from must equal the signing key's address");
  const bSection = [utf8(B_PREFIX), utf8(jcs(e)), utf8("application/json"), utf8("utf-8")];
  const mapSection = [
    utf8(MAP_PREFIX), utf8("SET"), utf8("app"), utf8(MESSAGE_APP),
    utf8("type"), utf8(e.type as string), utf8("to"), utf8(e.to as string),
  ];
  const left = [...bSection, utf8("|"), ...mapSection, utf8("|")];
  const sigB64 = BSM.sign(Array.from(aipPreimage(left)), key, "base64") as string;
  const sigRaw = Buffer.from(sigB64, "base64");
  const aipSection = [utf8(AIP_PREFIX), utf8(AIP_ALGORITHM), utf8(e.from as string), sigRaw];
  return encodeScript("006a", [...left, ...aipSection]);
}

const MESSAGE_PUSH_COUNT = 18; // B(4) + | + MAP(8) + | + AIP(4)

/** Strict shape parse of an Option A message script. Does NOT verify the
 * AIP signature (use verifyMessageScript for that). */
export function parseMessageScript(scriptHex: string): { envelope: Envelope; aipAddress: string; pushes: Buffer[] } {
  const { pushes } = decodeScript(scriptHex);
  if (pushes.length !== MESSAGE_PUSH_COUNT) fail(`expected ${MESSAGE_PUSH_COUNT} pushes, got ${pushes.length}`);
  for (const p of pushes) if (p.length === 0) fail("empty pushes are not allowed in the message layout");
  const expectText = (idx: number, want: string) => {
    if (asText(pushes[idx]) !== want) fail(`push ${idx} must be '${want}'`);
  };
  expectText(0, B_PREFIX);
  expectText(2, "application/json");
  expectText(3, "utf-8");
  expectText(4, "|");
  expectText(5, MAP_PREFIX);
  expectText(6, "SET");
  expectText(7, "app");
  expectText(8, MESSAGE_APP);
  expectText(9, "type");
  expectText(11, "to");
  expectText(13, "|");
  expectText(14, AIP_PREFIX);
  expectText(15, AIP_ALGORITHM);
  let envObj: unknown;
  try {
    envObj = JSON.parse(asText(pushes[1]));
  } catch {
    fail("envelope push is not valid JSON");
  }
  const envelope = validateEnvelope(envObj, "optional");
  if (jcs(envelope) !== asText(pushes[1])) fail("envelope push is not canonical JSON");
  if (envelope.app !== MESSAGE_APP) fail("MAP app mismatch");
  if (asText(pushes[10]) !== envelope.type) fail("MAP type does not match envelope.type");
  if (asText(pushes[12]) !== envelope.to) fail("MAP to does not match envelope.to");
  const aipAddress = strictMainnetAddress(asText(pushes[16]));
  if (aipAddress !== envelope.from) fail("AIP address does not match envelope.from");
  decodeAipSigPush(pushes[17]); // shape check only
  return { envelope, aipAddress, pushes };
}

/** Parse + verify an Option A message script: strict shape, AIP signature,
 * MAP/envelope cross-checks, and (if present) the embedded envelope sig. */
export function verifyMessageScript(scriptHex: string): { envelope: Envelope; pubkey: string; aipAddress: string } {
  const { envelope, aipAddress, pushes } = parseMessageScript(scriptHex);
  const aip = verifyAipAt(pushes, 14);
  if (envelope.sig !== undefined) verifyEnvelopeSig(envelope);
  return { envelope, pubkey: aip.pubkey, aipAddress };
}

// ---- Option B: Locus mint payload ----

const LOCUS_PAYLOAD_KEYS = new Set([
  "p", "v", "op", "type", "subtype", "nonce", "ts", "owner", "owner_pubkey", "content",
]);

/** Build the canonical Locus mint JSON carrying a signed envelope. The
 * recipient is the pin owner; owner_pubkey must hash to envelope.to.
 * Coordinate-less by design (v1); `ts` defaults to now, pass a fixed value
 * for golden vectors. */
export function buildLocusMessagePayload(signedEnv: unknown, recipientPubkeyHex: string, locusNonce: number, ts?: number): string {
  const { envelope } = verifyEnvelope(signedEnv);
  if (typeof recipientPubkeyHex !== "string" || !PUBKEY_RE.test(recipientPubkeyHex)) fail("recipient pubkey must be 33-byte compressed lowercase hex");
  const recipientPub = PublicKey.fromString(recipientPubkeyHex);
  if (recipientPub.toAddress() !== envelope.to) fail("recipient pubkey does not hash to envelope.to");
  if (typeof locusNonce !== "number" || !Number.isSafeInteger(locusNonce) || locusNonce < 0 || locusNonce > 0xffffffff) fail("locus nonce must be a uint32");
  const payloadTs = ts === undefined ? Math.floor(Date.now() / 1000) : safeNonNegInt(ts, "ts");
  const payload = {
    p: LOCUS_P,
    v: LOCUS_V,
    op: "mint",
    type: "object",
    subtype: MESSAGE_SUBTYPE,
    nonce: locusNonce,
    ts: payloadTs,
    owner: envelope.to as string,
    owner_pubkey: recipientPubkeyHex,
    content: canonicalEnvelopeJson(signedEnv),
  };
  return jcs(payload);
}

/** Strict parse + verify of a Locus message mint payload (canonical JSON
 * text). Verifies the embedded envelope signature and owner binding. */
export function parseLocusMessagePayload(json: string): { envelope: Envelope; owner: string; ownerPubkey: string; pubkey: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    fail("locus payload is not valid JSON");
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) fail("locus payload must be a JSON object");
  const o = obj as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!LOCUS_PAYLOAD_KEYS.has(k)) fail(`locus payload: unknown/unsupported field '${k}' (v1 is coordinate-less)`);
  }
  for (const k of LOCUS_PAYLOAD_KEYS) if (!(k in o)) fail(`locus payload: missing '${k}'`);
  if (o.p !== LOCUS_P) fail("p must be 'locus'");
  if (o.v !== LOCUS_V) fail(`v must be ${LOCUS_V}`);
  if (o.op !== "mint") fail("op must be 'mint'");
  if (o.type !== "object") fail("type must be 'object'");
  if (o.subtype !== MESSAGE_SUBTYPE) fail(`subtype must be '${MESSAGE_SUBTYPE}'`);
  if (typeof o.nonce !== "number" || !Number.isSafeInteger(o.nonce) || o.nonce < 0 || o.nonce > 0xffffffff) fail("nonce must be a uint32");
  safeNonNegInt(o.ts, "ts");
  const owner = strictMainnetAddress(o.owner);
  if (typeof o.owner_pubkey !== "string" || !PUBKEY_RE.test(o.owner_pubkey)) fail("owner_pubkey must be 33-byte compressed lowercase hex");
  if (PublicKey.fromString(o.owner_pubkey).toAddress() !== owner) fail("owner_pubkey does not hash to owner");
  if (typeof o.content !== "string") fail("content must be the canonical signed envelope JSON string");
  const { envelope, pubkey } = verifyEnvelopeJson(o.content);
  if (envelope.to !== owner) fail("envelope.to must equal the pin owner");
  if (jcs(o) !== json) fail("locus payload is not canonical JSON");
  return { envelope, owner, ownerPubkey: o.owner_pubkey, pubkey };
}
