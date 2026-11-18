// S3 — read-only inbox scan + keyless verification (TDD RED first).
// No vault decryption, no signing, no broadcast. WoC history is the only
// chain source; every fetch is injectable. Bodies are UNTRUSTED peer data.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P2PKH, PrivateKey, Script, Transaction, UnlockingScript, Utils, BSM } from "@bsv/sdk";
import {
  buildMessageScript, buildLocusMessagePayload, signEnvelope, parseMessageScript, aipPreimage,
  type Envelope,
} from "./agent-message";
import { encodeGrant, buildEnvelopeScript } from "./osp-envelope";
import { ospTipScriptHex } from "./osp-address";
import { createServer } from "./mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  WOC_BASE, loadInboxStore, scanInbox, verifyMessageTx,
  type InboxEntry, type InboxStore,
} from "./agent-message-inbox";

const ONE = new PrivateKey(1);
const TWO = new PrivateKey(2);
const THREE = new PrivateKey(3);
const ADDR_ONE = ONE.toAddress().toString();
const ADDR_TWO = TWO.toAddress().toString();
const ADDR_THREE = THREE.toAddress().toString();
const NONCE = "000102030405060708090a0b0c0d0e0f";
const TS = 1763000000;
const BODY = "handoff: build the inbox";
const NOW = 1763100000;

type TestEnv = {
  app: string; v: number; from: string; to: string; type: string; nonce: string; ts: number; body: string;
  fromAgentPin?: string; toAgentPin?: string;
};
const baseEnv = (over: Partial<TestEnv> = {}): TestEnv => ({
  app: "dogfood", v: 1, from: ADDR_ONE, to: ADDR_TWO, type: "handoff", nonce: NONCE, ts: TS, body: BODY, ...over,
});

/** Single-push OP_RETURN wrapper for a Locus JSON payload (strict shape). */
function locusScript(json: string): string {
  const data = Utils.toArray(json, "utf8");
  const head: number[] = [0x6a];
  if (data.length <= 75) head.push(data.length);
  else if (data.length <= 255) head.push(0x4c, data.length);
  else if (data.length <= 65535) head.push(0x4d, data.length & 0xff, (data.length >> 8) & 0xff);
  else throw new Error("fixture payload too large");
  return Utils.toHex([...head, ...data]);
}

function unsignedTx(outputs: { satoshis: number; lockingScript: Script }[]): Transaction {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: "ab".repeat(32), sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(), sequence: 0xffffffff,
  });
  for (const o of outputs) tx.addOutput(o);
  return tx;
}

/** Re-encode raw pushes after a bare-6a prefix (fixture tampering only). */
function encodePushes(prefixHex: string, pushes: Buffer[]): string {
  const out: number[] = [...Utils.toArray(prefixHex, "hex")];
  for (const p of pushes) {
    if (p.length <= 75) out.push(p.length);
    else if (p.length <= 255) out.push(0x4c, p.length);
    else if (p.length <= 65535) out.push(0x4d, p.length & 0xff, (p.length >> 8) & 0xff);
    else throw new Error("fixture push too large");
    out.push(...p);
  }
  return Utils.toHex(out);
}

/** Valid-shape Option A script whose AIP signature recovers the WRONG key:
 * parse succeeds, verification must fail (surfaced verified:false). */
function badAipScript(env: TestEnv): string {
  const good = buildMessageScript(ONE, env);
  const { pushes } = parseMessageScript(good);
  const pre = aipPreimage(pushes.slice(0, 14));
  const sig = Buffer.from(BSM.sign(Array.from(pre), THREE, "base64") as string, "base64");
  return encodePushes("6a", [...pushes.slice(0, 17), sig]);
}

/** Message tx: out0 = 546-sat dust-safe tip to recipient, out1 = message, out2 = change to sender. */
function messageTx(opts: {
  sender?: PrivateKey; env?: Partial<TestEnv>; transport?: "option-a" | "option-b";
  tipTo?: string; badAip?: boolean;
} = {}): Transaction {
  const sender = opts.sender ?? ONE;
  const env = baseEnv(opts.env);
  const tipTo = opts.tipTo ?? env.to;
  let scriptHex: string;
  if ((opts.transport ?? "option-a") === "option-a") {
    scriptHex = opts.badAip ? badAipScript(env) : buildMessageScript(sender, env);
  } else {
    const recipientKey = tipTo === ADDR_TWO ? TWO : tipTo === ADDR_THREE ? THREE : ONE;
    const signed = signEnvelope(sender, env);
    const payload = buildLocusMessagePayload(signed, recipientKey.toPublicKey().toString(), 7);
    scriptHex = locusScript(payload);
  }
  return unsignedTx([
    { satoshis: 546, lockingScript: new P2PKH().lock(tipTo) },
    { satoshis: 0, lockingScript: Script.fromHex(scriptHex) },
    { satoshis: 1000, lockingScript: new P2PKH().lock(sender.toAddress()) },
  ]);
}

/** Minimal Locus agent pin: 1-sat owner tip + type:"agent" mint payload. */
function agentPinTx(ownerKey: PrivateKey, over: Record<string, unknown> = {}): Transaction {
  const owner = ownerKey.toAddress().toString();
  const payload = JSON.stringify({
    p: "locus", v: 3, op: "mint", type: "agent",
    owner, owner_pubkey: ownerKey.toPublicKey().toString(), nonce: 9, ts: TS, ...over,
  });
  return unsignedTx([
    { satoshis: 1, lockingScript: new P2PKH().lock(owner) },
    { satoshis: 0, lockingScript: Script.fromHex(locusScript(payload)) },
  ]);
}

function ospDoorTx(): Transaction {
  const grant = encodeGrant({
    doorId: new Uint8Array(32).fill(0xab), expiryHeight: 900000, maxEgress: 1048576,
    scopeHash: new Uint8Array(32).fill(0xcd),
    sessionPub: new Uint8Array(Utils.toArray("02" + "ab".repeat(32), "hex")),
  });
  return unsignedTx([
    { satoshis: 1, lockingScript: Script.fromHex(ospTipScriptHex(ONE)) },
    { satoshis: 0, lockingScript: Script.fromHex(Utils.toHex(buildEnvelopeScript(grant))) },
    { satoshis: 1000, lockingScript: new P2PKH().lock(ADDR_ONE) },
  ]);
}

function plainPaymentTx(to: string, sats = 5000): Transaction {
  return unsignedTx([{ satoshis: sats, lockingScript: new P2PKH().lock(to) }]);
}

type HistoryTable = Record<string, { confirmed: { tx_hash: string; height: number }[]; unconfirmed: string[] }>;

/** Injectable WoC: history tables + tx hex table; records every request URL. */
function wocStub(txs: Transaction[], history: HistoryTable) {
  const hexes = new Map(txs.map(t => [t.id("hex"), t.toHex()]));
  const urls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const u = new URL(url);
    const hexMatch = u.pathname.match(/\/tx\/([a-f0-9]{64})\/hex$/);
    if (hexMatch) {
      const hex = hexes.get(hexMatch[1]!);
      return hex ? new Response(hex) : new Response("not found", { status: 404 });
    }
    const addrMatch = u.pathname.match(/\/address\/([^/]+)\/(confirmed|unconfirmed)\/history$/);
    if (addrMatch) {
      const table = history[addrMatch[1]!] ?? { confirmed: [], unconfirmed: [] };
      if (addrMatch[2] === "unconfirmed") {
        return new Response(JSON.stringify({ address: addrMatch[1], result: table.unconfirmed.map(tx_hash => ({ tx_hash })), error: "" }));
      }
      const minHeight = Number(u.searchParams.get("height") ?? "0");
      const limit = Number(u.searchParams.get("limit") ?? "1000");
      const rows = table.confirmed.filter(r => r.height >= minHeight).sort((a, b) => a.height - b.height).slice(0, limit);
      return new Response(JSON.stringify({ address: addrMatch[1], result: rows, error: "" }));
    }
    return new Response("unexpected url", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, urls, hexes };
}

const noSleep = async () => {};
const tmpRoot = () => mkdtempSync(join(tmpdir(), "dogfood-inbox-test-"));
function rootWithAddress(addr = ADDR_TWO): string {
  const root = tmpRoot();
  writeFileSync(join(root, "address.txt"), `${addr}\n`);
  return root;
}
const txidOf = (t: Transaction) => t.id("hex");

describe("verifyMessageTx (keyless, read-only)", () => {
  test("valid Option A message verifies with honest flags", async () => {
    const tx = messageTx();
    const { fetchFn } = wocStub([tx], {});
    const r = await verifyMessageTx(txidOf(tx), { fetchFn });
    expect(r.message).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.transport).toBe("option-a");
    expect(r.from).toBe(ADDR_ONE);
    expect(r.to).toBe(ADDR_TWO);
    expect(r.type).toBe("handoff");
    expect(r.body).toBe(BODY);
    expect(r.tipPayee).toBe(ADDR_TWO);
    expect(r.toMatchesTip).toBe(true);
    expect(r.bound).toBe(false);
    expect(r.untrusted).toBe(true);
    expect(r.confirmationChecked).toBe(false);
    expect(r.pubkey).toBe(ONE.toPublicKey().toString());
  });

  test("valid Option B message verifies; pinId is the tip outpoint", async () => {
    const tx = messageTx({ transport: "option-b" });
    const { fetchFn } = wocStub([tx], {});
    const r = await verifyMessageTx(txidOf(tx), { fetchFn });
    expect(r.message).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.transport).toBe("option-b");
    expect(r.pinId).toBe(`${txidOf(tx)}.0`);
    expect(r.toMatchesTip).toBe(true);
  });

  test("AIP signature by the wrong key surfaces verified:false, never dropped", async () => {
    const tx = messageTx({ badAip: true });
    const { fetchFn } = wocStub([tx], {});
    const r = await verifyMessageTx(txidOf(tx), { fetchFn });
    expect(r.message).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.verifyError).toBeTruthy();
    expect(r.from).toBe(ADDR_ONE);
    expect(r.bound).toBe(false);
  });

  test("Option B with a tampered envelope signature surfaces verified:false", async () => {
    // Build a valid Locus message, then corrupt the embedded envelope sig.
    const signed = signEnvelope(ONE, baseEnv());
    const payload = buildLocusMessagePayload(signed, TWO.toPublicKey().toString(), 7);
    const o = JSON.parse(payload) as { content: string };
    const env = JSON.parse(o.content) as { sig: string };
    env.sig = (env.sig[0] === "A" ? "B" : "A") + env.sig.slice(1);
    o.content = JSON.stringify(env);
    const tampered = unsignedTx([
      { satoshis: 1, lockingScript: new P2PKH().lock(ADDR_TWO) },
      { satoshis: 0, lockingScript: Script.fromHex(locusScript(JSON.stringify(o))) },
    ]);
    const { fetchFn } = wocStub([tampered], {});
    const r = await verifyMessageTx(txidOf(tampered), { fetchFn });
    expect(r.message).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.verifyError).toBeTruthy();
  });

  test("plain payment is not a message", async () => {
    const tx = plainPaymentTx(ADDR_TWO);
    const { fetchFn } = wocStub([tx], {});
    const r = await verifyMessageTx(txidOf(tx), { fetchFn });
    expect(r.message).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(r.confirmationChecked).toBe(false);
  });

  test("OSP door transition is not a message (scanner-level disjointness)", async () => {
    const tx = ospDoorTx();
    const { fetchFn } = wocStub([tx], {});
    const r = await verifyMessageTx(txidOf(tx), { fetchFn });
    expect(r.message).toBe(false);
  });

  test("tip payee different from envelope.to is reported, not trusted", async () => {
    const tx = messageTx({ tipTo: ADDR_THREE });
    const { fetchFn } = wocStub([tx], {});
    const r = await verifyMessageTx(txidOf(tx), { fetchFn });
    expect(r.message).toBe(true);
    expect(r.toMatchesTip).toBe(false);
    expect(r.tipPayee).toBe(ADDR_THREE);
  });

  test("two message outputs in one tx are ambiguous and refused", async () => {
    const a = messageTx();
    const b = messageTx({ env: { nonce: "ff".repeat(16) } });
    const tx = unsignedTx([...a.outputs, ...b.outputs].map(o => ({ satoshis: o.satoshis ?? 0, lockingScript: o.lockingScript! })));
    const { fetchFn } = wocStub([tx], {});
    const r = await verifyMessageTx(txidOf(tx), { fetchFn });
    expect(r.message).toBe(false);
    expect(r.reason).toMatch(/ambiguous|multiple/i);
  });

  test("malformed txid throws before any fetch", async () => {
    const { fetchFn, urls } = wocStub([], {});
    await expect(verifyMessageTx("zz", { fetchFn })).rejects.toThrow();
    expect(urls.length).toBe(0);
  });

  test("missing tx propagates the lookup failure", async () => {
    const { fetchFn } = wocStub([], {});
    await expect(verifyMessageTx("cd".repeat(32), { fetchFn })).rejects.toThrow();
  });

  test("agent pin binding: valid pin owned by the signing key binds", async () => {
    const pin = agentPinTx(ONE);
    const tx = messageTx({ env: { fromAgentPin: `${txidOf(pin)}.0` } });
    const { fetchFn } = wocStub([tx, pin], {});
    const r = await verifyMessageTx(txidOf(tx), { fetchFn });
    expect(r.verified).toBe(true);
    expect(r.bound).toBe(true);
    expect(r.fromAgentPin).toBe(`${txidOf(pin)}.0`);
  });

  test("agent pin binding: unresolvable pin stays unbound", async () => {
    const tx = messageTx({ env: { fromAgentPin: `${"ef".repeat(32)}.0` } });
    const { fetchFn } = wocStub([tx], {});
    const r = await verifyMessageTx(txidOf(tx), { fetchFn });
    expect(r.bound).toBe(false);
    expect(r.boundReason).toBeTruthy();
  });

  test("agent pin binding: pin owned by a different key does not bind", async () => {
    const pin = agentPinTx(THREE);
    const tx = messageTx({ env: { fromAgentPin: `${txidOf(pin)}.0` } });
    const { fetchFn } = wocStub([tx, pin], {});
    const r = await verifyMessageTx(txidOf(tx), { fetchFn });
    expect(r.bound).toBe(false);
    expect(r.boundReason).toBeTruthy();
  });

  test("agent pin binding: malformed pin reference does not bind", async () => {
    // The codec rejects malformed pin refs at build time, so tamper a valid
    // Option B payload post-build; the raw fallback must still refuse to bind.
    const signed = signEnvelope(ONE, baseEnv());
    const payload = buildLocusMessagePayload(signed, TWO.toPublicKey().toString(), 7);
    const o = JSON.parse(payload) as { content: string };
    const env = JSON.parse(o.content) as Record<string, unknown>;
    env.fromAgentPin = "not-a-pin";
    o.content = JSON.stringify(env);
    const tx = unsignedTx([
      { satoshis: 1, lockingScript: new P2PKH().lock(ADDR_TWO) },
      { satoshis: 0, lockingScript: Script.fromHex(locusScript(JSON.stringify(o))) },
    ]);
    const { fetchFn } = wocStub([tx], {});
    const r = await verifyMessageTx(txidOf(tx), { fetchFn });
    expect(r.bound).toBe(false);
  });

  test("agent pin binding: an unverified message never binds", async () => {
    const pin = agentPinTx(ONE);
    const tx = messageTx({ badAip: true, env: { fromAgentPin: `${txidOf(pin)}.0` } });
    const { fetchFn } = wocStub([tx, pin], {});
    const r = await verifyMessageTx(txidOf(tx), { fetchFn });
    expect(r.verified).toBe(false);
    expect(r.bound).toBe(false);
  });
});

describe("scanInbox (read-only, dedupe + high-water mark)", () => {
  test("finds an Option A message tipped to the inbox address", async () => {
    const tx = messageTx();
    const id = txidOf(tx);
    const root = rootWithAddress();
    const { fetchFn } = wocStub([tx], { [ADDR_TWO]: { confirmed: [{ tx_hash: id, height: 900001 }], unconfirmed: [] } });
    const r = await scanInbox({ root, fetchFn, sleep: noSleep, now: NOW });
    expect(r.address).toBe(ADDR_TWO);
    expect(r.newCount).toBe(1);
    expect(r.entries.length).toBe(1);
    const e = r.entries[0]!;
    expect(e.txid).toBe(id);
    expect(e.from).toBe(ADDR_ONE);
    expect(e.to).toBe(ADDR_TWO);
    expect(e.type).toBe("handoff");
    expect(e.body).toBe(BODY);
    expect(e.height).toBe(900001);
    expect(e.confirmed).toBe(true);
    expect(e.firstSeen).toBe(NOW);
    expect(e.verified).toBe(true);
    expect(e.untrusted).toBe(true);
    expect(r.truncated).toBe(false);
  });

  test("finds an Option B message with its pinId", async () => {
    const tx = messageTx({ transport: "option-b" });
    const id = txidOf(tx);
    const { fetchFn } = wocStub([tx], { [ADDR_TWO]: { confirmed: [{ tx_hash: id, height: 900002 }], unconfirmed: [] } });
    const r = await scanInbox({ address: ADDR_TWO, fetchFn, sleep: noSleep, now: NOW });
    expect(r.entries[0]!.transport).toBe("option-b");
    expect(r.entries[0]!.pinId).toBe(`${id}.0`);
  });

  test("plain payments and OSP door transitions never surface as messages", async () => {
    const msg = messageTx();
    const pay = plainPaymentTx(ADDR_TWO);
    const door = ospDoorTx();
    const history = { [ADDR_TWO]: { confirmed: [
      { tx_hash: txidOf(pay), height: 900000 },
      { tx_hash: txidOf(door), height: 900001 },
      { tx_hash: txidOf(msg), height: 900002 },
    ], unconfirmed: [] } };
    const { fetchFn } = wocStub([msg, pay, door], history);
    const r = await scanInbox({ address: ADDR_TWO, fetchFn, sleep: noSleep, now: NOW });
    expect(r.entries.map(e => e.txid)).toEqual([txidOf(msg)]);
    expect(r.processed).toBe(3);
  });

  test("messages SENT from this address do not pollute its inbox", async () => {
    const tx = messageTx(); // tip to TWO, change to ONE
    const { fetchFn } = wocStub([tx], { [ADDR_ONE]: { confirmed: [{ tx_hash: txidOf(tx), height: 900001 }], unconfirmed: [] } });
    const r = await scanInbox({ address: ADDR_ONE, fetchFn, sleep: noSleep, now: NOW });
    expect(r.entries.length).toBe(0);
    expect(r.newCount).toBe(0);
  });

  test("mempool messages are included as unconfirmed", async () => {
    const tx = messageTx();
    const id = txidOf(tx);
    const { fetchFn } = wocStub([tx], { [ADDR_TWO]: { confirmed: [], unconfirmed: [id] } });
    const r = await scanInbox({ address: ADDR_TWO, fetchFn, sleep: noSleep, now: NOW });
    expect(r.entries.length).toBe(1);
    expect(r.entries[0]!.confirmed).toBe(false);
    expect(r.entries[0]!.height).toBe(0);
  });

  test("second scan dedupes: no tx re-fetch, cached inbox still returned", async () => {
    const tx = messageTx();
    const id = txidOf(tx);
    const root = rootWithAddress();
    const history = { [ADDR_TWO]: { confirmed: [{ tx_hash: id, height: 900001 }], unconfirmed: [] } };
    const stub = wocStub([tx], history);
    await scanInbox({ root, fetchFn: stub.fetchFn, sleep: noSleep, now: NOW });
    const before = stub.urls.filter(u => u.includes("/tx/")).length;
    const r2 = await scanInbox({ root, fetchFn: stub.fetchFn, sleep: noSleep, now: NOW + 10 });
    const after = stub.urls.filter(u => u.includes("/tx/")).length;
    expect(after).toBe(before);
    expect(r2.newCount).toBe(0);
    expect(r2.entries.length).toBe(1);
    expect(r2.entries[0]!.firstSeen).toBe(NOW);
  });

  test("high-water mark advances and scopes the next history query", async () => {
    const tx = messageTx();
    const id = txidOf(tx);
    const root = rootWithAddress();
    const history = { [ADDR_TWO]: { confirmed: [{ tx_hash: id, height: 900001 }], unconfirmed: [] } };
    const stub = wocStub([tx], history);
    const r1 = await scanInbox({ root, fetchFn: stub.fetchFn, sleep: noSleep, now: NOW });
    expect(r1.highWater).toBe(900001);
    await scanInbox({ root, fetchFn: stub.fetchFn, sleep: noSleep, now: NOW + 10 });
    const historyUrls = stub.urls.filter(u => u.includes("/confirmed/history"));
    expect(historyUrls.length).toBe(2);
    expect(new URL(historyUrls[1]!).searchParams.get("height")).toBe("900002");
  });

  test("new txs above the mark are appended on the next scan", async () => {
    const a = messageTx();
    const b = messageTx({ env: { nonce: "ff".repeat(16) } });
    const root = rootWithAddress();
    const history = { [ADDR_TWO]: { confirmed: [{ tx_hash: txidOf(a), height: 900001 }], unconfirmed: [] } };
    const stub = wocStub([a, b], history);
    await scanInbox({ root, fetchFn: stub.fetchFn, sleep: noSleep, now: NOW });
    history[ADDR_TWO]!.confirmed.push({ tx_hash: txidOf(b), height: 900005 });
    const r2 = await scanInbox({ root, fetchFn: stub.fetchFn, sleep: noSleep, now: NOW + 10 });
    expect(r2.newCount).toBe(1);
    expect(r2.entries.length).toBe(2);
    expect(r2.highWater).toBe(900005);
    expect(r2.entries[0]!.txid).toBe(txidOf(b)); // newest first
  });

  test("a mempool message that later confirms stays a single entry", async () => {
    const tx = messageTx();
    const id = txidOf(tx);
    const root = rootWithAddress();
    const history = { [ADDR_TWO]: { confirmed: [] as { tx_hash: string; height: number }[], unconfirmed: [id] } };
    const stub = wocStub([tx], history);
    const r1 = await scanInbox({ root, fetchFn: stub.fetchFn, sleep: noSleep, now: NOW });
    expect(r1.entries[0]!.confirmed).toBe(false);
    history[ADDR_TWO]!.unconfirmed = [];
    history[ADDR_TWO]!.confirmed.push({ tx_hash: id, height: 900010 });
    const r2 = await scanInbox({ root, fetchFn: stub.fetchFn, sleep: noSleep, now: NOW + 600 });
    expect(r2.entries.length).toBe(1);
    expect(r2.entries[0]!.confirmed).toBe(true);
    expect(r2.entries[0]!.height).toBe(900010);
    expect(r2.newCount).toBe(0);
  });

  test("signature-failure messages are surfaced verified:false, never dropped", async () => {
    const tx = messageTx({ badAip: true });
    const { fetchFn } = wocStub([tx], { [ADDR_TWO]: { confirmed: [{ tx_hash: txidOf(tx), height: 900001 }], unconfirmed: [] } });
    const r = await scanInbox({ address: ADDR_TWO, fetchFn, sleep: noSleep, now: NOW });
    expect(r.entries.length).toBe(1);
    expect(r.entries[0]!.verified).toBe(false);
    expect(r.entries[0]!.verifyError).toBeTruthy();
    expect(r.entries[0]!.bound).toBe(false);
  });

  test("from/type filters and limit apply to the returned inbox", async () => {
    const a = messageTx();
    const b = messageTx({ sender: THREE, env: { from: ADDR_THREE, type: "quote" } });
    const history = { [ADDR_TWO]: { confirmed: [
      { tx_hash: txidOf(a), height: 900001 }, { tx_hash: txidOf(b), height: 900002 },
    ], unconfirmed: [] } };
    const stub = wocStub([a, b], history);
    const all = await scanInbox({ address: ADDR_TWO, fetchFn: stub.fetchFn, sleep: noSleep, now: NOW });
    expect(all.entries.length).toBe(2);
    const stub2 = wocStub([a, b], history);
    const byFrom = await scanInbox({ address: ADDR_TWO, fetchFn: stub2.fetchFn, sleep: noSleep, now: NOW, from: ADDR_THREE });
    expect(byFrom.entries.map(e => e.from)).toEqual([ADDR_THREE]);
    const stub3 = wocStub([a, b], history);
    const byType = await scanInbox({ address: ADDR_TWO, fetchFn: stub3.fetchFn, sleep: noSleep, now: NOW, type: "quote" });
    expect(byType.entries.map(e => e.type)).toEqual(["quote"]);
    const stub4 = wocStub([a, b], history);
    const limited = await scanInbox({ address: ADDR_TWO, fetchFn: stub4.fetchFn, sleep: noSleep, now: NOW, limit: 1 });
    expect(limited.entries.length).toBe(1);
    expect(limited.entries[0]!.txid).toBe(txidOf(b));
  });

  test("fetch budget bounds work; the mark never skips unprocessed txs", async () => {
    const a = messageTx();
    const b = messageTx({ env: { nonce: "ff".repeat(16) } });
    const c = messageTx({ env: { nonce: "ee".repeat(16) } });
    const root = rootWithAddress();
    const history = { [ADDR_TWO]: { confirmed: [
      { tx_hash: txidOf(a), height: 900001 }, { tx_hash: txidOf(b), height: 900002 }, { tx_hash: txidOf(c), height: 900003 },
    ], unconfirmed: [] } };
    const stub = wocStub([a, b, c], history);
    const r1 = await scanInbox({ root, fetchFn: stub.fetchFn, sleep: noSleep, now: NOW, maxTxFetches: 1 });
    expect(r1.processed).toBe(1);
    expect(r1.truncated).toBe(true);
    expect(r1.highWater).toBe(900001); // the 900001 row was fully processed; 900002+ remain
    const r2 = await scanInbox({ root, fetchFn: stub.fetchFn, sleep: noSleep, now: NOW + 10, maxTxFetches: 10 });
    expect(r2.newCount).toBe(2);
    expect(r2.entries.length).toBe(3);
    expect(r2.highWater).toBe(900003);
    expect(r2.truncated).toBe(false);
  });

  test("same-height partial processing keeps the mark below that height", async () => {
    const a = messageTx();
    const b = messageTx({ env: { nonce: "ff".repeat(16) } });
    const root = rootWithAddress();
    const history = { [ADDR_TWO]: { confirmed: [
      { tx_hash: txidOf(a), height: 900001 }, { tx_hash: txidOf(b), height: 900001 },
    ], unconfirmed: [] } };
    const stub = wocStub([a, b], history);
    const r1 = await scanInbox({ root, fetchFn: stub.fetchFn, sleep: noSleep, now: NOW, maxTxFetches: 1 });
    expect(r1.highWater).toBe(900000);
    const r2 = await scanInbox({ root, fetchFn: stub.fetchFn, sleep: noSleep, now: NOW + 10 });
    expect(r2.entries.length).toBe(2);
    expect(r2.highWater).toBe(900001);
  });

  test("duplicate txid across confirmed and unconfirmed is processed once", async () => {
    const tx = messageTx();
    const id = txidOf(tx);
    const { fetchFn, urls } = wocStub([tx], { [ADDR_TWO]: { confirmed: [{ tx_hash: id, height: 900001 }], unconfirmed: [id] } });
    const r = await scanInbox({ address: ADDR_TWO, fetchFn, sleep: noSleep, now: NOW });
    expect(r.entries.length).toBe(1);
    expect(urls.filter(u => u.includes("/tx/")).length).toBe(1);
  });

  test("agent-pin binding resolves during scan; unresolvable stays unbound", async () => {
    const pin = agentPinTx(ONE);
    const bound = messageTx({ env: { fromAgentPin: `${txidOf(pin)}.0` } });
    const unbound = messageTx({ env: { nonce: "ff".repeat(16), fromAgentPin: `${"ef".repeat(32)}.0` } });
    const history = { [ADDR_TWO]: { confirmed: [
      { tx_hash: txidOf(bound), height: 900001 }, { tx_hash: txidOf(unbound), height: 900002 },
    ], unconfirmed: [] } };
    const { fetchFn } = wocStub([bound, unbound, pin], history);
    const r = await scanInbox({ address: ADDR_TWO, fetchFn, sleep: noSleep, now: NOW });
    const b = r.entries.find(e => e.txid === txidOf(bound))!;
    const u = r.entries.find(e => e.txid === txidOf(unbound))!;
    expect(b.bound).toBe(true);
    expect(u.bound).toBe(false);
    expect(u.boundReason).toBeTruthy();
  });

  test("WoC requests are paced under the 3 req/s public limit", async () => {
    const tx = messageTx();
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); };
    const { fetchFn } = wocStub([tx], { [ADDR_TWO]: { confirmed: [{ tx_hash: txidOf(tx), height: 900001 }], unconfirmed: [] } });
    await scanInbox({ address: ADDR_TWO, fetchFn, sleep, now: NOW });
    // confirmed history + unconfirmed history + tx hex = 3 requests, 2 pauses
    expect(sleeps.length).toBe(2);
    for (const ms of sleeps) expect(ms).toBeGreaterThanOrEqual(334);
  });

  test("keyless: a root with only address.txt scans without any key material", async () => {
    const tx = messageTx();
    const root = rootWithAddress();
    expect(existsSync(join(root, "wif.enc"))).toBe(false);
    expect(existsSync(join(root, "wrap.key"))).toBe(false);
    const { fetchFn } = wocStub([tx], { [ADDR_TWO]: { confirmed: [{ tx_hash: txidOf(tx), height: 900001 }], unconfirmed: [] } });
    const r = await scanInbox({ root, fetchFn, sleep: noSleep, now: NOW });
    expect(r.entries.length).toBe(1);
    expect(existsSync(join(root, "inbox.json"))).toBe(true);
  });

  test("address-only scans never persist state", async () => {
    const tx = messageTx();
    const { fetchFn } = wocStub([tx], { [ADDR_TWO]: { confirmed: [{ tx_hash: txidOf(tx), height: 900001 }], unconfirmed: [] } });
    const r = await scanInbox({ address: ADDR_TWO, fetchFn, sleep: noSleep, now: NOW });
    expect(r.entries.length).toBe(1);
  });

  test("neither root nor address throws; invalid address throws", async () => {
    const { fetchFn } = wocStub([], {});
    await expect(scanInbox({ fetchFn, sleep: noSleep })).rejects.toThrow();
    await expect(scanInbox({ address: "3QJmV3qfvL9SuYo34YihAf3sRCW3qSinyC", fetchFn, sleep: noSleep })).rejects.toThrow();
  });

  test("invalid address.txt fails closed", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "address.txt"), "not-an-address\n");
    const { fetchFn } = wocStub([], {});
    await expect(scanInbox({ root, fetchFn, sleep: noSleep })).rejects.toThrow();
  });

  test("history API error responses fail closed", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ result: [], error: "rate limited" }))) as unknown as typeof fetch;
    await expect(scanInbox({ address: ADDR_TWO, fetchFn, sleep: noSleep })).rejects.toThrow();
  });

  test("malformed history rows fail closed", async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/confirmed/history")) return new Response(JSON.stringify({ result: [{ tx_hash: "zz", height: -1 }], error: "" }));
      return new Response(JSON.stringify({ result: [], error: "" }));
    }) as typeof fetch;
    await expect(scanInbox({ address: ADDR_TWO, fetchFn, sleep: noSleep })).rejects.toThrow();
  });
});

test("WoC 404 on an empty history page is an empty scan, not an error", async () => {
  // Live WoC returns 404 "Not Found" when a height-filtered confirmed page
  // has no rows; an empty inbox must scan cleanly, not fail.
  const root = rootWithAddress();
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/confirmed/history") || url.includes("/unconfirmed/history"))
      return new Response("Not Found", { status: 404 });
    throw new Error("unexpected fetch: " + url);
  }) as unknown as typeof fetch;
  const r = await scanInbox({ root, fetchFn, sleep: noSleep, now: NOW });
  expect(r.entries.length).toBe(0);
  expect(r.newCount).toBe(0);
  expect(r.processed).toBe(0);
  expect(r.highWater).toBe(0);
  expect(loadInboxStore(root).highWater).toBe(0);
});

describe("inbox store (fail-closed persistence)", () => {
  test("store round-trips through inbox.json", async () => {
    const tx = messageTx();
    const root = rootWithAddress();
    const { fetchFn } = wocStub([tx], { [ADDR_TWO]: { confirmed: [{ tx_hash: txidOf(tx), height: 900001 }], unconfirmed: [] } });
    await scanInbox({ root, fetchFn, sleep: noSleep, now: NOW });
    const store = loadInboxStore(root);
    expect(store.v).toBe(1);
    expect(store.highWater).toBe(900001);
    expect(store.entries.length).toBe(1);
    expect(store.seen[txidOf(tx)]).toBeUndefined(); // pruned: at/below the mark, never re-fetched
  });

  test("missing store loads as empty", () => {
    const store = loadInboxStore(tmpRoot());
    expect(store).toEqual({ v: 1, highWater: 0, seen: {}, entries: [] });
  });

  test("malformed store fails closed", () => {
    const root = tmpRoot();
    writeFileSync(join(root, "inbox.json"), JSON.stringify({ v: 2, highWater: 0, seen: {}, entries: [] }));
    expect(() => loadInboxStore(root)).toThrow();
    writeFileSync(join(root, "inbox.json"), "{corrupt");
    expect(() => loadInboxStore(root)).toThrow();
  });

  test("seen entries at or below the mark are pruned; mempool entries kept", async () => {
    const a = messageTx();
    const b = messageTx({ env: { nonce: "ff".repeat(16) } });
    const root = rootWithAddress();
    const history = { [ADDR_TWO]: { confirmed: [{ tx_hash: txidOf(a), height: 900001 }], unconfirmed: [txidOf(b)] } };
    const stub = wocStub([a, b], history);
    await scanInbox({ root, fetchFn: stub.fetchFn, sleep: noSleep, now: NOW });
    let store = loadInboxStore(root);
    expect(store.seen[txidOf(b)]).toBe(0);
    history[ADDR_TWO]!.unconfirmed = [];
    history[ADDR_TWO]!.confirmed.push({ tx_hash: txidOf(b), height: 900002 });
    await scanInbox({ root, fetchFn: stub.fetchFn, sleep: noSleep, now: NOW + 600 });
    store = loadInboxStore(root);
    expect(store.seen[txidOf(a)]).toBeUndefined(); // pruned: 900001 <= mark 900002
    expect(store.seen[txidOf(b)]).toBeUndefined(); // pruned: at the mark
    expect(store.highWater).toBe(900002);
    expect(store.entries.length).toBe(2);
  });

  test("cached entries are capped at 500, oldest evicted", async () => {
    const root = rootWithAddress();
    const old: InboxEntry[] = Array.from({ length: 500 }, (_, i) => ({
      txid: i.toString(16).padStart(64, "0"), transport: "option-a" as const,
      from: ADDR_ONE, to: ADDR_TWO, type: "handoff", body: "x",
      nonce: NONCE, ts: TS, height: 800000 + i, confirmed: true, firstSeen: NOW,
      verified: true, bound: false, tipPayee: ADDR_TWO, untrusted: true as const,
    }));
    const store: InboxStore = { v: 1, highWater: 800499, seen: {}, entries: old };
    writeFileSync(join(root, "inbox.json"), JSON.stringify(store));
    const tx = messageTx();
    const { fetchFn } = wocStub([tx], { [ADDR_TWO]: { confirmed: [{ tx_hash: txidOf(tx), height: 900500 }], unconfirmed: [] } });
    const r = await scanInbox({ root, fetchFn, sleep: noSleep, now: NOW });
    const st = loadInboxStore(root);
    expect(st.entries.length).toBe(500);
    expect(st.entries.some(e => e.txid === txidOf(tx))).toBe(true);
    expect(st.entries.some(e => e.txid === old[0]!.txid)).toBe(false); // oldest evicted
    expect(r.entries[0]!.txid).toBe(txidOf(tx));
    expect(loadInboxStore(root).entries.length).toBe(500);
  });
});

describe("messages / message_verify MCP boundary (keyless, no network on error paths)", () => {
  test("tools are registered; messages without an inbox address fails closed", async () => {
    const root = tmpRoot();
    const server = createServer(root);
    const client = new Client({ name: "inbox-test", version: "1" });
    try {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      await client.connect(a);
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("messages");
      expect(names).toContain("message_verify");
      // No address.txt and no address argument: must fail before any fetch.
      const res = await client.callTool({ name: "messages", arguments: {} });
      expect(res.isError).toBe(true);
      const parsed = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
      expect(parsed.ok).toBe(false);
      expect(String(parsed.error)).toMatch(/address/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("message_verify rejects a malformed txid before any fetch", async () => {
    const root = tmpRoot();
    const server = createServer(root);
    const client = new Client({ name: "inbox-test", version: "1" });
    try {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      await client.connect(a);
      const res = await client.callTool({ name: "message_verify", arguments: { txid: "not-a-txid" } });
      expect(res.isError).toBe(true);
      const parsed = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
      expect(parsed.ok).toBe(false);
      expect(String(parsed.error)).toMatch(/txid/i);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("messages CLI boundary", () => {
  const cli = join(import.meta.dir, "cli.ts");
  const runCli = (args: string[], root: string) =>
    Bun.spawnSync(["bun", cli, ...args], {
      env: { ...process.env, DOGFOOD_WALLET_DIR: root },
      stdout: "pipe", stderr: "pipe",
    });

  test("unknown option is rejected", () => {
    const p = runCli(["messages", "--bogus"], tmpRoot());
    expect(p.exitCode).not.toBe(0);
    expect(p.stderr.toString() + p.stdout.toString()).toMatch(/REJECTED.*--bogus/);
  });

  test("--limit out of range is rejected", () => {
    const p = runCli(["messages", "--limit", "0"], tmpRoot());
    expect(p.exitCode).not.toBe(0);
    expect(p.stderr.toString() + p.stdout.toString()).toMatch(/--limit/);
  });

  test("no vault address and no --address fails closed without network", () => {
    const p = runCli(["messages", "--json"], tmpRoot());
    expect(p.exitCode).not.toBe(0);
    expect(p.stderr.toString() + p.stdout.toString()).toMatch(/address/i);
  });
});
