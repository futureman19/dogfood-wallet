// scripts/live-agent-loop.ts — the live cross-agent OSP grant loop.
//
// Proves design-doc §7.2/§7.3 (agent-messaging-design.md) end to end:
// agent A messages agent B an osp.grant.request -> B's keyless inbox
// verifies it -> B files it -> human approval signs + broadcasts the exact
// scope -> B messages back an osp.grant.receipt -> A verifies the grant
// ON-CHAIN -> A uses the session at the deployed door -> B revoke-closes.
//
//   bun scripts/live-agent-loop.ts                    # dry-run (default)
//   bun scripts/live-agent-loop.ts --live \
//     --vault-a <funded-dir> --vault-b <funded-dir> \
//     --authorize-broadcast [--door-name loop-1] \
//     [--door-url URL] [--admin-key KEY] [--cap-sats 6000] \
//     [--evidence DIR] [--keep]
//
// DRY-RUN: two fresh disposable vaults, one intercepted chain, and the
// DEPLOYED door's pure verifier (sibling repo agent-border-protocol,
// door/src/verify.js) self-checks grant + revoke before "broadcast".
// ZERO real network writes, zero funds.
//
// LIVE: never creates or funds vaults — funding is an explicit owner
// action OUTSIDE this script (see docs/agent-messaging-design.md §12).
// --authorize-broadcast is the human decision for every spend, including
// the request-approve equivalent. Every broadcast is single-attempt
// through the wallet payment guard; a hold stops the walk. The hard sat
// cap is checked BEFORE each spend. Keys never print.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P2PKH, PrivateKey, Script, Transaction } from "@bsv/sdk";
import { initVault, loadVault, vaultPaths } from "../src/vault";
import { doorInit, loadOspDoor, revokeOspDoor } from "../src/osp";
import { approveRequest, fileRequest } from "../src/requests";
import { sendAgentMessage } from "../src/agent-message-send";
import { scanInbox } from "../src/agent-message-inbox";
import {
  grantRequestToFilingInput,
  matchDoor,
  parseGrantRequestBody,
  parseGrantReceiptBody,
  verifyGrantReceipt,
} from "../src/agent-message-osp";
import { scopeHashHex } from "../src/osp-scope";
import { ospAddress, ospTipScriptHex } from "../src/osp-address";
import { inspectPaymentHold } from "../src/payment-guard";
import { estimateFee } from "../src/policy";
import { mockFetch } from "../src/test-support/fetch";

const WOC = "https://api.whatsonchain.com/v1/bsv/main";
const ARC = "https://arc.gorillapool.io/v1/tx";
const DEFAULT_DOOR_URL = "https://osp-door.futureman19.workers.dev";
const MESSAGE_TIP = 546; // dust-safe inbox tip (S5 live amendment)
const revHex = (h: string) => Buffer.from(h, "hex").reverse().toString("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Scratch base: honor TMPDIR (Hermes profile scratch) before the OS temp dir.
const scratchBase = process.env.TMPDIR || tmpdir();

type Step = { step: string; txid?: string; sats: number; fee: number; detail?: string };

function fail(msg: string): never {
  console.error(`\nSTOPPED: ${msg}`);
  process.exit(1);
}

function args(): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) fail(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

function setFixturePolicy(root: string): void {
  const path = vaultPaths(root).policy;
  const policy = JSON.parse(readFileSync(path, "utf8"));
  policy.messages = { maxPerDay: 10, maxBodyBytes: 8192 };
  policy.osp = { maxSatsPerTx: 2000, maxSatsPerDay: 10000 };
  writeFileSync(path, JSON.stringify(policy, null, 2) + "\n");
}

/** Deployed door verifier (pure). Optional: sibling repo may be absent. */
async function doorVerifier(): Promise<null | ((cfg: unknown, state: unknown, txHex: string, scope: string, height: number) => void)> {
  try {
    // @ts-ignore — cross-repo JS module without type declarations
    const mod = await import("../../agent-border-protocol/door/src/verify.js");
    return mod.verifyTransition as (cfg: unknown, state: unknown, txHex: string, scope: string, height: number) => void;
  } catch {
    return null;
  }
}

async function main() {
  const a = args();
  const LIVE = a.live === true;
  const KEEP = a.keep === true;
  const cap = Number(a["cap-sats"] ?? 6000);
  if (!Number.isSafeInteger(cap) || cap <= 0) fail("--cap-sats must be a positive safe integer");
  const doorName = String(a["door-name"] ?? "loop-1");
  const doorUrl = String(a["door-url"] ?? DEFAULT_DOOR_URL).replace(/\/$/, "");
  const adminKey = String(a["admin-key"] ?? process.env.OSP_ADMIN_KEY ?? "osp-demo-admin");
  const steps: Step[] = [];
  let spent = 0;
  const budget = (step: string, estimate: number) => {
    if (spent + estimate > cap) fail(`hard cap ${cap} sats would be exceeded by ${step} (spent ${spent}, estimate ${estimate})`);
  };
  const record = (s: Step) => { steps.push(s); spent += s.sats + s.fee; console.log(`  [spend] ${s.step}: ${s.sats} sats + ${s.fee} fee (cumulative ${spent})`); };

  const evidenceDir = String(a.evidence ?? mkdtempSync(join(scratchBase, "dogfood-agent-loop-")));
  mkdirSync(evidenceDir, { recursive: true });
  const evidence = (name: string, data: unknown) => {
    writeFileSync(join(evidenceDir, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
  };

  // ---------------- vaults ----------------
  let rootA: string, rootB: string, cleanup: boolean;
  if (LIVE) {
    if (a["authorize-broadcast"] !== true) fail("--live requires --authorize-broadcast (the human decision for every spend in this walk)");
    rootA = String(a["vault-a"] ?? ""); rootB = String(a["vault-b"] ?? "");
    if (!rootA || !rootB) fail("--live requires --vault-a and --vault-b (pre-created, pre-funded disposable vaults; this script never funds)");
    for (const [label, root] of [["A", rootA], ["B", rootB]] as const) {
      if (!existsSync(vaultPaths(root).address)) fail(`vault ${label} has no address.txt: ${root}`);
      const held = inspectPaymentHold(root);
      if (held.blocked) fail(`vault ${label} has a payment HOLD (${held.pending}); reconcile before the walk`);
      const policy = JSON.parse(readFileSync(vaultPaths(root).policy, "utf8"));
      if (!policy.messages) fail(`vault ${label} policy.messages is disabled; owner must enable it before the walk`);
    }
    cleanup = false;
  } else {
    rootA = mkdtempSync(join(scratchBase, "dogfood-loop-A-"));
    rootB = mkdtempSync(join(scratchBase, "dogfood-loop-B-"));
    initVault(rootA); setFixturePolicy(rootA);
    initVault(rootB); setFixturePolicy(rootB);
    cleanup = !KEEP;
  }
  const A = loadVault(rootA);
  const B = loadVault(rootB);
  const bOwner = ospAddress(B.key);
  const bTipScript = ospTipScriptHex(B.key);
  console.log(`mode: ${LIVE ? "LIVE (authorized broadcast)" : "DRY-RUN (intercepted chain, zero network writes)"}`);
  console.log(`agent A (requester): ${A.address}`);
  console.log(`agent B (door owner): ${B.address} / osp ${bOwner}`);
  console.log(`evidence: ${evidenceDir}`);

  // ---------------- chain wiring ----------------
  type Utxo = { tx_hash: string; tx_pos: number; value: number };
  let fetchUtxos: (addr: string) => Promise<Utxo[]>;
  let fetchTxHex: (txid: string) => Promise<string>;
  let chainFetch: typeof fetch;
  let height = 900000;
  const broadcastTxs: Transaction[] = [];

  if (!LIVE) {
    const scriptToAddress = new Map<string, string>();
    scriptToAddress.set(new P2PKH().lock(A.address).toHex(), A.address);
    scriptToAddress.set(new P2PKH().lock(B.address).toHex(), B.address);
    scriptToAddress.set(bTipScript, bOwner);
    const txs = new Map<string, string>();
    const utxos = new Map<string, Utxo[]>();
    const history = new Map<string, Array<{ tx_hash: string; height: number }>>();
    for (const addr of [A.address, B.address]) {
      const seed = new Transaction();
      seed.addInput({ sourceTXID: "00".repeat(32), sourceOutputIndex: 0xffffffff, unlockingScript: Script.fromASM("OP_0") });
      seed.addOutput({ satoshis: 100_000, lockingScript: new P2PKH().lock(addr) });
      txs.set(seed.id("hex"), seed.toHex());
      utxos.set(addr, [{ tx_hash: seed.id("hex"), tx_pos: 0, value: 100_000 }]);
    }
    chainFetch = mockFetch(async (input, init) => {
      const u = String(input);
      const url = new URL(u);
      let m = url.pathname.match(/\/address\/([^/]+)\/unspent$/);
      if (m) return Response.json(utxos.get(m[1]!) ?? []);
      m = url.pathname.match(/\/address\/([^/]+)\/confirmed\/history$/);
      if (m) {
        const min = Number(url.searchParams.get("height") ?? "0");
        const rows = (history.get(m[1]!) ?? []).filter((r) => r.height >= min);
        if (rows.length === 0) return new Response("Not Found", { status: 404 });
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
        broadcastTxs.push(tx);
        height += 1;
        for (const inp of tx.inputs) {
          for (const [addr, list] of utxos) {
            utxos.set(addr, list.filter((c) => !(c.tx_hash === inp.sourceTXID && c.tx_pos === inp.sourceOutputIndex)));
          }
        }
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
    fetchUtxos = async (addr) => utxos.get(addr) ?? [];
    fetchTxHex = async (txid) => { const h = txs.get(txid); if (!h) throw new Error("unknown tx " + txid); return h; };
  } else {
    // Rate-limit resilience: retry idempotent GET/HEAD on 429/503 with backoff.
    // POSTs (ARC broadcast, door register/transition) pass through unchanged —
    // a broadcast must never be blindly resent (ambiguous ack => payment hold).
    const rawFetch = globalThis.fetch.bind(globalThis);
    chainFetch = (async (input: any, init?: any) => {
      const method = String(init?.method ?? "GET").toUpperCase();
      const idempotent = method === "GET" || method === "HEAD";
      for (let attempt = 0; ; attempt++) {
        const r = await rawFetch(input, init);
        if ((r.status === 429 || r.status === 503) && idempotent && attempt < 6) {
          const wait = (attempt + 1) * 15_000;
          console.log(`  WoC ${r.status}; GET backoff ${wait / 1000}s (retry ${attempt + 1}/6)`);
          await sleep(wait);
          continue;
        }
        return r;
      }
    }) as typeof fetch;
    fetchUtxos = async (addr) => {
      const r = await chainFetch(`${WOC}/address/${addr}/unspent`);
      if (!r.ok) throw new Error(`WoC unspent ${addr}: HTTP ${r.status}`);
      return (await r.json()) as Utxo[];
    };
    fetchTxHex = async (txid) => {
      const r = await chainFetch(`${WOC}/tx/${txid}/hex`);
      if (!r.ok) throw new Error(`WoC tx hex ${txid}: HTTP ${r.status}`);
      return await r.text();
    };
    // Preflight: door health + funded balances.
    const hz = await (await chainFetch(`${doorUrl}/healthz`)).json() as { crypto?: { ok?: boolean } };
    if (!hz.crypto?.ok) fail("door worker /healthz crypto not ok");
    const info = await (await chainFetch(`${WOC}/chain/info`)).json() as { blocks: number };
    height = info.blocks;
    for (const [label, root, need] of [["A", rootA, 3000], ["B", rootB, 4000]] as const) {
      const addr = readFileSync(vaultPaths(root).address, "utf8").trim();
      const coins = await fetchUtxos(addr);
      const total = coins.reduce((s, c) => s + c.value, 0);
      console.log(`vault ${label} balance: ${total} sats (need >= ${need})`);
      if (total < need) fail(`vault ${label} underfunded: ${total} < ${need}; fund it first (owner action)`);
    }
  }
  const wire = { fetchUtxos, fetchTxHex, broadcast: async (rawTx: string) => {
    const res = await chainFetch(ARC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rawTx }) });
    if (!res.ok) throw new Error(`ARC HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as { txid: string };
  } };

  const verify = await doorVerifier();
  if (!verify) console.log("note: sibling door verifier unavailable; skipping verifyTransition self-checks");
  const scopeObj = { allow: ["read:users"], rate: "60/min", salt: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex") };
  const { scopeCanonicalFrom } = await import("../src/osp");
  const scope = scopeCanonicalFrom(scopeObj);
  const expiryHeight = LIVE ? height + 1008 : 950000;
  const sessionPriv = PrivateKey.fromHex(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"));
  const sessionPubHex = sessionPriv.toPublicKey().toString();

  try {
    // ---------------- 1. B opens the door ----------------
    console.log("\n== 1. door genesis (B)");
    budget("genesis", estimateFee(1, 2) + 1);
    const init = await doorInit({ root: rootB, name: doorName, fetchFn: chainFetch });
    const door = loadOspDoor(rootB, doorName);
    record({ step: "genesis", txid: init.txid, sats: 1, fee: estimateFee(1, 2) });
    evidence("01-genesis", { txid: init.txid, doorIdInternalHex: init.doorIdInternalHex, registration: init.registration, doorName });
    const cfg = { doorIdInternalHex: init.doorIdInternalHex, tipLockingScriptHex: door.tipScriptHex };
    let doorState = { status: "open", tipTxidInternalHex: init.doorIdInternalHex, tipVout: 0, seen: [revHex(init.txid)] };

    if (LIVE) {
      console.log("\n== 1b. register door on the deployed worker");
      let registered = false;
      for (let i = 0; i < 6 && !registered; i++) {
        const reg = await chainFetch(`${doorUrl}/admin/register?door=${doorName}`, {
          method: "POST", headers: { "content-type": "application/json", "x-admin-key": adminKey },
          body: JSON.stringify(init.registration),
        });
        const body = await reg.json().catch(() => ({}));
        console.log(`  register: ${reg.status} ${JSON.stringify(body)}`);
        if (reg.ok) registered = true; else await sleep(10_000);
      }
      if (!registered) fail("door registration failed after retries");
    }

    // ---------------- 2. A sends the grant request ----------------
    console.log("\n== 2. osp.grant.request message (A -> B)");
    budget("request message", MESSAGE_TIP + 1300);
    const reqBody = {
      scope, doorGenesisTxid: door.genesisDisplayTxid, doorOwnerAddress: door.ownerAddress,
      reason: "live cross-agent loop: read:users for one session", sessionPubHex, expiryHeight,
    };
    const sentReq = await sendAgentMessage({ root: rootA, to: B.address, body: reqBody, type: "osp.grant.request", ...wire });
    if (!sentReq.ok) fail(`request message rejected: ${sentReq.code} ${sentReq.message}`);
    record({ step: "request-message", txid: sentReq.txid, sats: MESSAGE_TIP, fee: sentReq.fee });
    evidence("02-request-message", { txid: sentReq.txid, to: B.address, type: "osp.grant.request", nonce: sentReq.nonce, body: reqBody });

    // ---------------- 3. B scans, validates, files ----------------
    console.log("\n== 3. B inbox scan -> file the request");
    let reqEntry: Awaited<ReturnType<typeof scanInbox>>["entries"][number] | undefined;
    for (let i = 0; i < (LIVE ? 12 : 1) && !reqEntry; i++) {
      const scan = await scanInbox({ root: rootB, fetchFn: chainFetch, type: "osp.grant.request", from: A.address, ...(LIVE ? {} : { sleep: async () => {} }) });
      reqEntry = scan.entries.find((e) => e.txid === sentReq.txid);
      if (!reqEntry && LIVE) { console.log(`  not visible yet; retry ${i + 1}/12 in 15s`); await sleep(15_000); }
    }
    if (!reqEntry) fail("request message never appeared in B's inbox");
    if (!reqEntry.verified) fail("request message failed signature verification");
    if (reqEntry.from !== A.address) fail("request author is not A");
    console.log(`  inbox: verified=${reqEntry.verified} from=${reqEntry.from} untrusted=${reqEntry.untrusted}`);
    const req = parseGrantRequestBody(reqEntry.body);
    if (!matchDoor(req, door)) fail("request does not match B's door (genesis txid + owner address)");
    const { request, created } = fileRequest(rootB, grantRequestToFilingInput(req, doorName));
    if (!created) fail("request filing was not created (duplicate?)");
    console.log(`  filed: ${request.id} status=${request.status}`);
    evidence("03-filed-request", { id: request.id, status: request.status, from: reqEntry.from, verified: reqEntry.verified });

    // ---------------- 4. human approval -> grant broadcast ----------------
    console.log("\n== 4. approve -> sign + broadcast the exact scope (human decision)");
    budget("grant", 500);
    const decided = await approveRequest(rootB, request.id, { fetchFn: chainFetch });
    if (decided.status !== "approved") fail(`approval failed: ${decided.status}`);
    const grantTxid = loadOspDoor(rootB, doorName).tip!.txid;
    const grantHex = await fetchTxHex(grantTxid);
    const grantFee = Number((decided.decision ?? "").match(/fee (\d+)/)?.[1] ?? 0);
    record({ step: "grant", txid: grantTxid, sats: 0, fee: grantFee });
    console.log(`  ${decided.decision}`);
    if (verify) {
      verify(cfg, doorState, grantHex, scope, LIVE ? height : height - 1);
      console.log("  grant self-verified against the DEPLOYED door predicate");
    }
    doorState = { status: "open", tipTxidInternalHex: revHex(grantTxid), tipVout: 0, seen: [revHex(init.txid), revHex(grantTxid)] };
    evidence("04-grant", { txid: grantTxid, decision: decided.decision, scopeHash: scopeHashHex(scope) });

    // ---------------- 5. A presents the grant at the door (live only) ----------------
    let sessionToken: string | undefined;
    if (LIVE) {
      console.log("\n== 5. present grant at the deployed door -> session -> /data");
      let adm: { ok?: boolean; sessionToken?: string; error?: string } = {};
      let status = 0;
      for (let i = 0; i < 6; i++) {
        const r = await chainFetch(`${doorUrl}/transition?door=${doorName}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ txHex: grantHex, scopeBlob: scope }),
        });
        status = r.status;
        adm = await r.json().catch(() => ({}));
        if (r.ok && adm.ok) break;
        console.log(`  transition: ${status} ${JSON.stringify(adm)}; retry ${i + 1}/6 in 10s`);
        await sleep(10_000);
      }
      if (!adm.ok || !adm.sessionToken) fail(`door rejected the on-chain grant: ${status} ${JSON.stringify(adm)}`);
      sessionToken = adm.sessionToken;
      console.log("  door accepted the grant; session token issued");
      const d = await chainFetch(`${doorUrl}/data?door=${doorName}&bytes=400`, { headers: { authorization: `Bearer ${sessionToken}` } });
      const body = await d.text();
      console.log(`  /data: ${d.status}, egress-remaining: ${d.headers.get("x-egress-remaining")}, body: ${body.slice(0, 80)}...`);
      if (d.status !== 200) fail("door /data did not return 200");
      const replay = await chainFetch(`${doorUrl}/transition?door=${doorName}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHex: grantHex, scopeBlob: scope }),
      });
      console.log(`  replay: ${replay.status} (expect 403)`);
      if (replay.status !== 403) fail("replay was not rejected");
      evidence("05-door-session", { dataStatus: d.status, replayStatus: replay.status, egressRemaining: d.headers.get("x-egress-remaining") });
    }

    // ---------------- 6. B sends the receipt ----------------
    console.log("\n== 6. osp.grant.receipt message (B -> A)");
    budget("receipt message", MESSAGE_TIP + 1300);
    const recBody = { grantTxid, scopeHash: scopeHashHex(scope), doorGenesisTxid: door.genesisDisplayTxid };
    const sentRec = await sendAgentMessage({ root: rootB, to: A.address, body: recBody, type: "osp.grant.receipt", ...wire });
    if (!sentRec.ok) fail(`receipt message rejected: ${sentRec.code} ${sentRec.message}`);
    record({ step: "receipt-message", txid: sentRec.txid, sats: MESSAGE_TIP, fee: sentRec.fee });
    evidence("06-receipt-message", { txid: sentRec.txid, to: A.address, body: recBody });

    // ---------------- 7. A scans + verifies ON-CHAIN ----------------
    console.log("\n== 7. A inbox scan -> on-chain grant verification");
    let recEntry: Awaited<ReturnType<typeof scanInbox>>["entries"][number] | undefined;
    for (let i = 0; i < (LIVE ? 12 : 1) && !recEntry; i++) {
      const scan = await scanInbox({ root: rootA, fetchFn: chainFetch, type: "osp.grant.receipt", from: B.address, ...(LIVE ? {} : { sleep: async () => {} }) });
      recEntry = scan.entries.find((e) => e.txid === sentRec.txid);
      if (!recEntry && LIVE) { console.log(`  not visible yet; retry ${i + 1}/12 in 15s`); await sleep(15_000); }
    }
    if (!recEntry) fail("receipt never appeared in A's inbox");
    if (!recEntry.verified || recEntry.from !== B.address) fail("receipt authorship not verified");
    const receipt = parseGrantReceiptBody(recEntry.body);
    const v = await verifyGrantReceipt({ receipt, fetchTxHex, scopeCanonical: scope });
    if (!v.ok) fail(`on-chain grant verification failed: ${v.reason}`);
    console.log(`  on-chain verify: ok txid=${v.txid} paymentSats=${v.paymentSats}`);
    const bad = await verifyGrantReceipt({ receipt: { ...receipt, scopeHash: "ef".repeat(32) }, fetchTxHex, scopeCanonical: scope });
    if (bad.ok) fail("tampered receipt unexpectedly verified");
    console.log("  tampered-receipt control: rejected (chain is the truth)");
    evidence("07-onchain-verify", { ok: v.ok, txid: v.txid, paymentSats: v.paymentSats, tamperedControlRejected: !bad.ok });

    // ---------------- 8. B revoke-closes the door ----------------
    console.log("\n== 8. revoke-close (B)");
    budget("revoke", 450);
    const revoked = await revokeOspDoor({ root: rootB, door: doorName, fetchFn: chainFetch });
    record({ step: "revoke", txid: revoked.txid, sats: 0, fee: revoked.fee });
    const revokeHex = await fetchTxHex(revoked.txid);
    if (verify) {
      verify(cfg, doorState, revokeHex, scope, LIVE ? height : height - 1);
      console.log("  revoke self-verified against the DEPLOYED door predicate");
      let replayThrew = false;
      try { verify(cfg, { ...doorState, seen: [...doorState.seen, revoked.txid] }, grantHex, scope, LIVE ? height : height - 1); }
      catch { replayThrew = true; }
      if (!replayThrew) fail("grant replay was not rejected by the door predicate");
      console.log("  grant-replay control: rejected");
    }
    if (LIVE) {
      let closed = false;
      for (let i = 0; i < 6 && !closed; i++) {
        const rv = await chainFetch(`${doorUrl}/transition?door=${doorName}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ txHex: revokeHex, scopeBlob: scope }),
        });
        const body = await rv.json().catch(() => ({}));
        console.log(`  door revoke: ${rv.status} ${JSON.stringify(body)}`);
        if (rv.ok) closed = true; else await sleep(10_000);
      }
      if (!closed) fail("door did not accept the revoke");
      const dead = await chainFetch(`${doorUrl}/data?door=${doorName}&bytes=10`, { headers: { authorization: `Bearer ${sessionToken}` } });
      console.log(`  /data after revoke: ${dead.status} (expect 403)`);
      if (dead.status !== 403) fail("session survived revoke");
      evidence("08-revoke", { txid: revoked.txid, dataAfterRevoke: dead.status });
    } else {
      evidence("08-revoke", { txid: revoked.txid });
    }

    // ---------------- summary ----------------
    const summary = {
      mode: LIVE ? "live" : "dry-run",
      door: doorName, doorGenesisTxid: init.txid, grantTxid,
      requestMessageTxid: sentReq.txid, receiptMessageTxid: sentRec.txid, revokeTxid: revoked.txid,
      agentA: A.address, agentB: B.address, doorOwner: bOwner,
      scopeHash: scopeHashHex(scope), expiryHeight,
      steps, totalSats: spent, capSats: cap,
      broadcasts: LIVE ? undefined : broadcastTxs.length,
      evidenceDir,
    };
    evidence("summary", summary);
    console.log("\n== LOOP COMPLETE");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (cleanup) {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  }
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));