// agent-message-decrypt.ts — S7: the owner-gated decrypt operation (design §13.4).
//
// Decryption is SEPARATE from the keyless inbox scan and is owner-gated: only
// this vault's own key can decrypt a message addressed to it. The ordering
// mirrors the OSP gate-before-decrypt precedent (osp.ts): the killfile is
// checked before any network work AND re-checked immediately before the key is
// used, with no intervening await. Fail-closed throughout.
//
// Gates, in order:
//   1. killfile (STOP_SPENDING) — before fetch and again before decrypt;
//   2. load this vault (owner key + address);
//   3. keyless verifyMessageTx — must be a verified, encrypted message;
//   4. recipient addressability — envelope.to must equal this vault's address;
//   5. fresh killfile, then decryptMessageBody (BRC-78 recipient/sender/GCM/
//      expiry/filing-parity checks live in the pure crypto module);
//   6. msgId replay store — a msgId already decrypted is rejected (REPLAY);
//      a malformed store fails closed (STORE). The store records on success.
//
// BRC-78 gives confidentiality only (no forward secrecy / replay / peer auth);
// authorship is the AIP signature, replay is this store. Messages must never
// carry keys, credentials or private data.
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { loadVault, vaultPaths } from "./vault";
import { MESSAGE_ENC_ALG, type Envelope } from "./agent-message";
import { decryptMessageBody } from "./agent-message-crypto";
import { verifyMessageTx } from "./agent-message-inbox";

export type DecryptOptions = {
  root: string;
  txid: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Current chain height for the inner expiryHeight check (optional). */
  height?: number;
  /** Injectable clock (epoch seconds) for the replay-store timestamp. */
  now?: number;
};

export type DecryptOutcome =
  | { ok: true; txid: string; type: string; body: unknown; msgId: string; senderPubHex: string; from: string; to: string }
  | { ok: false; code: string; message: string };

const MSGID_RE = /^[0-9a-f]{32}$/;
const MAX_STORE_ENTRIES = 10000;

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function deny(code: string, message: string): DecryptOutcome { return { ok: false, code, message }; }

/** Killfile gate — mirrors osp.ts checkKill (lstat, no symlink follow). */
function checkKill(root: string): void {
  try {
    lstatSync(vaultPaths(root).kill);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`REJECTED: cannot verify STOP_SPENDING (${errMsg(e)}).`);
  }
  throw new Error("REJECTED: STOP_SPENDING is on.");
}

type DecryptedStore = { v: 1; msgIds: Record<string, number> };

/** Fail-closed load of the replay store. Missing file = empty; anything
 * malformed (symlink, non-file, bad JSON/shape) throws so decrypt denies. */
function loadStore(root: string): DecryptedStore {
  const p = vaultPaths(root).decrypted;
  if (!existsSync(p)) return { v: 1, msgIds: {} };
  const st = lstatSync(p);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error("REJECTED: decrypted.json is not a regular file.");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(p, "utf8")); } catch { throw new Error("REJECTED: decrypted.json is not valid JSON."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("REJECTED: decrypted.json must be an object.");
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) throw new Error("REJECTED: decrypted.json has an unsupported version.");
  if (!o.msgIds || typeof o.msgIds !== "object" || Array.isArray(o.msgIds)) throw new Error("REJECTED: decrypted.json msgIds must be an object.");
  const msgIds = o.msgIds as Record<string, unknown>;
  const keys = Object.keys(msgIds);
  if (keys.length > MAX_STORE_ENTRIES) throw new Error("REJECTED: decrypted.json exceeds the replay-store bound.");
  const out: Record<string, number> = {};
  for (const k of keys) {
    if (!MSGID_RE.test(k)) throw new Error("REJECTED: decrypted.json contains a malformed msgId.");
    const v = msgIds[k];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("REJECTED: decrypted.json msgId timestamp is invalid.");
    out[k] = v;
  }
  return { v: 1, msgIds: out };
}

/** Atomic, fsynced record of a decrypted msgId (0600, rename into place). */
function recordStore(root: string, store: DecryptedStore, msgId: string, now: number): void {
  const p = vaultPaths(root).decrypted;
  const next: DecryptedStore = { v: 1, msgIds: { ...store.msgIds, [msgId]: now } };
  const tmp = `${p}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, p); } catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; }
}

/**
 * Decrypt one encrypted inbox message with this vault's own key, gated and
 * fail-closed. Returns the plaintext body + binding on success, or a denial
 * code. Never broadcasts, never spends, never writes anything but the replay
 * store on a successful first decrypt.
 */
export async function decryptInboxMessage(opts: DecryptOptions): Promise<DecryptOutcome> {
  const { root, txid } = opts;
  if (typeof txid !== "string" || !/^[a-f0-9]{64}$/.test(txid)) return deny("BAD_TXID", "txid must be 64 lowercase hex chars.");

  // 1. Gate before any network work.
  try { checkKill(root); } catch (e) { return deny("KILL", errMsg(e)); }

  // 2. Owner key + address.
  let vault: ReturnType<typeof loadVault>;
  try { vault = loadVault(root); } catch (e) { return deny("VAULT", errMsg(e)); }

  // 3. Keyless verification (no private key used here).
  const r = await verifyMessageTx(txid, { fetchFn: opts.fetchFn, sleep: opts.sleep });
  if (!r.message) return deny("NOT_MESSAGE", r.reason ?? "transaction carries no dogfood message.");
  if (!r.verified) return deny("UNVERIFIED", r.verifyError ?? "message authorship signature did not verify.");
  if (!r.encrypted) return deny("NOT_ENCRYPTED", "message is not encrypted (enc=brc78 required).");
  // 4. Recipient addressability: the message must be addressed to THIS vault.
  if (r.to !== vault.address) return deny("NOT_ADDRESSED", "message is not addressed to this vault.");
  if (r.from === undefined || r.type === undefined || r.nonce === undefined || r.ts === undefined) {
    return deny("UNVERIFIED", "verified message is missing envelope fields.");
  }

  // 5. Fresh kill check immediately before the key is used (no await between).
  try { checkKill(root); } catch (e) { return deny("KILL", errMsg(e)); }
  const envelope: Envelope = {
    v: 1, app: "dogfood", type: r.type, from: r.from, to: r.to,
    nonce: r.nonce, ts: r.ts, enc: MESSAGE_ENC_ALG, body: r.body,
  };
  let dec: ReturnType<typeof decryptMessageBody>;
  try {
    dec = decryptMessageBody(vault.key, envelope, r.pubkey!, opts.height !== undefined ? { currentHeight: opts.height } : undefined);
  } catch (e) {
    const m = errMsg(e);
    return deny(m.includes("expired") ? "EXPIRED" : "DECRYPT", m);
  }

  // 6. Replay store (fail-closed). Check reuse, then record on success.
  let store: DecryptedStore;
  try { store = loadStore(root); } catch (e) { return deny("STORE", errMsg(e)); }
  if (store.msgIds[dec.msgId] !== undefined) return deny("REPLAY", `msgId ${dec.msgId} was already decrypted by this vault.`);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  try { recordStore(root, store, dec.msgId, now); } catch (e) { return deny("STORE", errMsg(e)); }

  return { ok: true, txid, type: r.type, body: dec.body, msgId: dec.msgId, senderPubHex: dec.senderPubHex, from: r.from, to: r.to };
}
