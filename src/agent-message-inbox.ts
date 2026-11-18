// agent-message-inbox.ts — S3: read-only inbox scan + keyless verification.
//
// Doctrine (docs/agent-messaging-design.md §3.4, §6):
//   - Keyless and read-only: no vault decryption, no signing, no broadcast.
//     The inbox address comes from address.txt (public) or the caller.
//   - WoC address history is the only chain source; every fetch is injectable
//     and paced under the 3 req/s public limit.
//   - A message is surfaced only when a 546-sat P2PKH tip pays envelope.to AND
//     that payee is the scanned address. Sent messages (change-only visibility)
//     never pollute the sender's own inbox.
//   - Signature failures are surfaced verified:false — never silently dropped,
//     never trusted. Agent-pin binding requires a verified authorship key.
//   - Bodies are UNTRUSTED peer data (prompt-injection boundary): every entry
//     carries untrusted:true and must never be executed as instructions.
//   - Scanner-level disjointness from OSP: only strict agent-message shapes
//     classify; OSP door envelopes and plain payments never surface.
//   - Dedupe by txid + a confirmed-height high-water mark make repeat scans
//     cheap. The mark never advances past an unprocessed transaction.
//   - The local store is fail-closed: malformed inbox.json throws.
import { existsSync, openSync, fsyncSync, closeSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { PublicKey, Transaction, Utils } from "@bsv/sdk";
import {
  parseMessageScript, verifyMessageScript, parseLocusMessagePayload, strictMainnetAddress,
  MESSAGE_SUBTYPE, MESSAGE_TIP_SATS, LOCUS_P, LOCUS_V, type Envelope,
} from "./agent-message";
import { sourceTransaction } from "./gryd-buy";
import { vaultPaths } from "./vault";

export const WOC_BASE = "https://api.whatsonchain.com/v1/bsv/main";
const PAGE_LIMIT = 1000;          // WoC confirmed/history max page
const DEFAULT_MAX_TX_FETCHES = 50;
const MAX_CACHED_ENTRIES = 500;
const MAX_MEMPOOL_SEEN = 1000;
const PACE_MS = 350;              // 3 req/s public limit → ≥334ms between calls
const TXID = /^[a-f0-9]{64}$/;
const PIN_REF = /^[a-f0-9]{64}\.(0|[1-9][0-9]*)$/;
const PUBKEY = /^(02|03)[0-9a-f]{64}$/;
const P2PKH_SCRIPT = /^76a914([0-9a-f]{40})88ac$/;

export type InboxEntry = {
  txid: string;
  transport: "option-a" | "option-b";
  from: string; to: string; type: string; body: unknown;
  fromAgentPin?: string; toAgentPin?: string;
  nonce: string; ts: number;
  height: number; confirmed: boolean; firstSeen: number;
  verified: boolean; verifyError?: string;
  bound: boolean; boundReason?: string;
  pinId?: string; tipPayee: string;
  untrusted: true;
};

export type InboxStore = { v: 1; highWater: number; seen: Record<string, number>; entries: InboxEntry[] };

export type MessageVerifyResult = {
  txid: string;
  message: boolean;
  reason?: string;
  transport?: "option-a" | "option-b";
  verified?: boolean; verifyError?: string;
  from?: string; to?: string; type?: string; body?: unknown;
  fromAgentPin?: string; toAgentPin?: string;
  nonce?: string; ts?: number;
  pubkey?: string; tipPayee?: string; toMatchesTip?: boolean;
  bound?: boolean; boundReason?: string; pinId?: string;
  untrusted?: true;
  confirmationChecked: false;
};

export type ScanResult = {
  address: string;
  entries: InboxEntry[];
  newCount: number;
  processed: number;
  truncated: boolean;
  highWater: number;
};

function fail(m: string): never { throw new Error(m); }
const isInt = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;

// ---- strict script helpers ----

/** Address locked by a standard P2PKH script, or null. */
function p2pkhAddress(scriptHex: string): string | null {
  const m = P2PKH_SCRIPT.exec(scriptHex);
  if (!m) return null;
  return Utils.toBase58Check(Utils.toArray(m[1]!, "hex"), [0]);
}

/** Single-push OP_RETURN payload text (bare 6a or 006a), or null when the
 * script is not exactly one data push. Mirrors the codec's strictness. */
function singlePushPayload(scriptHex: string): string | null {
  const b = Utils.toArray(scriptHex, "hex");
  let i = 0;
  if (b[0] === 0x00 && b[1] === 0x6a) i = 2;
  else if (b[0] === 0x6a) i = 1;
  else return null;
  const op = b[i];
  let len: number, header: number;
  if (op !== undefined && op >= 1 && op <= 75) { len = op; header = 1; }
  else if (op === 0x4c) { len = b[i + 1] ?? -1; header = 2; }
  else if (op === 0x4d) { len = (b[i + 1] ?? 0) | ((b[i + 2] ?? 0) << 8); header = 3; }
  else if (op === 0x4e) { len = (b[i + 1] ?? 0) | ((b[i + 2] ?? 0) << 8) | ((b[i + 3] ?? 0) << 16) | ((b[i + 4] ?? 0) << 24); header = 5; }
  else return null;
  if (len < 0 || i + header + len !== b.length) return null;
  return Utils.toUTF8(b.slice(i + header));
}

function isLocusMessageShape(json: string): boolean {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return !!o && typeof o === "object" && o.p === LOCUS_P && o.v === LOCUS_V
      && o.op === "mint" && o.type === "object" && o.subtype === MESSAGE_SUBTYPE;
  } catch { return false; }
}

type Classified = {
  transport: "option-a" | "option-b";
  envelope: Envelope;
  pubkey?: string;
  verified: boolean; verifyError?: string;
  tipPayee?: string; toMatchesTip: boolean;
  pinId?: string;
};

/** Classify a transaction as an agent message (or not). Shape parse first,
 * cryptographic verify second — a valid shape with a bad signature is still
 * surfaced (verified:false), never silently dropped. */
function classifyMessageTx(tx: Transaction): Classified | { none: true; reason: string } {
  const found: { transport: "option-a" | "option-b"; envelope: Envelope; pubkey?: string; verified: boolean; verifyError?: string; scriptHex: string }[] = [];
  for (const out of tx.outputs) {
    const scriptHex = out.lockingScript?.toHex() ?? "";
    if (!scriptHex.startsWith("6a") && !scriptHex.startsWith("006a")) continue;
    try {
      const parsed = parseMessageScript(scriptHex);
      try {
        const v = verifyMessageScript(scriptHex);
        found.push({ transport: "option-a", envelope: parsed.envelope, pubkey: v.pubkey, verified: true, scriptHex });
      } catch (e) {
        found.push({ transport: "option-a", envelope: parsed.envelope, verified: false, verifyError: (e as Error).message, scriptHex });
      }
      continue;
    } catch { /* not Option A shape — try Locus */ }
    const json = singlePushPayload(scriptHex);
    if (json === null || !isLocusMessageShape(json)) continue;
    try {
      const p = parseLocusMessagePayload(json);
      found.push({ transport: "option-b", envelope: p.envelope, pubkey: p.pubkey, verified: true, scriptHex });
    } catch (e) {
      // Structural Locus message but verification failed: surface the raw
      // (UNVERIFIED) envelope fields so the failure is visible, never trusted.
      let raw: Envelope = {};
      try {
        const o = JSON.parse(json) as { content?: unknown };
        if (typeof o.content === "string") raw = JSON.parse(o.content) as Envelope;
      } catch { /* unreadable content — leave empty */ }
      found.push({ transport: "option-b", envelope: raw, verified: false, verifyError: (e as Error).message, scriptHex });
    }
  }
  if (found.length === 0) return { none: true, reason: "no agent-message output" };
  if (found.length > 1) return { none: true, reason: "ambiguous: multiple agent-message outputs in one transaction" };
  const m = found[0]!;
  const to = typeof m.envelope.to === "string" ? m.envelope.to : undefined;
  // 546-sat dust-safe P2PKH tip outputs; the payee must equal envelope.to.
  const tips: { address: string; vout: number }[] = [];
  tx.outputs.forEach((out, vout) => {
    if (out.satoshis !== MESSAGE_TIP_SATS) return;
    const address = p2pkhAddress(out.lockingScript?.toHex() ?? "");
    if (address) tips.push({ address, vout });
  });
  const match = to !== undefined ? tips.find(t => t.address === to) : undefined;
  const tipPayee = match?.address ?? tips[0]?.address;
  const toMatchesTip = match !== undefined;
  const pinId = m.transport === "option-b" && match ? `${tx.id("hex")}.${match.vout}` : undefined;
  return { transport: m.transport, envelope: m.envelope, pubkey: m.pubkey, verified: m.verified, verifyError: m.verifyError, tipPayee, toMatchesTip, pinId };
}

// ---- agent-pin binding ----

type FetchFn = typeof fetch;
type Paced = <T>(fn: () => Promise<T>) => Promise<T>;

function pacer(sleep: (ms: number) => Promise<void>): Paced {
  let first = true;
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (!first) await sleep(PACE_MS);
    first = false;
    return fn();
  };
}

/** Resolve fromAgentPin → the pin's owner_pubkey must be the verified
 * authorship key. Any failure leaves the message unbound (surfaced). */
async function resolveBinding(
  envelope: Envelope, pubkey: string | undefined, verified: boolean,
  fetchFn: FetchFn, pace: Paced,
): Promise<{ bound: boolean; boundReason?: string }> {
  const ref = envelope.fromAgentPin;
  if (ref === undefined) return { bound: false, boundReason: "no agent pin claimed" };
  if (typeof ref !== "string" || !PIN_REF.test(ref)) return { bound: false, boundReason: "malformed agent pin reference" };
  if (!verified || !pubkey) return { bound: false, boundReason: "message authorship not verified" };
  const [txid, voutText] = ref.split(".");
  const vout = Number(voutText);
  try {
    const pinTx = await pace(() => sourceTransaction(txid!, fetchFn));
    if (!Number.isSafeInteger(vout) || vout < 0 || vout >= pinTx.outputs.length)
      return { bound: false, boundReason: "agent pin vout out of range" };
    const tipOut = pinTx.outputs[vout]!;
    const tipAddr = tipOut.satoshis === 1 ? p2pkhAddress(tipOut.lockingScript?.toHex() ?? "") : null;
    for (const out of pinTx.outputs) {
      const json = singlePushPayload(out.lockingScript?.toHex() ?? "");
      if (json === null) continue;
      let o: Record<string, unknown>;
      try { o = JSON.parse(json) as Record<string, unknown>; } catch { continue; }
      if (!o || o.p !== LOCUS_P || o.v !== LOCUS_V || o.op !== "mint" || o.type !== "agent") continue;
      if (typeof o.owner_pubkey !== "string" || !PUBKEY.test(o.owner_pubkey))
        return { bound: false, boundReason: "agent pin owner_pubkey invalid" };
      const pinAddr = PublicKey.fromString(o.owner_pubkey).toAddress().toString();
      if (tipAddr !== pinAddr) return { bound: false, boundReason: "agent pin tip does not pay the pin owner" };
      if (o.owner !== pinAddr || pinAddr !== envelope.from || o.owner_pubkey !== pubkey)
        return { bound: false, boundReason: "agent pin does not belong to the signing key" };
      return { bound: true };
    }
    return { bound: false, boundReason: "no agent mint in the pin transaction" };
  } catch (e) {
    return { bound: false, boundReason: `agent pin unresolvable: ${(e as Error).message}` };
  }
}

// ---- keyless single-tx verification ----

export async function verifyMessageTx(txid: string, opts: { fetchFn?: FetchFn; sleep?: (ms: number) => Promise<void> } = {}): Promise<MessageVerifyResult> {
  if (typeof txid !== "string" || !TXID.test(txid)) fail("invalid txid");
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const pace = pacer(opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))));
  const tx = await pace(() => sourceTransaction(txid, fetchFn));
  const c = classifyMessageTx(tx);
  if ("none" in c) return { txid, message: false, reason: c.reason, confirmationChecked: false };
  const e = c.envelope;
  const binding = await resolveBinding(e, c.pubkey, c.verified, fetchFn, pace);
  return {
    txid, message: true, transport: c.transport,
    verified: c.verified, verifyError: c.verifyError,
    from: typeof e.from === "string" ? e.from : undefined,
    to: typeof e.to === "string" ? e.to : undefined,
    type: typeof e.type === "string" ? e.type : undefined,
    body: e.body,
    fromAgentPin: typeof e.fromAgentPin === "string" ? e.fromAgentPin : undefined,
    toAgentPin: typeof e.toAgentPin === "string" ? e.toAgentPin : undefined,
    nonce: typeof e.nonce === "string" ? e.nonce : undefined,
    ts: isInt(e.ts) ? e.ts : undefined,
    pubkey: c.pubkey, tipPayee: c.tipPayee, toMatchesTip: c.toMatchesTip,
    bound: binding.bound, boundReason: binding.boundReason, pinId: c.pinId,
    untrusted: true, confirmationChecked: false,
  };
}

// ---- fail-closed store ----

function validateEntry(x: unknown): InboxEntry {
  if (typeof x !== "object" || x === null || Array.isArray(x)) fail("REJECTED: malformed inbox.json entry.");
  const e = x as Record<string, unknown>;
  if (typeof e.txid !== "string" || !TXID.test(e.txid)) fail("REJECTED: malformed inbox.json entry txid.");
  if (e.transport !== "option-a" && e.transport !== "option-b") fail("REJECTED: malformed inbox.json entry transport.");
  strictMainnetAddress(e.from); strictMainnetAddress(e.to); strictMainnetAddress(e.tipPayee);
  if (typeof e.type !== "string" || typeof e.nonce !== "string" || !("body" in e)) fail("REJECTED: malformed inbox.json entry fields.");
  if (!isInt(e.ts) || !isInt(e.height) || !isInt(e.firstSeen)) fail("REJECTED: malformed inbox.json entry numbers.");
  if (typeof e.confirmed !== "boolean" || typeof e.verified !== "boolean" || typeof e.bound !== "boolean" || e.untrusted !== true)
    fail("REJECTED: malformed inbox.json entry flags.");
  for (const k of ["fromAgentPin", "toAgentPin", "verifyError", "boundReason", "pinId"] as const)
    if (e[k] !== undefined && typeof e[k] !== "string") fail(`REJECTED: malformed inbox.json entry ${k}.`);
  return e as unknown as InboxEntry;
}

export function loadInboxStore(root: string): InboxStore {
  const path = vaultPaths(root).inbox;
  if (!existsSync(path)) return { v: 1, highWater: 0, seen: {}, entries: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("REJECTED: corrupt inbox.json; inbox state cannot be verified."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("REJECTED: malformed inbox.json.");
  const s = parsed as Record<string, unknown>;
  if (s.v !== 1 || !isInt(s.highWater)) fail("REJECTED: malformed inbox.json.");
  if (typeof s.seen !== "object" || s.seen === null || Array.isArray(s.seen)) fail("REJECTED: malformed inbox.json seen.");
  const seen: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.seen as Record<string, unknown>)) {
    if (!TXID.test(k) || !isInt(v)) fail("REJECTED: malformed inbox.json seen entry.");
    seen[k] = v as number;
  }
  if (!Array.isArray(s.entries) || s.entries.length > MAX_CACHED_ENTRIES) fail("REJECTED: malformed inbox.json entries.");
  const entries = (s.entries as unknown[]).map(validateEntry);
  if (new Set(entries.map(e => e.txid)).size !== entries.length) fail("REJECTED: duplicate inbox.json entries.");
  return { v: 1, highWater: s.highWater as number, seen, entries };
}

function writeStore(root: string, store: InboxStore): void {
  const path = vaultPaths(root).inbox;
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(store) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(tmp, path);
}

// ---- history fetch + validation ----

type HistoryRow = { tx_hash: string; height: number };

async function getJson(url: string, fetchFn: FetchFn, emptyOn404 = false): Promise<unknown> {
  const response = await fetchFn(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(30000) });
  // Live WoC returns 404 "Not Found" for an empty height-filtered history
  // page; that is an empty result, not a failure. Tx-hex 404s stay errors.
  if (emptyOn404 && response.status === 404) return { result: [] };
  if (!response.ok) fail(`Read-only inbox lookup failed: HTTP ${response.status}`);
  return response.json();
}

function validateHistory(data: unknown, confirmed: boolean): HistoryRow[] {
  if (typeof data !== "object" || data === null) fail("Invalid inbox history response");
  const d = data as Record<string, unknown>;
  if (d.error !== undefined && d.error !== "") fail(`Inbox history API error: ${String(d.error)}`);
  if (!Array.isArray(d.result)) fail("Invalid inbox history result");
  const rows: HistoryRow[] = [];
  const seen = new Set<string>();
  for (const r of d.result) {
    if (typeof r !== "object" || r === null) fail("Invalid inbox history row");
    const row = r as Record<string, unknown>;
    const txHash = row.tx_hash;
    if (typeof txHash !== "string" || !TXID.test(txHash)) fail("Invalid inbox history tx_hash");
    const height = confirmed ? row.height : 0;
    if (confirmed && !isInt(height, 1)) fail("Invalid inbox history height");
    if (seen.has(txHash)) fail("Duplicate inbox history row");
    seen.add(txHash);
    rows.push({ tx_hash: txHash, height: height as number });
  }
  return rows;
}

// ---- scan ----

const newestFirst = (a: InboxEntry, b: InboxEntry) =>
  (b.height - a.height) || (b.firstSeen - a.firstSeen) || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0);

export async function scanInbox(opts: {
  root?: string;
  address?: string;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  limit?: number;
  maxTxFetches?: number;
  from?: string;
  type?: string;
  now?: number;
}): Promise<ScanResult> {
  let address: string;
  if (opts.address !== undefined) address = strictMainnetAddress(opts.address);
  else if (opts.root !== undefined) {
    const path = vaultPaths(opts.root).address;
    if (!existsSync(path)) fail("No vault address.txt; cannot scan the inbox.");
    address = strictMainnetAddress(readFileSync(path, "utf8").trim());
  } else throw new Error("scanInbox requires a root or an address");
  if (opts.from !== undefined) strictMainnetAddress(opts.from);
  const limit = opts.limit ?? 50;
  if (!isInt(limit, 1) || limit > MAX_CACHED_ENTRIES) fail("limit must be 1..500");
  const budget = opts.maxTxFetches ?? DEFAULT_MAX_TX_FETCHES;
  if (!isInt(budget, 1) || budget > 200) fail("maxTxFetches must be 1..200");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!isInt(now)) fail("now must be unix seconds");
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const pace = pacer(opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))));
  const store: InboxStore = opts.root !== undefined ? loadInboxStore(opts.root) : { v: 1, highWater: 0, seen: {}, entries: [] };

  const confirmed = validateHistory(
    await pace(() => getJson(`${WOC_BASE}/address/${address}/confirmed/history?order=asc&limit=${PAGE_LIMIT}&height=${store.highWater + 1}`, fetchFn, true)),
    true,
  ).sort((a, b) => a.height - b.height || (a.tx_hash < b.tx_hash ? -1 : 1));
  const unconfirmed = validateHistory(
    await pace(() => getJson(`${WOC_BASE}/address/${address}/unconfirmed/history`, fetchFn, true)),
    false,
  );

  // Confirmed rows already seen at a lower height (mempool → confirmed) are
  // upgraded in place without re-fetching the transaction.
  const byTxid = new Map(store.entries.map(e => [e.txid, e]));
  for (const row of confirmed) {
    const prev = store.seen[row.tx_hash];
    if (prev !== undefined && prev < row.height) {
      store.seen[row.tx_hash] = row.height;
      const entry = byTxid.get(row.tx_hash);
      if (entry) { entry.height = row.height; entry.confirmed = true; }
    }
  }

  const candidates: HistoryRow[] = [];
  const inPage = new Set(confirmed.map(r => r.tx_hash));
  for (const row of confirmed) if (store.seen[row.tx_hash] === undefined) candidates.push(row);
  for (const row of unconfirmed) if (store.seen[row.tx_hash] === undefined && !inPage.has(row.tx_hash)) candidates.push({ ...row, height: 0 });

  let processed = 0;
  let newCount = 0;
  let ci = 0;
  for (; ci < candidates.length && processed < budget; ci++) {
    const row = candidates[ci]!;
    const tx = await pace(() => sourceTransaction(row.tx_hash, fetchFn));
    processed++;
    store.seen[row.tx_hash] = row.height;
    const c = classifyMessageTx(tx);
    if ("none" in c) continue;
    // Inbox filter: the tip must pay THIS address, and envelope.to must agree.
    if (!c.toMatchesTip || c.tipPayee !== address) continue;
    const e = c.envelope;
    const binding = await resolveBinding(e, c.pubkey, c.verified, fetchFn, pace);
    const entry: InboxEntry = {
      txid: row.tx_hash, transport: c.transport,
      from: typeof e.from === "string" ? e.from : "",
      to: address, type: typeof e.type === "string" ? e.type : "",
      body: e.body,
      fromAgentPin: typeof e.fromAgentPin === "string" ? e.fromAgentPin : undefined,
      toAgentPin: typeof e.toAgentPin === "string" ? e.toAgentPin : undefined,
      nonce: typeof e.nonce === "string" ? e.nonce : "",
      ts: isInt(e.ts) ? e.ts : 0,
      height: row.height, confirmed: row.height > 0, firstSeen: now,
      verified: c.verified, verifyError: c.verifyError,
      bound: binding.bound, boundReason: binding.boundReason,
      pinId: c.pinId, tipPayee: c.tipPayee!, untrusted: true,
    };
    store.entries.push(entry);
    byTxid.set(entry.txid, entry);
    newCount++;
  }
  const truncated = confirmed.length >= PAGE_LIMIT || ci < candidates.length;

  // High-water mark: never advance past an unprocessed confirmed row.
  let mark = store.highWater;
  let firstGap: number | null = null;
  for (const row of confirmed) {
    if (store.seen[row.tx_hash] === undefined) { firstGap = row.height; break; }
  }
  if (firstGap !== null) mark = Math.max(mark, firstGap - 1);
  else if (confirmed.length > 0) mark = Math.max(mark, confirmed[confirmed.length - 1]!.height);
  store.highWater = mark;

  // Prune seen: confirmed entries at/below the mark can never be re-fetched.
  for (const [txid, h] of Object.entries(store.seen)) {
    if (h > 0 && h <= mark) delete store.seen[txid];
  }
  // Bound never-confirming mempool entries (oldest first).
  const mempool = Object.entries(store.seen).filter(([, h]) => h === 0);
  if (mempool.length > MAX_MEMPOOL_SEEN) {
    for (const [txid] of mempool.slice(0, mempool.length - MAX_MEMPOOL_SEEN)) delete store.seen[txid];
  }

  store.entries.sort(newestFirst);
  if (store.entries.length > MAX_CACHED_ENTRIES) store.entries = store.entries.slice(0, MAX_CACHED_ENTRIES);
  if (opts.root !== undefined) writeStore(opts.root, store);

  let entries = store.entries;
  if (opts.from !== undefined) entries = entries.filter(e => e.from === opts.from);
  if (opts.type !== undefined) entries = entries.filter(e => e.type === opts.type);
  entries = entries.slice(0, limit);
  return { address, entries, newCount, processed, truncated, highWater: mark };
}
