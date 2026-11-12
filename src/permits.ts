import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { vaultPaths } from "./vault";

/**
 * One-time payment permits: the executable half of an approved `permit-send`
 * request. A permit waives the local allowlist and caps for ONE `send` of the
 * exact {to, amount} — never the killfile, never a BRC-181 envelope. The
 * spend still logs normally. Lifecycle:
 *
 *   unspent --(matching send, committed BEFORE signing)--> committed
 *   committed --(pre-commitment failure)--> unspent        (retry is safe)
 *   committed --(broadcast success)--> spent (+txid)
 *   committed --(ambiguous broadcast)--> stays committed   (human reconciles)
 *   unspent  --(human `permit-revoke`)--> revoked
 */
export interface SendPermit {
  id: string; // the approving request's id
  to: string;
  amount: number;
  reason?: string;
  status: "unspent" | "committed" | "spent" | "revoked";
  approvedAt: string;
  committedAt?: string;
  spentAt?: string;
  txid?: string;
  revokedAt?: string;
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function permitsDir(root: string): string {
  return vaultPaths(root).permits;
}

function permitPath(root: string, id: string): string {
  if (!ID_RE.test(id)) throw new Error("Invalid permit id: expected uuid");
  return join(permitsDir(root), `${id}.json`);
}

function writePermitAtomic(path: string, permit: SendPermit): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(permit, null, 2) + "\n", "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** Called by approveRequest for a permit-send ask. Idempotent per request id. */
export function issuePermit(root: string, input: { id: string; to: string; amount: number; reason?: string }): SendPermit {
  const permit: SendPermit = {
    id: input.id,
    to: input.to,
    amount: input.amount,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    status: "unspent",
    approvedAt: new Date().toISOString(),
  };
  mkdirSync(permitsDir(root), { recursive: true, mode: 0o700 });
  writePermitAtomic(permitPath(root, input.id), permit);
  return permit;
}

export function listPermits(root: string): SendPermit[] {
  const dir = permitsDir(root);
  if (!existsSync(dir)) return [];
  const out: SendPermit[] = [];
  for (const name of readdirSync(dir)) {
    if (!ID_RE.test(name.replace(/\.json$/, "")) || !name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as SendPermit);
    } catch {
      // Skip torn/foreign files.
    }
  }
  return out.sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));
}

/** Oldest unspent exact {to, amount} match, if any. */
export function findPermit(root: string, to: string, amount: number): SendPermit | undefined {
  return listPermits(root).find((p) => p.status === "unspent" && p.to === to && p.amount === amount);
}

function transition(root: string, id: string, from: SendPermit["status"], patch: Partial<SendPermit>): SendPermit {
  const path = permitPath(root, id);
  if (!existsSync(path)) throw new Error("Invalid permit: not found: " + id);
  const current = JSON.parse(readFileSync(path, "utf8")) as SendPermit;
  if (current.status !== from) throw new Error(`Invalid permit: not ${from} (status ${current.status})`);
  const next = { ...current, ...patch };
  writePermitAtomic(path, next);
  return next;
}

/** unspent -> committed. Called when a matching send decides to proceed. */
export function commitPermit(root: string, id: string): SendPermit {
  return transition(root, id, "unspent", { status: "committed", committedAt: new Date().toISOString() });
}

/** committed -> unspent. Called when the send failed before any commitment. */
export function releasePermit(root: string, id: string): SendPermit {
  return transition(root, id, "committed", { status: "unspent", committedAt: undefined });
}

/** committed -> spent. Called only after a verified broadcast acknowledgement. */
export function spendPermit(root: string, id: string, txid: string): SendPermit {
  return transition(root, id, "committed", { status: "spent", txid, spentAt: new Date().toISOString() });
}

/** Human-only (CLI): unspent -> revoked. */
export function revokePermit(root: string, id: string): SendPermit {
  return transition(root, id, "unspent", { status: "revoked", revokedAt: new Date().toISOString() });
}
