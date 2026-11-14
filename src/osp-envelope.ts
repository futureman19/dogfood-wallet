// osp-envelope.ts — OSP-0002 envelope codec. Byte-exact TypeScript port of
// the audited reference (agent-border-protocol/src/osp-envelope.cjs), pinned
// by testdata/osp-vectors.json (46 golden checks via the independent Python
// checker upstream). The tested bytes are definitionally the shipped bytes.

const MAGIC = [0x4f, 0x53, 0x50]; // "OSP"
const VERSION = 0x01;
const TYPES = { GRANT: 0x01, REVOKE: 0x02 } as const;
export const OSP_GRANT_LEN = 114;
export const OSP_REVOKE_LEN = 38;

const FIELD_P = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F");
const modpow = (b: bigint, e: bigint, m: bigint): bigint => {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
};

const fail = (m: string): never => {
  throw new Error("OSP-0002: " + m);
};

/** session_pubkey must be a 33-byte compressed secp256k1 point, on the curve. */
export function validatePub(b: Uint8Array): void {
  if (!b || b.length !== 33 || (b[0] !== 0x02 && b[0] !== 0x03)) {
    fail("session_pubkey must be a 33-byte compressed point (02/03 prefix)");
  }
  let x = 0n;
  for (let i = 1; i < 33; i++) x = (x << 8n) | BigInt(b[i]!);
  if (x >= FIELD_P) fail("session_pubkey x-coordinate out of range");
  const y2 = (modpow(x, 3n, FIELD_P) + 7n) % FIELD_P;
  const y = modpow(y2, (FIELD_P + 1n) / 4n, FIELD_P);
  if ((y * y) % FIELD_P !== y2) fail("session_pubkey not on secp256k1");
}

const assertLen = (b: Uint8Array, n: number, name: string): void => {
  if (!b || b.length !== n) fail(`${name} must be ${n} bytes`);
};
const u32le = (n: number): number[] => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) fail("u32 out of range");
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
};
const u64le = (n: number | bigint): number[] => {
  if (typeof n === "number" && (!Number.isSafeInteger(n) || n < 0)) {
    fail("u64 must be a BigInt or a safe-integer Number");
  }
  let v = BigInt(n);
  if (v < 0n || v > 0xffffffffffffffffn) fail("u64 out of range");
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return [...b];
};
const ru32le = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const ru64le = (b: Uint8Array, o: number): bigint => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]!);
  return v;
};

export function encodeGrant(args: {
  doorId: Uint8Array;
  expiryHeight: number;
  maxEgress: number | bigint;
  scopeHash: Uint8Array;
  sessionPub: Uint8Array;
}): Uint8Array {
  const { doorId, expiryHeight, maxEgress, scopeHash, sessionPub } = args;
  assertLen(doorId, 32, "doorId");
  assertLen(scopeHash, 32, "scopeHash");
  validatePub(sessionPub);
  const out = new Uint8Array(OSP_GRANT_LEN);
  out.set(MAGIC, 0);
  out[3] = VERSION;
  out[4] = TYPES.GRANT;
  out.set(doorId, 5);
  out.set(u32le(expiryHeight), 37);
  out.set(u64le(maxEgress), 41);
  out.set(scopeHash, 49);
  out.set(sessionPub, 81);
  return out;
}

export function encodeRevoke(args: { doorId: Uint8Array; flag: 0 | 1 }): Uint8Array {
  const { doorId, flag } = args;
  assertLen(doorId, 32, "doorId");
  if (flag !== 0 && flag !== 1) fail("revoke flag must be 0x00 (close) or 0x01 (rotate)");
  const out = new Uint8Array(OSP_REVOKE_LEN);
  out.set(MAGIC, 0);
  out[3] = VERSION;
  out[4] = TYPES.REVOKE;
  out.set(doorId, 5);
  out[37] = flag;
  return out;
}

export type OspEnvelope =
  | { type: "grant"; doorId: Uint8Array; expiryHeight: number; maxEgress: bigint; scopeHash: Uint8Array; sessionPub: Uint8Array }
  | { type: "revoke"; doorId: Uint8Array; flag: 0 | 1 };

export function decode(input: Uint8Array | number[]): OspEnvelope {
  const b = input instanceof Uint8Array ? input : Uint8Array.from(input);
  if (b.length < 5) fail("envelope too short");
  if (b[0] !== MAGIC[0] || b[1] !== MAGIC[1] || b[2] !== MAGIC[2]) fail("bad magic");
  if (b[3] !== VERSION) fail("unknown version 0x" + b[3]!.toString(16));
  if (b[4] === TYPES.GRANT) {
    if (b.length !== OSP_GRANT_LEN) fail(`grant envelope must be ${OSP_GRANT_LEN} bytes, got ${b.length}`);
    const sessionPub = b.slice(81, 114);
    validatePub(sessionPub);
    return {
      type: "grant",
      doorId: b.slice(5, 37),
      expiryHeight: ru32le(b, 37),
      maxEgress: ru64le(b, 41),
      scopeHash: b.slice(49, 81),
      sessionPub,
    };
  }
  if (b[4] === TYPES.REVOKE) {
    if (b.length !== OSP_REVOKE_LEN) fail(`revoke envelope must be ${OSP_REVOKE_LEN} bytes, got ${b.length}`);
    const flag = b[37];
    if (flag !== 0 && flag !== 1) fail("revoke flag must be 0x00 or 0x01");
    return { type: "revoke", doorId: b.slice(5, 37), flag: flag as 0 | 1 };
  }
  return fail("unknown type 0x" + b[4]!.toString(16));
}

/** OSP-0002 §2 minimal push encode (direct / PUSHDATA1 / PUSHDATA2). */
export function minimalPush(data: Uint8Array): Uint8Array {
  const n = data.length;
  if (n <= 75) {
    const p = new Uint8Array(1 + n);
    p[0] = n;
    p.set(data, 1);
    return p;
  }
  if (n <= 255) {
    const p = new Uint8Array(2 + n);
    p[0] = 0x4c;
    p[1] = n;
    p.set(data, 2);
    return p;
  }
  if (n <= 65535) {
    const p = new Uint8Array(3 + n);
    p[0] = 0x4d;
    p[1] = n & 0xff;
    p[2] = (n >> 8) & 0xff;
    p.set(data, 3);
    return p;
  }
  return fail("payload too large for a single push");
}

/** OP_0 OP_RETURN <push> — the envelope output's locking script. */
export function buildEnvelopeScript(envBytes: Uint8Array): Uint8Array {
  const push = minimalPush(envBytes);
  const out = new Uint8Array(2 + push.length);
  out[0] = 0x00;
  out[1] = 0x6a;
  out.set(push, 2);
  return out;
}

export const bytesToHex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const hexToBytes = (h: string): Uint8Array => {
  if (h.length % 2 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("Invalid hex");
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return b;
};
/** Display (explorer) byte order ↔ internal little-endian hex. */
export const reverseHexBytes = (h: string): string => h.match(/../g)!.reverse().join("");
