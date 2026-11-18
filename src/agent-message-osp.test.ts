// S4 — OSP typed messages. RED suite first (repo TDD gate).
// Wire format pinned by the S1 codec: typed bodies are JSON OBJECTS —
// request {scope, doorGenesisTxid, doorOwnerAddress, reason, sessionPubHex,
// expiryHeight?, maxEgressBytes?}; receipt {grantTxid, scopeHash,
// doorGenesisTxid}. Doctrine: bodies are validated with the SAME rules
// requests.ts applies at filing, before any key or chain access; scope
// travels byte-pinned; filing stays an explicit agent action (no auto-file);
// receipts are pointers — the chain is the truth. Zero broadcasts: every
// transport intercepted.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P2PKH, PrivateKey, Script, Transaction } from "@bsv/sdk";
import { initVault, loadVault, vaultPaths } from "./vault";
import { doorInit, loadOspDoor, signOspGrant } from "./osp";
import { approveRequest, fileRequest, listRequests } from "./requests";
import { sendAgentMessage } from "./agent-message-send";
import { scanInbox } from "./agent-message-inbox";
import { jcs, scopeHashHex } from "./osp-scope";
import { ospAddress, ospTipScriptHex } from "./osp-address";
import { mockFetch } from "./test-support/fetch";
import {
  parseGrantRequestBody,
  parseGrantReceiptBody,
  matchDoor,
  grantRequestToFilingInput,
  verifyGrantReceipt,
} from "./agent-message-osp";

const ONE = PrivateKey.fromString("1".padStart(64, "0"), 16);
const TWO = PrivateKey.fromString("2".padStart(64, "0"), 16);
const ADDR_ONE = ONE.toAddress();
const ADDR_TWO = TWO.toAddress();
const TXID_A = "ab".repeat(32);
const TXID_B = "cd".repeat(32);
const HASH = "ef".repeat(32);
const SESSION_PUB = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const UNPAID_SCOPE = '{"allow":["read:users"],"rate":"60/min","salt":"00112233445566778899aabbccddeeff"}';
const WOC = "https://api.whatsonchain.com/v1/bsv/main";
const ARC = "https://arc.gorillapool.io/v1/tx";

const scratch = () => mkdtempSync(join(tmpdir(), "dogfood-msg-osp-"));

function paidScope(script: string, sats = 10): string {
  return jcs({ allow: ["read:users"], payment: { amount_sats: sats, script }, salt: "ff".repeat(16) });
}

function requestBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    scope: UNPAID_SCOPE,
    doorGenesisTxid: TXID_A,
    doorOwnerAddress: ADDR_TWO,
    reason: "need read access",
    sessionPubHex: SESSION_PUB,
    ...over,
  });
}

function receiptBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ grantTxid: TXID_B, scopeHash: HASH, doorGenesisTxid: TXID_A, ...over });
}

function enableMessages(root: string, block: Record<string, unknown> = { maxPerDay: 10, maxBodyBytes: 8192 }): void {
  const path = vaultPaths(root).policy;
  const policy = JSON.parse(readFileSync(path, "utf8"));
  policy.messages = block;
  writeFileSync(path, JSON.stringify(policy, null, 2));
}

/** Synthetic funded source owned by the vault; real txid so source binding passes. */
function funding(root: string, value = 100_000) {
  const v = loadVault(root);
  const src = new Transaction();
  src.addOutput({ satoshis: value, lockingScript: new P2PKH().lock(v.address) });
  const hex = src.toHex();
  const coin = { tx_hash: src.id("hex"), tx_pos: 0, value };
  return { coin, fetchUtxos: async () => [coin], fetchTxHex: async () => hex };
}

function intercepted() {
  const sent: string[] = [];
  return {
    sent,
    broadcast: async (rawTx: string) => {
      sent.push(rawTx);
      return { txid: Transaction.fromHex(rawTx).id("hex") };
    },
  };
}

/** OSP mock-chain harness (same shape as osp.test.ts fundedVault). */
function ospVault(root: string) {
  initVault(root);
  const raw = JSON.parse(readFileSync(vaultPaths(root).policy, "utf8"));
  raw.osp = { maxSatsPerTx: 1000, maxSatsPerDay: 5000 };
  writeFileSync(vaultPaths(root).policy, JSON.stringify(raw, null, 2) + "\n");
  const vault = loadVault(root);
  const vaultScript = new P2PKH().lock(vault.address).toHex();
  const tipScript = ospTipScriptHex(vault.key);
  const owner = ospAddress(vault.key);
  const seed = new Transaction();
  seed.addInput({ sourceTXID: "00".repeat(32), sourceOutputIndex: 0xffffffff, unlockingScript: Script.fromASM("OP_0") });
  seed.addOutput({ satoshis: 100_000, lockingScript: Script.fromHex(vaultScript) });
  const state = {
    tip: null as { txid: string; vout: number } | null,
    txs: new Map<string, string>([[seed.id("hex"), seed.toHex()]]),
    broadcasts: [] as Transaction[],
  };
  const fetchFn = mockFetch(async (input, init) => {
    const u = String(input);
    if (u === `${WOC}/address/${vault.address}/unspent`)
      return Response.json([{ tx_hash: seed.id("hex"), tx_pos: 0, value: 100_000 }]);
    if (u === `${WOC}/address/${owner}/unspent`)
      return Response.json(state.tip ? [{ tx_hash: state.tip.txid, tx_pos: state.tip.vout, value: 1 }] : []);
    const hexMatch = u.match(new RegExp(`^${WOC}/tx/([0-9a-f]{64})/hex$`));
    if (hexMatch) {
      const hex = state.txs.get(hexMatch[1]!);
      if (!hex) throw new Error("Unexpected network: unknown tx " + hexMatch[1]);
      return new Response(hex);
    }
    if (u === ARC && init?.method === "POST") {
      const rawTx = (JSON.parse(String(init.body)) as { rawTx: string }).rawTx;
      const tx = Transaction.fromHex(rawTx);
      const txid = tx.id("hex");
      state.txs.set(txid, rawTx);
      state.broadcasts.push(tx);
      state.tip = null;
      tx.outputs.forEach((o, i) => {
        // OSP door tip: 1 sat by OSP protocol (distinct from the 546-sat
        // dust-safe agent-message inbox tip).
        if (o.satoshis === 1 && o.lockingScript.toHex() === tipScript) state.tip = { txid, vout: i };
      });
      return Response.json({ txid, txStatus: "SEEN_ON_NETWORK" });
    }
    throw new Error(`Unexpected network: ${u}`);
  });
  return { vault, vaultScript, tipScript, owner, state, fetchFn };
}

describe("parseGrantRequestBody (validation parity with requests.ts)", () => {
  test("valid full body round-trips with every optional field", () => {
    const r = parseGrantRequestBody(requestBody({ expiryHeight: 950000, maxEgressBytes: 4096 }));
    expect(r.doorGenesisTxid).toBe(TXID_A);
    expect(r.doorOwnerAddress).toBe(ADDR_TWO);
    expect(r.scope).toBe(UNPAID_SCOPE);
    expect(r.expiryHeight).toBe(950000);
    expect(r.maxEgressBytes).toBe(4096);
    expect(r.sessionPubHex).toBe(SESSION_PUB);
    expect(r.reason).toBe("need read access");
  });

  test("valid minimal body: optionals absent, required fields pinned", () => {
    const r = parseGrantRequestBody(requestBody());
    expect(r.expiryHeight).toBeUndefined();
    expect(r.maxEgressBytes).toBeUndefined();
    expect(r.scope).toBe(UNPAID_SCOPE);
    expect(r.reason).toBe("need read access");
    expect(r.sessionPubHex).toBe(SESSION_PUB);
  });

  test("object bodies parse identically to their JSON text (inbox form)", () => {
    const text = requestBody({ expiryHeight: 950000 });
    expect(parseGrantRequestBody(JSON.parse(text))).toEqual(parseGrantRequestBody(text));
  });

  test("reason and sessionPubHex are required (S1 wire contract)", () => {
    for (const k of ["reason", "sessionPubHex"]) {
      const { [k]: _drop, ...rest } = JSON.parse(requestBody());
      expect(() => parseGrantRequestBody(JSON.stringify(rest))).toThrow(/required/i);
    }
  });

  test("non-JSON and non-object bodies reject", () => {
    expect(() => parseGrantRequestBody("not json")).toThrow();
    expect(() => parseGrantRequestBody("[]")).toThrow();
    expect(() => parseGrantRequestBody("null")).toThrow();
    expect(() => parseGrantRequestBody('"str"')).toThrow();
  });

  test("unknown fields reject (never ignored)", () => {
    expect(() => parseGrantRequestBody(requestBody({ extra: 1 }))).toThrow(/unknown/i);
  });

  test("doorGenesisTxid must be 64 lowercase hex", () => {
    expect(() => parseGrantRequestBody(requestBody({ doorGenesisTxid: TXID_A.toUpperCase() }))).toThrow();
    expect(() => parseGrantRequestBody(requestBody({ doorGenesisTxid: "ab".repeat(31) }))).toThrow();
    expect(() => parseGrantRequestBody(requestBody({ doorGenesisTxid: 42 }))).toThrow();
    const { doorGenesisTxid: _drop, ...rest } = JSON.parse(requestBody());
    expect(() => parseGrantRequestBody(JSON.stringify(rest))).toThrow();
  });

  test("doorOwnerAddress must be strict mainnet P2PKH (P2SH rejected)", () => {
    const p2sh = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
    expect(() => parseGrantRequestBody(requestBody({ doorOwnerAddress: p2sh }))).toThrow();
    expect(() => parseGrantRequestBody(requestBody({ doorOwnerAddress: "garbage" }))).toThrow();
    expect(() => parseGrantRequestBody(requestBody({ doorOwnerAddress: ADDR_ONE }))).not.toThrow();
  });

  test("scope: empty, oversized and non-canonical reject", () => {
    expect(() => parseGrantRequestBody(requestBody({ scope: "" }))).toThrow();
    const big = jcs({ allow: ["x".repeat(4100)], salt: "00".repeat(16) });
    expect(() => parseGrantRequestBody(requestBody({ scope: big }))).toThrow();
    // Same keys, non-canonical ordering: requests.ts rejects at filing; parity here.
    const nonCanonical = '{"salt":"00112233445566778899aabbccddeeff","allow":["read:users"],"rate":"60/min"}';
    expect(() => parseGrantRequestBody(requestBody({ scope: nonCanonical }))).toThrow();
  });

  test("scope payment must be the wallet's 25-byte P2PKH restriction", () => {
    const payeeScript = new P2PKH().lock(ADDR_ONE).toHex();
    expect(() => parseGrantRequestBody(requestBody({ scope: paidScope(payeeScript) }))).not.toThrow();
    // P2SH payment script: OSP-0005 allows it, the wallet restriction does not.
    const p2shScript = "a914" + "11".repeat(20) + "87";
    expect(() => parseGrantRequestBody(requestBody({ scope: paidScope(p2shScript) }))).toThrow();
    // Address instead of script: never accepted.
    expect(() => parseGrantRequestBody(requestBody({ scope: jcs({ allow: ["read:users"], payment: { amount_sats: 10, address: ADDR_ONE }, salt: "00".repeat(16) }) }))).toThrow();
  });

  test("expiryHeight bounds match requests.ts", () => {
    for (const bad of [0, -1, 1.5, 0x100000000, "900000"]) {
      expect(() => parseGrantRequestBody(requestBody({ expiryHeight: bad }))).toThrow();
    }
    expect(() => parseGrantRequestBody(requestBody({ expiryHeight: 1 }))).not.toThrow();
    expect(() => parseGrantRequestBody(requestBody({ expiryHeight: 0xffffffff }))).not.toThrow();
  });

  test("maxEgressBytes must be a positive safe integer", () => {
    for (const bad of [0, -1, 1.5, "65536"]) {
      expect(() => parseGrantRequestBody(requestBody({ maxEgressBytes: bad }))).toThrow();
    }
  });

  test("sessionPubHex must be 33-byte compressed lowercase hex (02/03)", () => {
    for (const bad of [SESSION_PUB.toUpperCase(), SESSION_PUB.slice(0, 65), "zz".repeat(33), "04" + SESSION_PUB.slice(2), 42]) {
      expect(() => parseGrantRequestBody(requestBody({ sessionPubHex: bad }))).toThrow();
    }
  });

  test("reason rules match requests.ts (single line, <=280 bytes, no controls)", () => {
    expect(() => parseGrantRequestBody(requestBody({ reason: "x".repeat(281) }))).toThrow();
    expect(() => parseGrantRequestBody(requestBody({ reason: "line\nbreak" }))).toThrow();
    expect(() => parseGrantRequestBody(requestBody({ reason: "ok reason" }))).not.toThrow();
  });

  test("parity sweep: every shared-field filing rejection is also a parse rejection", () => {
    const root = scratch();
    try {
      initVault(root);
      const badCases: Array<Record<string, unknown>> = [
        { scope: "" },
        { scope: '{"salt":"00","allow":["a"]}' }, // non-canonical order
        { expiryHeight: 0 },
        { expiryHeight: 0x100000000 },
        { maxEgressBytes: 0 },
        { sessionPubHex: "00" },
        { reason: "x".repeat(281) },
        { reason: "bad\x00char" },
      ];
      for (const over of badCases) {
        const body = requestBody(over);
        expect(() => parseGrantRequestBody(body)).toThrow();
        // Same offending bytes through the filing path must also reject.
        const { scope: _s, ...rest } = over;
        const parsed = {
          kind: "osp-grant" as const, door: "bench",
          scopeCanonical: (over.scope as string | undefined) ?? UNPAID_SCOPE,
          reason: "parity", sessionPubHex: SESSION_PUB, ...rest,
        };
        expect(() => fileRequest(root, parsed)).toThrow();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("parseGrantReceiptBody", () => {
  test("valid receipt round-trips", () => {
    const r = parseGrantReceiptBody(receiptBody());
    expect(r).toEqual({ grantTxid: TXID_B, scopeHash: HASH, doorGenesisTxid: TXID_A });
  });

  test("exact field set: unknown, missing, malformed reject", () => {
    expect(() => parseGrantReceiptBody(receiptBody({ extra: true }))).toThrow(/unknown/i);
    expect(() => parseGrantReceiptBody(receiptBody({ grantTxid: TXID_B.toUpperCase() }))).toThrow();
    expect(() => parseGrantReceiptBody(receiptBody({ scopeHash: "ef".repeat(31) }))).toThrow();
    expect(() => parseGrantReceiptBody(receiptBody({ doorGenesisTxid: 42 }))).toThrow();
    const { scopeHash: _drop, ...rest } = JSON.parse(receiptBody());
    expect(() => parseGrantReceiptBody(JSON.stringify(rest))).toThrow();
    expect(() => parseGrantReceiptBody("nope")).toThrow();
    expect(() => parseGrantReceiptBody("[]")).toThrow();
  });
});

describe("matchDoor + grantRequestToFilingInput", () => {
  test("matchDoor binds genesis txid AND owner address exactly", () => {
    const req = parseGrantRequestBody(requestBody());
    const door = { genesisDisplayTxid: TXID_A, ownerAddress: ADDR_TWO };
    expect(matchDoor(req, door)).toBe(true);
    expect(matchDoor(req, { ...door, genesisDisplayTxid: TXID_B })).toBe(false);
    expect(matchDoor(req, { ...door, ownerAddress: ADDR_ONE })).toBe(false);
  });

  test("filing input passes fileRequest with byte-pinned scope", () => {
    const root = scratch();
    try {
      initVault(root);
      const req = parseGrantRequestBody(requestBody({ expiryHeight: 950000, maxEgressBytes: 4096, sessionPubHex: SESSION_PUB, reason: "handoff" }));
      const input = grantRequestToFilingInput(req, "bench");
      expect(input.kind).toBe("osp-grant");
      expect(input.door).toBe("bench");
      expect(input.scopeCanonical).toBe(UNPAID_SCOPE); // byte-pinned, never rewritten
      const { request, created } = fileRequest(root, input);
      expect(created).toBe(true);
      expect(request.scopeCanonical).toBe(UNPAID_SCOPE);
      expect(request.expiryHeight).toBe(950000);
      expect(request.maxEgressBytes).toBe(4096);
      expect(request.sessionPubHex).toBe(SESSION_PUB);
      expect(request.reason).toBe("handoff");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("filing input omits absent optional fields; required fields always carry", () => {
    const req = parseGrantRequestBody(requestBody());
    const input = grantRequestToFilingInput(req, "bench");
    expect("expiryHeight" in input).toBe(false);
    expect("maxEgressBytes" in input).toBe(false);
    expect(input.reason).toBe(req.reason);
    expect(input.sessionPubHex).toBe(req.sessionPubHex);
  });
});

describe("sendAgentMessage typed bodies (S4 extension)", () => {
  test("osp.grant.request with a valid body sends", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      const f = funding(root);
      const wire = intercepted();
      const r = await sendAgentMessage({ root, to: ADDR_TWO, body: requestBody(), type: "osp.grant.request", ...f, broadcast: wire.broadcast });
      expect(r.ok).toBe(true);
      expect(wire.sent.length).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("osp.grant.receipt with a valid body sends", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      const f = funding(root);
      const wire = intercepted();
      const r = await sendAgentMessage({ root, to: ADDR_ONE, body: receiptBody(), type: "osp.grant.receipt", ...f, broadcast: wire.broadcast });
      expect(r.ok).toBe(true);
      expect(wire.sent.length).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("malformed typed body rejects BEFORE any fetch or broadcast", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      let fetched = false;
      const wire = intercepted();
      const bad = await sendAgentMessage({
        root, to: ADDR_TWO, body: requestBody({ scope: "" }), type: "osp.grant.request",
        fetchUtxos: async () => { fetched = true; return []; }, fetchTxHex: async () => { fetched = true; return ""; }, broadcast: wire.broadcast,
      });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.code).toBe("BAD_BODY");
      expect(fetched).toBe(false);
      expect(wire.sent.length).toBe(0);
      const badReceipt = await sendAgentMessage({
        root, to: ADDR_ONE, body: receiptBody({ scopeHash: "zz" }), type: "osp.grant.receipt",
        fetchUtxos: async () => { fetched = true; return []; }, fetchTxHex: async () => { fetched = true; return ""; }, broadcast: wire.broadcast,
      });
      expect(badReceipt.ok).toBe(false);
      if (!badReceipt.ok) expect(badReceipt.code).toBe("BAD_BODY");
      expect(fetched).toBe(false);
      expect(wire.sent.length).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("typed body may arrive as an object (not only JSON text)", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      const f = funding(root);
      const wire = intercepted();
      const r = await sendAgentMessage({ root, to: ADDR_TWO, body: JSON.parse(requestBody()), type: "osp.grant.request", ...f, broadcast: wire.broadcast });
      expect(r.ok).toBe(true);
      expect(wire.sent.length).toBe(1);
      // The on-chain envelope carries the typed OBJECT body (S1 wire format).
      const tx = Transaction.fromHex(wire.sent[0]!);
      const opRet = tx.outputs.find((o) => o.satoshis === 0)!;
      const { parseMessageScript } = await import("./agent-message");
      const parsed = parseMessageScript(opRet.lockingScript.toHex());
      expect(parsed.envelope.type).toBe("osp.grant.request");
      expect(typeof parsed.envelope.body).toBe("object");
      expect((parsed.envelope.body as Record<string, unknown>).scope).toBe(UNPAID_SCOPE);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("unknown types still reject; plain message unchanged", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      const f = funding(root);
      const wire = intercepted();
      const unknown = await sendAgentMessage({ root, to: ADDR_TWO, body: "hi", type: "x402.offer", ...f, broadcast: wire.broadcast });
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) expect(unknown.code).toBe("BAD_TYPE");
      const plain = await sendAgentMessage({ root, to: ADDR_TWO, body: "hi", ...f, broadcast: wire.broadcast });
      expect(plain.ok).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("verifyGrantReceipt (chain is the truth)", () => {
  test("real unpaid grant verifies; scopeHash and doorId bind", async () => {
    const root = scratch();
    try {
      const f = ospVault(root);
      const init = await doorInit({ root, name: "bench", fetchFn: f.fetchFn });
      const g = await signOspGrant({ root, door: "bench", scopeCanonical: UNPAID_SCOPE, sessionPubHex: SESSION_PUB, fetchFn: f.fetchFn });
      const receipt = parseGrantReceiptBody(receiptBody({ grantTxid: g.txid, scopeHash: scopeHashHex(UNPAID_SCOPE), doorGenesisTxid: init.txid }));
      const v = await verifyGrantReceipt({ receipt, fetchTxHex: async (txid) => { const h = f.state.txs.get(txid); if (!h) throw new Error("unknown"); return h; }, scopeCanonical: UNPAID_SCOPE });
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.txid).toBe(g.txid);
        expect(v.paymentSats).toBe(0);
        expect(v.scopeHash).toBe(scopeHashHex(UNPAID_SCOPE));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("real paid grant verifies with payment terms on-chain", async () => {
    const root = scratch();
    try {
      const f = ospVault(root);
      const init = await doorInit({ root, name: "bench", fetchFn: f.fetchFn });
      const payeeScript = new P2PKH().lock(ADDR_ONE).toHex();
      const scope = paidScope(payeeScript, 10);
      const g = await signOspGrant({ root, door: "bench", scopeCanonical: scope, fetchFn: f.fetchFn });
      expect(g.paymentSats).toBe(10);
      const receipt = parseGrantReceiptBody(receiptBody({ grantTxid: g.txid, scopeHash: scopeHashHex(scope), doorGenesisTxid: init.txid }));
      const v = await verifyGrantReceipt({ receipt, fetchTxHex: async (txid) => f.state.txs.get(txid)!, scopeCanonical: scope });
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.paymentSats).toBe(10);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("tampered scopeHash, wrong door, non-grant tx and scope mismatch all fail", async () => {
    const root = scratch();
    try {
      const f = ospVault(root);
      const init = await doorInit({ root, name: "bench", fetchFn: f.fetchFn });
      const g = await signOspGrant({ root, door: "bench", scopeCanonical: UNPAID_SCOPE, fetchFn: f.fetchFn });
      const fetchTxHex = async (txid: string) => { const h = f.state.txs.get(txid); if (!h) throw new Error("unknown tx"); return h; };
      const good = { grantTxid: g.txid, scopeHash: scopeHashHex(UNPAID_SCOPE), doorGenesisTxid: init.txid };
      expect((await verifyGrantReceipt({ receipt: { ...good, scopeHash: HASH }, fetchTxHex })).ok).toBe(false);
      expect((await verifyGrantReceipt({ receipt: { ...good, doorGenesisTxid: TXID_B }, fetchTxHex })).ok).toBe(false);
      // Point at the genesis tx (a tip spend, no grant envelope).
      expect((await verifyGrantReceipt({ receipt: { ...good, grantTxid: init.txid }, fetchTxHex })).ok).toBe(false);
      // Receipt scopeHash claims a different scope than the provided canonical bytes.
      expect((await verifyGrantReceipt({ receipt: good, fetchTxHex, scopeCanonical: paidScope(new P2PKH().lock(ADDR_ONE).toHex()) })).ok).toBe(false);
      // Unknown txid: fetch failure is a failed verification, never a throw-through trust.
      expect((await verifyGrantReceipt({ receipt: { ...good, grantTxid: TXID_B }, fetchTxHex })).ok).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("paid scope whose payment output is absent on-chain fails", async () => {
    const root = scratch();
    try {
      const f = ospVault(root);
      const init = await doorInit({ root, name: "bench", fetchFn: f.fetchFn });
      const scope = paidScope(new P2PKH().lock(ADDR_ONE).toHex(), 10);
      // Hand-build a tx carrying a VALID envelope for the paid scope but NO
      // payment output: the receipt must fail on payment terms, not just hash.
      const { encodeGrant, buildEnvelopeScript, bytesToHex, hexToBytes } = await import("./osp-envelope");
      const env = encodeGrant({
        doorId: hexToBytes(init.doorIdInternalHex),
        expiryHeight: 1_000_000,
        maxEgress: 65536,
        scopeHash: hexToBytes(scopeHashHex(scope)),
        sessionPub: hexToBytes(SESSION_PUB),
      });
      const tx = new Transaction();
      tx.addOutput({ satoshis: 0, lockingScript: Script.fromHex(bytesToHex(buildEnvelopeScript(env))) });
      const fakeTxid = tx.id("hex");
      f.state.txs.set(fakeTxid, tx.toHex());
      const receipt = { grantTxid: fakeTxid, scopeHash: scopeHashHex(scope), doorGenesisTxid: init.txid };
      const v = await verifyGrantReceipt({ receipt, fetchTxHex: async (txid) => f.state.txs.get(txid)!, scopeCanonical: scope });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/payment/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("cross-agent flow: message -> file -> approve -> grant -> receipt -> on-chain verify", () => {
  test("full loop on one shared intercepted chain, zero real network", async () => {
    const rootA = scratch();
    const rootB = scratch();
    try {
      // --- shared mock chain: unspent, tx hex, history, ARC ---
      initVault(rootA);
      enableMessages(rootA);
      const B = ospVault(rootB);
      enableMessages(rootB);
      const A = loadVault(rootA);
      const scriptToAddress = new Map<string, string>();
      scriptToAddress.set(new P2PKH().lock(A.address).toHex(), A.address);
      scriptToAddress.set(new P2PKH().lock(B.vault.address).toHex(), B.vault.address);
      scriptToAddress.set(B.tipScript, B.owner);
      const txs = new Map<string, string>(B.state.txs);
      const utxos = new Map<string, Array<{ tx_hash: string; tx_pos: number; value: number }>>();
      const history = new Map<string, Array<{ tx_hash: string; height: number }>>();
      let height = 900000;
      const seedA = new Transaction();
      seedA.addOutput({ satoshis: 100_000, lockingScript: new P2PKH().lock(A.address) });
      txs.set(seedA.id("hex"), seedA.toHex());
      utxos.set(A.address, [{ tx_hash: seedA.id("hex"), tx_pos: 0, value: 100_000 }]);
      utxos.set(B.vault.address, [{ tx_hash: B.state.txs.keys().next().value as string, tx_pos: 0, value: 100_000 }]);
      const broadcasts: Transaction[] = [];
      const chainFetch = mockFetch(async (input, init) => {
        const u = String(input);
        const url = new URL(u);
        let m = url.pathname.match(/\/address\/([^/]+)\/unspent$/);
        if (m) return Response.json(utxos.get(m[1]!) ?? []);
        m = url.pathname.match(/\/address\/([^/]+)\/confirmed\/history$/);
        if (m) {
          const min = Number(url.searchParams.get("height") ?? "0");
          const rows = (history.get(m[1]!) ?? []).filter((r) => r.height >= min);
          if (rows.length === 0) return new Response("Not Found", { status: 404 }); // live WoC quirk
          return Response.json({ address: m[1], result: rows, error: "" });
        }
        m = url.pathname.match(/\/address\/([^/]+)\/unconfirmed\/history$/);
        if (m) return Response.json({ address: m[1], result: [], error: "" });
        m = url.pathname.match(/\/tx\/([0-9a-f]{64})\/hex$/);
        if (m) {
          const hex = txs.get(m[1]!);
          if (!hex) return new Response("not found", { status: 404 });
          return new Response(hex);
        }
        if (u === ARC && init?.method === "POST") {
          const rawTx = (JSON.parse(String(init.body)) as { rawTx: string }).rawTx;
          const tx = Transaction.fromHex(rawTx);
          const txid = tx.id("hex");
          txs.set(txid, rawTx);
          broadcasts.push(tx);
          height += 1;
          // Spend inputs: remove those outpoints everywhere.
          for (const inp of tx.inputs) {
            for (const [addr, list] of utxos) {
              const next = list.filter((c) => !(c.tx_hash === inp.sourceTXID && c.tx_pos === inp.sourceOutputIndex));
              utxos.set(addr, next);
            }
          }
          // Credit outputs to registered scripts; history rows for every payee.
          tx.outputs.forEach((o, i) => {
            const addr = scriptToAddress.get(o.lockingScript.toHex());
            if (!addr) return;
            const list = utxos.get(addr) ?? [];
            list.push({ tx_hash: txid, tx_pos: i, value: o.satoshis! });
            utxos.set(addr, list);
            const h = history.get(addr) ?? [];
            h.push({ tx_hash: txid, height });
            history.set(addr, h);
          });
          return Response.json({ txid, txStatus: "SEEN_ON_NETWORK" });
        }
        throw new Error(`Unexpected network: ${u}`);
      });
      const wireFor = (root: string) => ({
        fetchUtxos: async (addr: string) => utxos.get(addr) ?? [],
        fetchTxHex: async (txid: string) => { const h = txs.get(txid); if (!h) throw new Error("unknown tx " + txid); return h; },
        broadcast: async (rawTx: string) => {
          const res = await chainFetch(ARC, { method: "POST", body: JSON.stringify({ rawTx }) });
          return (await res.json()) as { txid: string };
        },
      });

      // --- B opens a door ---
      const init = await doorInit({ root: rootB, name: "bench", fetchFn: chainFetch });
      const door = loadOspDoor(rootB, "bench");

      // --- A sends the grant request message ---
      const scope = UNPAID_SCOPE;
      const reqBody = requestBody({
        doorGenesisTxid: door.genesisDisplayTxid,
        doorOwnerAddress: door.ownerAddress,
        scope,
        expiryHeight: 950000,
        reason: "handoff needs read:users",
      });
      const sentReq = await sendAgentMessage({ root: rootA, to: B.vault.address, body: reqBody, type: "osp.grant.request", ...wireFor(rootA) });
      expect(sentReq.ok).toBe(true);

      // --- B scans its inbox: verified, typed, untrusted ---
      const scanB = await scanInbox({ root: rootB, fetchFn: chainFetch, sleep: async () => {} });
      expect(scanB.entries.length).toBe(1);
      const entry = scanB.entries[0]!;
      expect(entry.type).toBe("osp.grant.request");
      expect(entry.verified).toBe(true);
      expect(entry.from).toBe(A.address);
      expect(entry.untrusted).toBe(true);

      // --- B validates with filing-parity rules, matches its door, files explicitly ---
      // Typed bodies arrive from the codec as OBJECTS (S1 wire format).
      expect(typeof entry.body).toBe("object");
      const req = parseGrantRequestBody(entry.body);
      expect(matchDoor(req, door)).toBe(true);
      const { request, created } = fileRequest(rootB, grantRequestToFilingInput(req, "bench"));
      expect(created).toBe(true);
      expect(request.status).toBe("pending");

      // --- human approval signs + broadcasts the exact scope bytes ---
      const decided = await approveRequest(rootB, request.id, { fetchFn: chainFetch });
      expect(decided.status).toBe("approved");
      expect(decided.decision).toContain("osp grant broadcast");
      const grantTxid = loadOspDoor(rootB, "bench").tip!.txid;
      expect(decided.decision).toContain(grantTxid);

      // --- B sends the receipt pointer ---
      const recBody = receiptBody({ grantTxid, scopeHash: scopeHashHex(scope), doorGenesisTxid: door.genesisDisplayTxid });
      const sentRec = await sendAgentMessage({ root: rootB, to: A.address, body: recBody, type: "osp.grant.receipt", ...wireFor(rootB) });
      expect(sentRec.ok).toBe(true);

      // --- A scans, parses, verifies ON-CHAIN (never trusts the message) ---
      const scanA = await scanInbox({ root: rootA, fetchFn: chainFetch, sleep: async () => {} });
      expect(scanA.entries.length).toBe(1); // the sent request never pollutes A's inbox
      const recEntry = scanA.entries[0]!;
      expect(recEntry.type).toBe("osp.grant.receipt");
      expect(recEntry.verified).toBe(true);
      expect(recEntry.from).toBe(B.vault.address);
      const receipt = parseGrantReceiptBody(recEntry.body);
      const v = await verifyGrantReceipt({ receipt, fetchTxHex: wireFor(rootA).fetchTxHex, scopeCanonical: scope });
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.txid).toBe(grantTxid);
        expect(v.paymentSats).toBe(0);
      }
      // Tampered receipt fails against the same chain.
      const bad = await verifyGrantReceipt({ receipt: { ...receipt, scopeHash: HASH }, fetchTxHex: wireFor(rootA).fetchTxHex, scopeCanonical: scope });
      expect(bad.ok).toBe(false);

      // --- durable state on both sides ---
      expect(listRequests(rootB, "approved").length).toBe(1);
      expect(broadcasts.length).toBe(4); // door genesis, request msg, grant, receipt msg
      const logA = readFileSync(vaultPaths(rootA).log, "utf8");
      expect(logA).toContain("agent-message");
      const logB = readFileSync(vaultPaths(rootB).log, "utf8");
      expect(logB).toContain("osp-grant");
      expect(logB).toContain("agent-message");
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});
