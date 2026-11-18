// agent-message.test.ts — S1 codec + golden-vector tests (design §5, §12 S1).
// No broadcast, no vault, no network: pure byte-level codec tests with fixed
// test keys (same ONE/TWO convention as auth-sign.test.ts) plus one real-chain
// AIP anchor transaction pinned as an interop vector.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrivateKey, Utils } from "@bsv/sdk";
import {
  MESSAGE_APP,
  MESSAGE_V,
  MAX_BODY_BYTES,
  B_PREFIX,
  MAP_PREFIX,
  AIP_PREFIX,
  canonicalEnvelopeJson,
  signEnvelope,
  verifyEnvelope,
  verifyEnvelopeJson,
  randomNonce,
  aipPreimage,
  buildMessageScript,
  parseMessageScript,
  verifyMessageScript,
  verifyAipSection,
  buildLocusMessagePayload,
  parseLocusMessagePayload,
} from "./agent-message";
import { jcs } from "./osp-scope";
import { encodeGrant, buildEnvelopeScript, decode, bytesToHex } from "./osp-envelope";

const ONE = PrivateKey.fromString("1".padStart(64, "0"), 16);
const TWO = PrivateKey.fromString("2".padStart(64, "0"), 16);
const ADDR_ONE = ONE.toAddress();
const ADDR_TWO = TWO.toAddress();
const NONCE = "000102030405060708090a0b0c0d0e0f";
const TS = 1763000000;
const BODY = "handoff: build the inbox";

const baseEnv = () => ({
  app: MESSAGE_APP,
  v: MESSAGE_V,
  type: "message",
  from: ADDR_ONE,
  to: ADDR_TWO,
  nonce: NONCE,
  ts: TS,
  body: BODY,
});

// Real-chain AIP anchor (implicit mode), txid
// 5633bb966d9531d22df7ae98a70966eebe4379d400d74ac948bf5b4f2867092c.
// B("Hello world!") | AIP(BITCOIN_ECDSA, 1EXhSb..., uncompressed sig) | AIP(...).
// Verified against bitcoinfiles-sdk preimage rule + @1sat/templates semantics.
const ANCHOR_SCRIPT =
  "6a2231394878696756345179427633744870515663554551797131707a5a56646f4175740c48656c6c6f20776f726c64210a746578742f706c61696e057574662d380100017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676610d424954434f494e5f45434453412231455868536247466945415a4345356565427655785436634256486872705057587a411cacee1dbe375e3e17a662b560944e0ff78dff9f194744fb2ee462d905bc785727420d5deed4b2dd019023f550af4f4f7934050179e217220592a41882f0251ef4017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676610d424954434f494e5f45434453412231396e6b6e4c68526e474b525233686f6265467575716d48554d694e544b5a487352411c101c7d3cb207a6718e773856349b47e6676bf8b1be2c3096841b2181d736ab156645e0a84318dc0691574a26ed9a7c9b8abe7e0c30af845680259f59ceec319d";
const ANCHOR_ADDR = "1EXhSbGFiEAZCE5eeBvUxT6cBVHhrpPWXz";

const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const p2pkh = (addr: string) => {
  // canonical lowercase P2PKH script for an address (test fixture helper)
  const raw = Buffer.from(Utils.fromBase58Check(addr).data as number[]);
  return "76a914" + raw.toString("hex") + "88ac";
};

const validScopeBlob = () =>
  jcs({
    payment: { amount_sats: 100, script: p2pkh(ADDR_ONE) },
    salt: "aa".repeat(16),
  });

const grantRequestBody = () => ({
  scope: validScopeBlob(),
  doorGenesisTxid: "ab".repeat(32),
  doorOwnerAddress: ADDR_ONE,
  reason: "need read access to the metrics door",
  sessionPubHex: "02" + "ab".repeat(32),
});

describe("envelope canonicalization", () => {
  test("canonical bytes are JCS-subset sorted-key JSON", () => {
    const expected =
      `{"app":"dogfood","body":"${BODY}","from":"${ADDR_ONE}",` +
      `"nonce":"${NONCE}","to":"${ADDR_TWO}","ts":${TS},"type":"message","v":1}`;
    expect(canonicalEnvelopeJson(baseEnv())).toBe(expected);
  });

  test("optional agent-pin refs sort into canonical position", () => {
    const env = { ...baseEnv(), fromAgentPin: "cd".repeat(32) + ".0", toAgentPin: "ef".repeat(32) + ".1" };
    const canon = canonicalEnvelopeJson(env);
    expect(canon.indexOf('"fromAgentPin"')).toBeGreaterThan(canon.indexOf('"from"'));
    expect(canon.indexOf('"fromAgentPin"')).toBeLessThan(canon.indexOf('"nonce"'));
    expect(canon.indexOf('"toAgentPin"')).toBeGreaterThan(canon.indexOf('"to"'));
    expect(canon.indexOf('"toAgentPin"')).toBeLessThan(canon.indexOf('"ts"'));
  });

  test("rejects unknown envelope fields", () => {
    expect(() => canonicalEnvelopeJson({ ...baseEnv(), extra: 1 })).toThrow();
  });

  test("rejects missing required fields", () => {
    for (const k of ["app", "v", "type", "from", "to", "nonce", "ts", "body"]) {
      const env: Record<string, unknown> = baseEnv();
      delete env[k];
      expect(() => canonicalEnvelopeJson(env)).toThrow();
    }
  });

  test("rejects wrong app / version", () => {
    expect(() => canonicalEnvelopeJson({ ...baseEnv(), app: "other" })).toThrow();
    expect(() => canonicalEnvelopeJson({ ...baseEnv(), v: 2 })).toThrow();
    expect(() => canonicalEnvelopeJson({ ...baseEnv(), v: "1" })).toThrow();
  });

  test("rejects float / unsafe / negative ts", () => {
    expect(() => canonicalEnvelopeJson({ ...baseEnv(), ts: 1.5 })).toThrow();
    expect(() => canonicalEnvelopeJson({ ...baseEnv(), ts: Number.MAX_SAFE_INTEGER + 2 })).toThrow();
    expect(() => canonicalEnvelopeJson({ ...baseEnv(), ts: -1 })).toThrow();
    expect(() => canonicalEnvelopeJson({ ...baseEnv(), ts: "1763000000" })).toThrow();
  });

  test("rejects malformed nonce (length, case, non-hex)", () => {
    expect(() => canonicalEnvelopeJson({ ...baseEnv(), nonce: NONCE.toUpperCase() })).toThrow();
    expect(() => canonicalEnvelopeJson({ ...baseEnv(), nonce: "00".repeat(15) })).toThrow();
    expect(() => canonicalEnvelopeJson({ ...baseEnv(), nonce: "zz".repeat(16) })).toThrow();
    expect(() => canonicalEnvelopeJson({ ...baseEnv(), nonce: 42 })).toThrow();
  });

  test("randomNonce produces 32 lowercase hex chars", () => {
    const n = randomNonce();
    expect(n).toMatch(/^[0-9a-f]{32}$/);
    expect(randomNonce()).not.toBe(n);
  });

  test("rejects invalid type grammar", () => {
    for (const t of ["Message", "1abc", "a".repeat(65), "a b", "", "a/b", "a\nb"]) {
      expect(() => canonicalEnvelopeJson({ ...baseEnv(), type: t })).toThrow();
    }
    expect(canonicalEnvelopeJson({ ...baseEnv(), type: "osp.grant.request", body: grantRequestBody() })).toContain('"type":"osp.grant.request"');
  });

  test("rejects non-mainnet / non-P2PKH / garbage addresses", () => {
    for (const bad of ["mzYb1Y1Z1Z1Z1Z1Z1Z1Z1Z1Z1Z1Z1Z1Z1Z", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "not-an-address", ""]) {
      expect(() => canonicalEnvelopeJson({ ...baseEnv(), from: bad })).toThrow();
      expect(() => canonicalEnvelopeJson({ ...baseEnv(), to: bad })).toThrow();
    }
  });

  test("rejects malformed agent-pin refs", () => {
    for (const bad of ["cd".repeat(32), "cd".repeat(32) + ".", "CD".repeat(32) + ".0", "cd".repeat(32) + ".1.5", "cd".repeat(32) + ".-1", 42]) {
      expect(() => canonicalEnvelopeJson({ ...baseEnv(), fromAgentPin: bad })).toThrow();
    }
  });

  test("rejects unsupported value types via JCS discipline", () => {
    expect(() => canonicalEnvelopeJson({ ...baseEnv(), body: { x: 1.5 } })).toThrow();
    expect(() => canonicalEnvelopeJson({ ...baseEnv(), body: undefined })).toThrow();
  });
});

describe("message body validation", () => {
  test("message body is a bounded UTF-8 string", () => {
    expect(() => signEnvelope(ONE, { ...baseEnv(), body: "x".repeat(MAX_BODY_BYTES) })).not.toThrow();
    expect(() => signEnvelope(ONE, { ...baseEnv(), body: "x".repeat(MAX_BODY_BYTES + 1) })).toThrow();
    expect(() => signEnvelope(ONE, { ...baseEnv(), body: 42 })).toThrow();
    expect(() => signEnvelope(ONE, { ...baseEnv(), body: { a: 1 } })).toThrow();
    expect(() => signEnvelope(ONE, { ...baseEnv(), body: "a\u0000b" })).toThrow();
    expect(() => signEnvelope(ONE, { ...baseEnv(), body: "a\u0007b" })).toThrow();
    // newlines and tabs are allowed in coordination text
    expect(() => signEnvelope(ONE, { ...baseEnv(), body: "line1\nline2\tend" })).not.toThrow();
    // multibyte UTF-8 counts bytes, not code points
    expect(() => signEnvelope(ONE, { ...baseEnv(), body: "é".repeat(MAX_BODY_BYTES / 2) })).not.toThrow();
    expect(() => signEnvelope(ONE, { ...baseEnv(), body: "é".repeat(MAX_BODY_BYTES / 2 + 1) })).toThrow();
  });

  test("osp.grant.request body validates like requests.ts", () => {
    const env = { ...baseEnv(), type: "osp.grant.request", body: grantRequestBody() };
    const signed = signEnvelope(ONE, env);
    expect(verifyEnvelope(signed).envelope.type).toBe("osp.grant.request");
  });

  test("osp.grant.request rejects malformed fields", () => {
    const mk = (patch: Record<string, unknown>) => ({
      ...baseEnv(),
      type: "osp.grant.request",
      body: { ...grantRequestBody(), ...patch },
    });
    expect(() => signEnvelope(ONE, mk({ scope: '{"salt": "' + "aa".repeat(16) + '"}' }))).toThrow(); // non-canonical (space after colon)
    expect(() => signEnvelope(ONE, mk({ scope: jcs({ salt: "AA".repeat(16) }) }))).toThrow(); // uppercase salt
    expect(() => signEnvelope(ONE, mk({ scope: jcs({ salt: "aa".repeat(16), payment: { amount_sats: 0, script: p2pkh(ADDR_ONE) } }) }))).toThrow();
    expect(() => signEnvelope(ONE, mk({ doorGenesisTxid: "AB".repeat(32) }))).toThrow();
    expect(() => signEnvelope(ONE, mk({ doorGenesisTxid: "ab".repeat(31) }))).toThrow();
    expect(() => signEnvelope(ONE, mk({ doorOwnerAddress: "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy" }))).toThrow();
    expect(() => signEnvelope(ONE, mk({ reason: "x".repeat(281) }))).toThrow();
    expect(() => signEnvelope(ONE, mk({ reason: "bad\nnewline" }))).toThrow();
    expect(() => signEnvelope(ONE, mk({ sessionPubHex: "03" + "AB".repeat(32) }))).toThrow();
    expect(() => signEnvelope(ONE, mk({ sessionPubHex: "04" + "ab".repeat(32) }))).toThrow();
    expect(() => signEnvelope(ONE, mk({ expiryHeight: 1.5 }))).toThrow();
    expect(() => signEnvelope(ONE, mk({ maxEgressBytes: -1 }))).toThrow();
    expect(() => signEnvelope(ONE, mk({ extraField: 1 }))).toThrow();
  });

  test("osp.grant.request accepts optional expiry/egress", () => {
    const env = {
      ...baseEnv(),
      type: "osp.grant.request",
      body: { ...grantRequestBody(), expiryHeight: 900000, maxEgressBytes: 1048576 },
    };
    expect(() => signEnvelope(ONE, env)).not.toThrow();
  });

  test("osp.grant.receipt body is exactly three 64-hex fields", () => {
    const body = { grantTxid: "12".repeat(32), scopeHash: "34".repeat(32), doorGenesisTxid: "56".repeat(32) };
    const env = { ...baseEnv(), type: "osp.grant.receipt", body };
    expect(() => signEnvelope(ONE, env)).not.toThrow();
    expect(() => signEnvelope(ONE, { ...env, body: { ...body, extra: 1 } })).toThrow();
    expect(() => signEnvelope(ONE, { ...env, body: { ...body, grantTxid: "12".repeat(31) } })).toThrow();
    expect(() => signEnvelope(ONE, { ...env, body: { ...body, scopeHash: "ab".repeat(32).toUpperCase() } })).toThrow();
    const missing: Record<string, unknown> = { ...body };
    delete missing.doorGenesisTxid;
    expect(() => signEnvelope(ONE, { ...env, body: missing })).toThrow();
  });

  test("unknown types carry uninterpreted canonical bodies", () => {
    const env = { ...baseEnv(), type: "x402.offer", body: { amountSats: 100, resource: "/v1/expensive", nested: [1, 2, 3] } };
    const signed = signEnvelope(ONE, env);
    expect(verifyEnvelope(signed).envelope.body).toEqual(env.body);
    expect(() => signEnvelope(ONE, { ...env, body: { x: 1.5 } })).toThrow(); // JCS discipline still applies
  });
});

describe("envelope signing and verification", () => {
  test("sign/verify roundtrip recovers the signer pubkey", () => {
    const signed = signEnvelope(ONE, baseEnv());
    const { envelope, pubkey } = verifyEnvelope(signed);
    expect(envelope.from).toBe(ADDR_ONE);
    expect(pubkey).toBe(ONE.toPublicKey().toString());
    expect(typeof envelope.sig).toBe("string");
  });

  test("signing is deterministic (RFC6979) for fixed inputs", () => {
    const a = signEnvelope(ONE, baseEnv());
    const b = signEnvelope(ONE, baseEnv());
    expect(a.sig).toBe(b.sig);
    expect(canonicalEnvelopeJson(a)).toBe(canonicalEnvelopeJson(b));
  });

  test("from must equal the signing key's address", () => {
    expect(() => signEnvelope(ONE, { ...baseEnv(), from: ADDR_TWO })).toThrow();
  });

  test("tampered body fails verification", () => {
    const signed = signEnvelope(ONE, baseEnv());
    expect(() => verifyEnvelope({ ...signed, body: "tampered" })).toThrow();
    expect(() => verifyEnvelope({ ...signed, to: ADDR_ONE })).toThrow();
    expect(() => verifyEnvelope({ ...signed, ts: TS + 1 })).toThrow();
  });

  test("missing or malformed sig fails verification", () => {
    const signed = signEnvelope(ONE, baseEnv());
    const { sig: _drop, ...unsigned } = signed;
    expect(() => verifyEnvelope(unsigned)).toThrow();
    expect(() => verifyEnvelope({ ...signed, sig: "not-base64!!" })).toThrow();
    expect(() => verifyEnvelope({ ...signed, sig: Buffer.alloc(64).toString("base64") })).toThrow();
  });

  test("verifyEnvelopeJson demands byte-exact canonical input", () => {
    const signed = signEnvelope(ONE, baseEnv());
    const canon = canonicalEnvelopeJson(signed);
    expect(verifyEnvelopeJson(canon).envelope.from).toBe(ADDR_ONE);
    expect(() => verifyEnvelopeJson(canon.replace('{"app"', '{ "app"'))).toThrow(); // whitespace
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(canon)).reverse()));
    expect(() => verifyEnvelopeJson(reordered)).toThrow(); // unsorted keys
    expect(() => verifyEnvelopeJson("not json")).toThrow();
  });
});

describe("Option A — BitCom B|MAP|AIP script", () => {
  test("prefix constants match BitCom registrations", () => {
    expect(B_PREFIX).toBe("19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut");
    expect(MAP_PREFIX).toBe("1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5");
    expect(AIP_PREFIX).toBe("15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva");
  });

  test("build → parse → verify roundtrip", () => {
    const script = buildMessageScript(ONE, baseEnv());
    expect(script.startsWith("006a")).toBe(true); // OP_FALSE OP_RETURN per design §6.2 (amended: post-Genesis nodes exempt only 006a from dust)
    const parsed = parseMessageScript(script);
    expect(parsed.aipAddress).toBe(ADDR_ONE);
    expect(parsed.envelope.from).toBe(ADDR_ONE);
    expect(parsed.envelope.to).toBe(ADDR_TWO);
    expect(parsed.envelope.body).toBe(BODY);
    expect(parsed.envelope.sig).toBeUndefined(); // AIP is the authorship proof
    expect(parsed.pushes.length).toBe(18); // B(4) | MAP(8) | AIP(4) + 2 pipes
    const verified = verifyMessageScript(script);
    expect(verified.pubkey).toBe(ONE.toPublicKey().toString());
    expect(verified.envelope.type).toBe("message");
  });

  test("MAP carries app/type/to routing fields", () => {
    const script = buildMessageScript(ONE, baseEnv());
    const { pushes } = parseMessageScript(script);
    const text = pushes.map((p) => Buffer.from(p).toString("utf8"));
    expect(text[4]).toBe("|");
    expect(text[5]).toBe(MAP_PREFIX);
    expect(text[6]).toBe("SET");
    expect(text[7]).toBe("app");
    expect(text[8]).toBe("dogfood");
    expect(text[9]).toBe("type");
    expect(text[10]).toBe("message");
    expect(text[11]).toBe("to");
    expect(text[12]).toBe(ADDR_TWO);
    expect(text[13]).toBe("|");
    expect(text[14]).toBe(AIP_PREFIX);
    expect(text[15]).toBe("BITCOIN_ECDSA");
    expect(text[16]).toBe(ADDR_ONE);
    expect(pushes[17].length).toBe(65); // raw compact sig push (canonical build)
  });

  test("B section carries media type and encoding, no filename push", () => {
    const { pushes } = parseMessageScript(buildMessageScript(ONE, baseEnv()));
    expect(Buffer.from(pushes[0]).toString("utf8")).toBe(B_PREFIX);
    expect(Buffer.from(pushes[2]).toString("utf8")).toBe("application/json");
    expect(Buffer.from(pushes[3]).toString("utf8")).toBe("utf-8");
  });

  test("aipPreimage is 0x6a + raw concat of pushes left of AIP", () => {
    const { pushes } = parseMessageScript(buildMessageScript(ONE, baseEnv()));
    const left = pushes.slice(0, 14);
    const expected = Buffer.concat([Buffer.from([0x6a]), ...left.map((p) => Buffer.from(p))]);
    expect(Buffer.from(aipPreimage(left)).equals(expected)).toBe(true);
    expect(aipPreimage(left)[0]).toBe(0x6a);
  });

  test("real-chain AIP anchor verifies (uncompressed-key interop)", () => {
    const { address, pubkey } = verifyAipSection(ANCHOR_SCRIPT);
    expect(address).toBe(ANCHOR_ADDR);
    expect(pubkey.length).toBe(130); // uncompressed hex pubkey recovered
  });

  test("base64-ASCII signature push variant verifies (go-aip interop)", () => {
    const script = buildMessageScript(ONE, baseEnv());
    const { pushes } = parseMessageScript(script);
    const b64 = Buffer.from(pushes[17]).toString("base64");
    // rebuild with the sig pushed as base64 ASCII text
    const rebuilt = rebuildWithSigPush(script, Buffer.from(b64, "utf8"));
    expect(verifyMessageScript(rebuilt).pubkey).toBe(ONE.toPublicKey().toString());
  });

  test("bare OP_RETURN prefix variant parses (historical interop)", () => {
    const script = buildMessageScript(ONE, baseEnv());
    expect(script.startsWith("006a")).toBe(true);
    // pre-Genesis / historical bare-6a scripts must still verify
    expect(verifyMessageScript(script.slice(2)).envelope.from).toBe(ADDR_ONE);
  });

  test("tampered envelope push fails AIP verification", () => {
    const script = buildMessageScript(ONE, baseEnv());
    const bytes = Buffer.from(script, "hex");
    // flip a byte inside the envelope JSON push (find 'h' of 'handoff')
    const idx = bytes.indexOf(Buffer.from("handoff", "utf8"));
    expect(idx).toBeGreaterThan(0);
    bytes[idx] ^= 0x01;
    expect(() => verifyMessageScript(bytes.toString("hex"))).toThrow();
  });

  test("MAP/envelope cross-checks are enforced", () => {
    const script = buildMessageScript(ONE, baseEnv());
    // to mismatch: rebuild MAP 'to' value with ADDR_ONE
    expect(() => verifyMessageScript(replacePush(script, 12, Buffer.from(ADDR_ONE, "utf8")))).toThrow();
    // type mismatch
    expect(() => verifyMessageScript(replacePush(script, 10, Buffer.from("osp.grant.request", "utf8")))).toThrow();
    // app mismatch
    expect(() => verifyMessageScript(replacePush(script, 8, Buffer.from("other", "utf8")))).toThrow();
    // AIP address ≠ envelope.from
    expect(() => verifyMessageScript(replacePush(script, 16, Buffer.from(ADDR_TWO, "utf8")))).toThrow();
  });

  test("strict shape: wrong AIP field order rejected", () => {
    const script = buildMessageScript(ONE, baseEnv());
    // swap algorithm and address pushes
    const swapped = swapPushes(script, 15, 16);
    expect(() => parseMessageScript(swapped)).toThrow();
  });

  test("strict shape: missing pipe rejected", () => {
    const script = buildMessageScript(ONE, baseEnv());
    expect(() => parseMessageScript(removePush(script, 4))).toThrow();
    expect(() => parseMessageScript(removePush(script, 13))).toThrow();
  });

  test("strict shape: extra trailing push rejected (no field_indexes in v1)", () => {
    const script = buildMessageScript(ONE, baseEnv());
    expect(() => parseMessageScript(appendPush(script, Buffer.from("0", "utf8")))).toThrow();
  });

  test("strict shape: non-minimal pushdata rejected", () => {
    const script = buildMessageScript(ONE, baseEnv());
    // re-encode the 'SET' push (3 bytes) with OP_PUSHDATA1
    expect(() => parseMessageScript(nonMinimalPush(script, 6))).toThrow();
  });

  test("strict shape: empty push in message layout rejected", () => {
    const script = buildMessageScript(ONE, baseEnv());
    expect(() => parseMessageScript(replacePush(script, 2, Buffer.alloc(0)))).toThrow();
  });

  test("garbage / truncated scripts rejected", () => {
    expect(() => parseMessageScript("")).toThrow();
    expect(() => parseMessageScript("zz")).toThrow();
    expect(() => parseMessageScript("6a")).toThrow();
    expect(() => parseMessageScript("00")).toThrow();
    const script = buildMessageScript(ONE, baseEnv());
    expect(() => parseMessageScript(script.slice(0, 40))).toThrow();
    expect(() => verifyMessageScript(script.slice(0, script.length - 2))).toThrow();
  });

  test("envelope inside script must itself be canonical and valid", () => {
    const script = buildMessageScript(ONE, baseEnv());
    // replace envelope push with non-canonical JSON (whitespace)
    const envObj = JSON.parse(Buffer.from(parseMessageScript(script).pushes[1]).toString("utf8"));
    const nonCanon = JSON.stringify(envObj, null, 1);
    expect(() => verifyMessageScript(replacePush(script, 1, Buffer.from(nonCanon, "utf8")))).toThrow();
  });
});

describe("Option B — Locus mint payload", () => {
  const locusNonce = 7;

  test("build → parse → verify roundtrip", () => {
    const signed = signEnvelope(ONE, baseEnv());
    const payload = buildLocusMessagePayload(signed, TWO.toPublicKey().toString(), locusNonce);
    const parsed = parseLocusMessagePayload(payload);
    expect(parsed.owner).toBe(ADDR_TWO);
    expect(parsed.ownerPubkey).toBe(TWO.toPublicKey().toString());
    expect(parsed.envelope.from).toBe(ADDR_ONE);
    expect(parsed.envelope.body).toBe(BODY);
    expect(parsed.pubkey).toBe(ONE.toPublicKey().toString());
  });

  test("payload is canonical Locus mint with embedded signed envelope", () => {
    const signed = signEnvelope(ONE, baseEnv());
    const payload = buildLocusMessagePayload(signed, TWO.toPublicKey().toString(), locusNonce);
    const obj = JSON.parse(payload);
    expect(obj.p).toBe("locus");
    expect(obj.v).toBe(3);
    expect(obj.op).toBe("mint");
    expect(obj.type).toBe("object");
    expect(obj.subtype).toBe("agent-message");
    expect(obj.nonce).toBe(locusNonce);
    expect(obj.owner).toBe(ADDR_TWO);
    expect(obj.owner_pubkey).toBe(TWO.toPublicKey().toString());
    expect(typeof obj.ts).toBe("number");
    expect(obj.content).toBe(canonicalEnvelopeJson(signed));
    expect(payload).toBe(jcs(obj)); // canonical sorted-key JSON
    expect(obj.lat).toBeUndefined();
    expect(obj.lng).toBeUndefined();
    expect(obj.geohash).toBeUndefined();
  });

  test("owner must equal envelope.to", () => {
    const signed = signEnvelope(ONE, baseEnv());
    const payload = buildLocusMessagePayload(signed, TWO.toPublicKey().toString(), locusNonce);
    const obj = JSON.parse(payload);
    obj.owner = ADDR_ONE;
    obj.owner_pubkey = ONE.toPublicKey().toString();
    expect(() => parseLocusMessagePayload(jcs(obj))).toThrow();
  });

  test("rejects wrong protocol constants and unknown fields", () => {
    const signed = signEnvelope(ONE, baseEnv());
    const base = JSON.parse(buildLocusMessagePayload(signed, TWO.toPublicKey().toString(), locusNonce));
    for (const patch of [
      { p: "other" },
      { v: 2 },
      { op: "transfer" },
      { type: "agent" },
      { subtype: "note" },
      { extra: 1 },
    ]) {
      expect(() => parseLocusMessagePayload(jcs({ ...base, ...patch }))).toThrow();
    }
  });

  test("rejects malformed owner_pubkey / nonce / ts", () => {
    const signed = signEnvelope(ONE, baseEnv());
    const base = JSON.parse(buildLocusMessagePayload(signed, TWO.toPublicKey().toString(), locusNonce));
    expect(() => parseLocusMessagePayload(jcs({ ...base, owner_pubkey: TWO.toPublicKey().toString().toUpperCase() }))).toThrow();
    expect(() => parseLocusMessagePayload(jcs({ ...base, owner_pubkey: "04" + "ab".repeat(32) }))).toThrow();
    expect(() => parseLocusMessagePayload(jcs({ ...base, nonce: -1 }))).toThrow();
    expect(() => parseLocusMessagePayload(jcs({ ...base, nonce: 2 ** 32 }))).toThrow();
    expect(() => parseLocusMessagePayload(jcs({ ...base, nonce: 1.5 }))).toThrow();
    expect(() => parseLocusMessagePayload(jcs({ ...base, ts: 1.5 }))).toThrow();
  });

  test("rejects coordinate-bearing payloads in v1 codec", () => {
    const signed = signEnvelope(ONE, baseEnv());
    const base = JSON.parse(buildLocusMessagePayload(signed, TWO.toPublicKey().toString(), locusNonce));
    expect(() => parseLocusMessagePayload(jcs({ ...base, lat: 1, lng: 2 }))).toThrow();
    expect(() => parseLocusMessagePayload(jcs({ ...base, geohash: "9q" }))).toThrow();
  });

  test("rejects non-canonical payload JSON and tampered content", () => {
    const signed = signEnvelope(ONE, baseEnv());
    const payload = buildLocusMessagePayload(signed, TWO.toPublicKey().toString(), locusNonce);
    expect(() => parseLocusMessagePayload(payload.replace('{"content"', '{ "content"'))).toThrow();
    const obj = JSON.parse(payload);
    const env = JSON.parse(obj.content);
    env.body = "tampered";
    obj.content = JSON.stringify(env);
    expect(() => parseLocusMessagePayload(jcs(obj))).toThrow();
    // unsigned envelope content rejected
    const { sig: _drop, ...unsigned } = signed;
    expect(() => buildLocusMessagePayload(unsigned, TWO.toPublicKey().toString(), locusNonce)).toThrow();
  });

  test("build rejects recipient pubkey that does not hash to envelope.to", () => {
    const signed = signEnvelope(ONE, baseEnv());
    expect(() => buildLocusMessagePayload(signed, ONE.toPublicKey().toString(), locusNonce)).toThrow();
    expect(() => buildLocusMessagePayload(signed, "zz", locusNonce)).toThrow();
  });
});

describe("disjointness from OSP door envelopes", () => {
  test("agent-message script is not an OSP envelope", () => {
    const script = buildMessageScript(ONE, baseEnv());
    expect(() => decode(Buffer.from(script, "hex"))).toThrow();
  });

  test("OSP envelope script is not an agent message", () => {
    const grant = encodeGrant({
      doorId: new Uint8Array(32).fill(0xab),
      expiryHeight: 900000,
      maxEgress: 1048576,
      scopeHash: new Uint8Array(32).fill(0xcd),
      sessionPub: new Uint8Array(Utils.toArray("02" + "ab".repeat(32), "hex")),
    });
    const ospScript = bytesToHex(buildEnvelopeScript(grant));
    expect(() => parseMessageScript(ospScript)).toThrow();
    expect(() => verifyMessageScript(ospScript)).toThrow();
  });

  test("Locus message payload is not an OSP envelope", () => {
    const signed = signEnvelope(ONE, baseEnv());
    const payload = buildLocusMessagePayload(signed, TWO.toPublicKey().toString(), 7);
    expect(() => decode(Buffer.from(payload, "utf8"))).toThrow();
  });
});

describe("golden vectors (byte-pinned, testdata/message-vectors.json)", () => {
  const v = JSON.parse(readFileSync(join(import.meta.dir, "..", "testdata", "message-vectors.json"), "utf8"));

  test("vector keys/inputs match the fixed test constants", () => {
    expect(v.keys.sender.address).toBe(ADDR_ONE);
    expect(v.keys.recipient.address).toBe(ADDR_TWO);
    expect(v.keys.sender.pubkey).toBe(ONE.toPublicKey().toString());
    expect(v.keys.recipient.pubkey).toBe(TWO.toPublicKey().toString());
    expect(v.inputs).toEqual({ nonce: NONCE, ts: TS, body: BODY });
  });

  test("envelope: unsigned + signed canonical JSON and sig are byte-stable", () => {
    expect(canonicalEnvelopeJson(baseEnv())).toBe(v.envelope.unsignedCanonical);
    const signed = signEnvelope(ONE, baseEnv());
    expect(canonicalEnvelopeJson(signed)).toBe(v.envelope.signedCanonical);
    expect(signed.sig).toBe(v.envelope.sig);
    expect(verifyEnvelopeJson(v.envelope.signedCanonical).pubkey).toBe(v.keys.sender.pubkey);
  });

  test("Option A: script hex, AIP preimage and sig push are byte-stable", () => {
    expect(buildMessageScript(ONE, baseEnv())).toBe(v.optionA.scriptHex);
    const { envelope, pubkey, aipAddress } = verifyMessageScript(v.optionA.scriptHex);
    expect(pubkey).toBe(v.keys.sender.pubkey);
    expect(aipAddress).toBe(ADDR_ONE);
    expect(envelope.body).toBe(BODY);
    const { pushes } = parseMessageScript(v.optionA.scriptHex);
    expect(pushes.length).toBe(v.optionA.pushCount);
    expect(aipPreimage(pushes.slice(0, 14)).toString("hex")).toBe(v.optionA.preimageHex);
    expect(Buffer.from(pushes[17]).toString("hex")).toBe(v.optionA.aipSigHex);
  });

  test("Option A base64-ASCII sig variant verifies to the same key", () => {
    expect(verifyMessageScript(v.optionA_b64sig.scriptHex).pubkey).toBe(v.keys.sender.pubkey);
  });

  test("grant.request envelope + script are byte-stable", () => {
    const env = { ...baseEnv(), type: "osp.grant.request", body: v.grantRequest.body };
    const signed = signEnvelope(ONE, env);
    expect(canonicalEnvelopeJson(signed)).toBe(v.grantRequest.signedCanonical);
    expect(buildMessageScript(ONE, env)).toBe(v.grantRequest.scriptHex);
    expect(verifyMessageScript(v.grantRequest.scriptHex).envelope.type).toBe("osp.grant.request");
  });

  test("Option B: Locus payload JSON is byte-stable and round-trips", () => {
    const signed = signEnvelope(ONE, baseEnv());
    expect(buildLocusMessagePayload(signed, TWO.toPublicKey().toString(), v.optionB.locusNonce, v.optionB.ts)).toBe(v.optionB.payloadJson);
    const parsed = parseLocusMessagePayload(v.optionB.payloadJson);
    expect(parsed.owner).toBe(ADDR_TWO);
    expect(parsed.pubkey).toBe(v.keys.sender.pubkey);
    expect(canonicalEnvelopeJson(parsed.envelope)).toBe(v.envelope.signedCanonical);
  });

  test("real-chain AIP anchor verifies (interop, uncompressed key)", () => {
    const r = verifyAipSection(v.anchor.scriptHex);
    expect(r.address).toBe(v.anchor.claimedAddress);
    expect(r.pubkey.length).toBe(130);
  });
});

// ---- script surgery helpers for negative tests (minimal-push aware) ----

function splitPushes(scriptHex: string): { prefix: string; pushes: Buffer[] } {
  const b = Buffer.from(scriptHex, "hex");
  let i = 0;
  let prefix = "";
  if (b[0] === 0x00 && b[1] === 0x6a) {
    prefix = "006a";
    i = 2;
  } else if (b[0] === 0x6a) {
    prefix = "6a";
    i = 1;
  } else throw new Error("not an OP_RETURN script");
  const pushes: Buffer[] = [];
  while (i < b.length) {
    const op = b[i];
    if (op === 0) {
      pushes.push(Buffer.alloc(0));
      i += 1;
    } else if (op >= 1 && op <= 75) {
      pushes.push(b.subarray(i + 1, i + 1 + op));
      i += 1 + op;
    } else if (op === 0x4c) {
      const n = b[i + 1];
      pushes.push(b.subarray(i + 2, i + 2 + n));
      i += 2 + n;
    } else if (op === 0x4d) {
      const n = b.readUInt16LE(i + 1);
      pushes.push(b.subarray(i + 3, i + 3 + n));
      i += 3 + n;
    } else throw new Error("helper handles minimal direct/PUSHDATA1/2 pushes only");
  }
  return { prefix, pushes };
}

function encodeScript(prefix: string, pushes: Buffer[]): string {
  const parts: Buffer[] = [Buffer.from(prefix, "hex")];
  for (const p of pushes) {
    if (p.length === 0) parts.push(Buffer.from([0x00]));
    else if (p.length <= 75) parts.push(Buffer.from([p.length]), p);
    else if (p.length <= 255) parts.push(Buffer.from([0x4c, p.length]), p);
    else if (p.length <= 65535) {
      const len = Buffer.alloc(2);
      len.writeUInt16LE(p.length);
      parts.push(Buffer.from([0x4d]), len, p);
    } else throw new Error("too long for helper");
  }
  return Buffer.concat(parts).toString("hex");
}

function replacePush(scriptHex: string, idx: number, data: Buffer): string {
  const { prefix, pushes } = splitPushes(scriptHex);
  pushes[idx] = data;
  return encodeScript(prefix, pushes);
}

function removePush(scriptHex: string, idx: number): string {
  const { prefix, pushes } = splitPushes(scriptHex);
  pushes.splice(idx, 1);
  return encodeScript(prefix, pushes);
}

function appendPush(scriptHex: string, data: Buffer): string {
  const { prefix, pushes } = splitPushes(scriptHex);
  pushes.push(data);
  return encodeScript(prefix, pushes);
}

function swapPushes(scriptHex: string, a: number, b: number): string {
  const { prefix, pushes } = splitPushes(scriptHex);
  const t = pushes[a];
  pushes[a] = pushes[b];
  pushes[b] = t;
  return encodeScript(prefix, pushes);
}

function nonMinimalPush(scriptHex: string, idx: number): string {
  const { prefix, pushes } = splitPushes(scriptHex);
  const data = pushes[idx];
  const parts: Buffer[] = [Buffer.from(prefix, "hex")];
  pushes.forEach((p, i) => {
    if (i === idx) parts.push(Buffer.from([0x4c, data.length]), data);
    else if (p.length <= 75) parts.push(Buffer.from([p.length]), p);
    else parts.push(Buffer.from([0x4c, p.length]), p);
  });
  return Buffer.concat(parts).toString("hex");
}

function rebuildWithSigPush(scriptHex: string, sigData: Buffer): string {
  return replacePush(scriptHex, 17, sigData);
}
