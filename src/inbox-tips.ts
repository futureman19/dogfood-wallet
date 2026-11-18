// Inbox-tip exclusion store (agent messaging S2).
//
// A message pays its recipient a 1-sat "inbox tip" outpoint. Those outpoints
// are address-visible money the recipient owns, but the SENDER must never
// re-select its own previously paid tips as funding (they belong to the
// recipient's inbox semantics, and re-spending them would double-count the
// tip). This store records every tip outpoint the vault has paid; coin
// selection excludes them. Fail-closed: a malformed store throws instead of
// silently dropping exclusions.
import { existsSync, openSync, fsyncSync, closeSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { vaultPaths } from "./vault";

const OUTPOINT = /^[0-9a-f]{64}\.(0|[1-9][0-9]*)$/;

export function isValidOutpoint(s: string): boolean {
  if (!OUTPOINT.test(s)) return false;
  const idx = Number(s.slice(s.lastIndexOf(".") + 1));
  return Number.isSafeInteger(idx) && idx <= 0xffffffff;
}

type Store = { v: 1; tips: string[] };

function readStore(root: string): Store {
  const path = vaultPaths(root).inboxTips;
  if (!existsSync(path)) return { v: 1, tips: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("REJECTED: corrupt inbox-tips.json; tip exclusions cannot be verified.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("REJECTED: malformed inbox-tips.json.");
  const s = parsed as Record<string, unknown>;
  if (s.v !== 1 || !Array.isArray(s.tips)) throw new Error("REJECTED: malformed inbox-tips.json.");
  const seen = new Set<string>();
  for (const t of s.tips) {
    if (typeof t !== "string" || !isValidOutpoint(t) || seen.has(t))
      throw new Error("REJECTED: malformed inbox-tips.json entry.");
    seen.add(t);
  }
  return { v: 1, tips: s.tips as string[] };
}

function writeStore(root: string, store: Store): void {
  const path = vaultPaths(root).inboxTips;
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(store, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** All excluded tip outpoints. Missing file = none; malformed file throws. */
export function loadInboxTips(root: string): Set<string> {
  return new Set(readStore(root).tips);
}

/** Record a paid tip outpoint (idempotent). Returns the full list. */
export function markInboxTip(root: string, outpoint: string): string[] {
  if (!isValidOutpoint(outpoint)) throw new Error(`Invalid tip outpoint: ${outpoint}`);
  const store = readStore(root);
  if (!store.tips.includes(outpoint)) {
    store.tips.push(outpoint);
    writeStore(root, store);
  }
  return store.tips;
}

/** Drop marked outpoints from a UTXO list before coin selection. */
export function excludeInboxTips<T extends { tx_hash: string; tx_pos: number }>(utxos: T[], tips: Set<string>): T[] {
  if (tips.size === 0) return utxos;
  return utxos.filter((u) => !tips.has(`${u.tx_hash}.${u.tx_pos}`));
}