import { closeSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export class PaymentHeldError extends Error {
  readonly code = "PAYMENT_HELD";
  constructor() { super("REJECTED: payment is active or unresolved. Human forensic recovery required; see docs/payment-recovery.md. Never automatically retry or clear this hold."); }
}

// lstat, not existsSync: dangling links and permission/read failures must fail closed.
function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
function syncDirectory(root: string) {
  // Windows does not support opening directories for fsync via Node/Bun.
  // File fsync remains mandatory. See the documented power-loss limitation.
  if (process.platform === "win32") return;
  const fd = openSync(root, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableWrite(path: string, data: unknown, flags: string) {
  const fd = openSync(path, flags === "a" ? "a+" : flags, 0o600);
  try {
    let prefix = "";
    if (flags === "a") {
      const size = fstatSync(fd).size;
      if (size) {
        const last = Buffer.alloc(1);
        if (readSync(fd, last, 0, 1, size - 1) !== 1) throw new Error("Cannot inspect spend log tail");
        if (last[0] !== 10) prefix = "\n";
      }
    }
    writeFileSync(fd, prefix + JSON.stringify(data) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
/** Sanitized read-only diagnostics. Invalid/unreadable state is itself a hold. */
export function inspectPaymentHold(root: string) {
  let lock: "absent" | "present" | "unreadable" = "absent";
  let pending: "absent" | "valid" | "invalid" = "absent";
  let intent: { id: string; asset: string; amount: number } | undefined;
  try { if (present(join(root, "payment.lock"))) lock = "present"; } catch { lock = "unreadable"; }
  try {
    if (present(join(root, "payment.pending.json"))) {
      pending = "invalid";
      const row = JSON.parse(readFileSync(join(root, "payment.pending.json"), "utf8"));
      if (row?.version === 1 && typeof row.id === "string" && /^[0-9a-f-]{36}$/.test(row.id)
        && ["send", "x402-pay", "x402-delegate"].includes(row.operation) && typeof row.started === "string" && Number.isFinite(Date.parse(row.started))
        && ["bsv", "usdc-base", "usdc-solana"].includes(row.asset) && Number.isSafeInteger(row.amount) && row.amount > 0
        && typeof row.to === "string" && /^[a-zA-Z0-9]{20,100}$/.test(row.to)
        && (row.fee === undefined || (Number.isSafeInteger(row.fee) && row.fee >= 0))) {
        pending = "valid";
        intent = { id: row.id, asset: row.asset, amount: row.amount };
      }
    }
  } catch { pending = "invalid"; }
  return { blocked: lock !== "absent" || pending !== "absent", lock, pending, ...(intent ? { intent } : {}) };
}

export type PaymentIntent = { asset: string; amount: number; to: string; fee?: number };
export type PaymentGuard = {
  reserve: (intent: PaymentIntent) => void;
  log: (row: Record<string, unknown>) => void;
};

/** Cooperative local-filesystem exclusion, acquired before policy/usage reads.
 * Any abandoned lock, even empty/corrupt, blocks forever. No PID/time recovery.
 */
export async function withPaymentGuard<T>(root: string, operation: string, run: (guard: PaymentGuard) => Promise<T>): Promise<T> {
  const lock = join(root, "payment.lock");
  const pending = join(root, "payment.pending.json");
  if (present(pending)) throw new PaymentHeldError();
  const id = randomUUID();
  try { durableWrite(lock, { version: 1, id, operation, pid: process.pid, started: new Date().toISOString() }, "wx"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new PaymentHeldError();
    throw e; // Partial acquisition is intentionally NOT removed.
  }
  syncDirectory(root);
  // Check again while exclusive: orphan pending state is never overwritten.
  if (present(pending)) throw new PaymentHeldError();
  let exposed = false;
  let logged = false;
  let finished = false;
  try {
    const result = await run({
      reserve(intent) {
        if (exposed) throw new Error("Payment already reserved");
        exposed = true; // Persistence failure must also keep the lock.
        durableWrite(pending, { version: 1, id, operation, started: new Date().toISOString(), ...intent }, "wx");
        syncDirectory(root);
      },
      log(row) {
        if (!exposed || logged) throw new Error("Payment log requires one reservation");
        durableWrite(join(root, "spends.jsonl"), { ...row, paymentId: id }, "a");
        syncDirectory(root);
        logged = true;
      },
    });
    if (exposed && !logged) throw new Error("Payment result has no durable accounting; hold retained");
    finished = true;
    return result;
  } finally {
    if (!exposed || (finished && logged)) {
      if (exposed) { unlinkSync(pending); syncDirectory(root); }
      unlinkSync(lock);
      syncDirectory(root);
    }
  }
}
