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
        && ["send", "agent-buy", "x402-pay", "x402-delegate", "split", "allowance-fund", "bridge-order", "bridge-funded"].includes(row.operation) && typeof row.started === "string" && Number.isFinite(Date.parse(row.started))
        && ["bsv", "usdc-base", "usdc-solana"].includes(row.asset) && Number.isSafeInteger(row.amount)
        && (row.operation === "split"
          ? row.asset === "bsv" && row.amount === 0 && Number.isSafeInteger(row.fee) && row.fee >= 0
          : row.amount > 0)
        && typeof row.to === "string" && /^[a-zA-Z0-9]{20,100}$/.test(row.to)
        && (row.fee === undefined || (Number.isSafeInteger(row.fee) && row.fee >= 0))) {
        pending = "valid";
        intent = { id: row.id, asset: row.asset, amount: row.amount };
      }
    }
  } catch { pending = "invalid"; }
  let parked = false;
  try { parked = present(join(root, "payment.bridge-parked.json")); } catch { parked = true; }
  return { blocked: parked || lock !== "absent" || pending !== "absent", lock, pending, ...(intent ? { intent } : {}) };
}

function assertLockOwner(root: string, id: string) {
  const lock = JSON.parse(readFileSync(join(root, "payment.lock"), "utf8"));
  if (lock.id !== id) throw new PaymentHeldError();
}
/** Owner-only exclusive transition. Never takes over an existing execution lock.
 * Crash-abandoned locks require forensic recovery, not PID/time heuristics.
 */
export async function withBridgeReconciliation<T>(root: string, intentId: string, run: (g: {id: string; complete: () => void}) => Promise<T>): Promise<T> {
  const lock = join(root, "payment.lock"), pending = join(root, "payment.pending.json"), parked = join(root, "payment.bridge-parked.json");
  const transitionId = randomUUID();
  try { durableWrite(lock, {version: 1, id: transitionId, operation: "bridge-reconcile", intentId}, "wx"); }
  catch(e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new PaymentHeldError(); throw e; }
  syncDirectory(root);
  let complete = false;
  try {
    const p = JSON.parse(readFileSync(pending,"utf8")), s = JSON.parse(readFileSync(parked,"utf8"));
    if (!/^[0-9a-f-]{36}$/.test(intentId) || p.version !== 1 || s.version !== 1 || p.id !== intentId || s.id !== intentId
      || p.operation !== "bridge-funded" || s.operation !== "bridge-funded") throw new PaymentHeldError();
    const result = await run({id: intentId, complete: () => {complete = true;}});
    assertLockOwner(root, transitionId);
    if (complete) { unlinkSync(parked); syncDirectory(root); unlinkSync(pending); syncDirectory(root); }
    return result;
  } finally {
    assertLockOwner(root, transitionId);
    unlinkSync(lock); syncDirectory(root);
  }
}

export type PaymentIntent = { asset: string; amount: number; to: string; fee?: number };
export type PaymentGuard = {
  readonly id: string;
  park: () => void;
  reserve: (intent: PaymentIntent) => void;
  log: (row: Record<string, unknown>) => void;
};

/** Cooperative local-filesystem exclusion, acquired before policy/usage reads.
 * Any abandoned lock, even empty/corrupt, blocks forever. No PID/time recovery.
 */
export async function withPaymentGuard<T>(root: string, operation: string, run: (guard: PaymentGuard) => Promise<T>): Promise<T> {
  const lock = join(root, "payment.lock");
  const pending = join(root, "payment.pending.json");
  if (present(pending) || present(join(root, "payment.bridge-parked.json"))) throw new PaymentHeldError();
  const id = randomUUID();
  try { durableWrite(lock, { version: 1, id, operation, pid: process.pid, started: new Date().toISOString() }, "wx"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new PaymentHeldError();
    throw e; // Partial acquisition is intentionally NOT removed.
  }
  syncDirectory(root);
  // Check again while exclusive: orphan pending state is never overwritten.
  if (present(pending) || present(join(root, "payment.bridge-parked.json"))) throw new PaymentHeldError();
  let exposed = false;
  let logged = false;
  let finished = false;
  let parked = false;
  try {
    const result = await run({
      id,
      park() {
        if (operation !== "bridge-funded" || !exposed || parked || logged) throw new PaymentHeldError();
        durableWrite(join(root, "payment.bridge-parked.json"), { version: 1, id, operation }, "wx");
        syncDirectory(root);
        parked = true;
      },
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
    if (exposed && !logged && !parked) throw new Error("Payment result has no durable accounting; hold retained");
    finished = true;
    return result;
  } finally {
    if (!exposed || parked || (finished && logged)) {
      assertLockOwner(root, id);
      if (exposed && !parked) { unlinkSync(pending); syncDirectory(root); }
      unlinkSync(lock);
      syncDirectory(root);
    }
  }
}
