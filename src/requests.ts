import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Utils } from "@bsv/sdk";
import { allowDestination, updatePolicyCap, vaultPaths } from "./vault";
import { issuePermit } from "./permits";
import { canonicalScope } from "./osp-scope";

/**
 * Human-in-the-loop escalation: an agent that hits a policy denial FILES a
 * signed request instead of silently failing. Agents file and list; only the
 * human CLI approves or denies. Approval executes the exact same mutation as
 * the human's own `allow`/policy edit — no new policy powers exist for agents.
 */
export const MAX_PENDING_REQUESTS = 64;
const MAX_REASON_BYTES = 280;

export type CapField = "maxSatsPerTx" | "maxSatsPerDay" | "maxSatsLifetime";
export type RequestKind = "allow-destination" | "raise-cap" | "permit-send" | "osp-grant";

export interface PolicyRequest {
  id: string;
  kind: RequestKind;
  address?: string;
  field?: CapField;
  value?: number | null;
  to?: string;
  amount?: number;
  reason?: string;
  // osp-grant ask: the exact scope bytes + envelope params the human approves
  door?: string;
  scopeCanonical?: string;
  expiryHeight?: number;
  maxEgressBytes?: number;
  sessionPubHex?: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  decidedAt?: string;
  decision?: string;
}

function invalid(message: string): never {
  throw new Error("Invalid request: " + message);
}

function validReason(v: unknown): v is string | undefined {
  return (
    v === undefined ||
    (typeof v === "string" &&
      v.length > 0 &&
      Buffer.byteLength(v, "utf8") <= MAX_REASON_BYTES &&
      Buffer.from(v).toString("utf8") === v &&
      !/[\x00-\x1f\x7f]/.test(v))
  );
}

// SDK P2PKH.test also accepts script-hash versions; require the real mainnet
// P2PKH prefix so a queued ask can never strand a send.
function strictP2pkh(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const decoded = Utils.fromBase58Check(v);
    return decoded.prefix.length === 1 && decoded.prefix[0] === 0 && decoded.data.length === 20;
  } catch {
    return false;
  }
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requestsDir(root: string): string {
  return vaultPaths(root).requests;
}

function requestPath(root: string, id: string): string {
  if (!ID_RE.test(id)) throw new Error("Invalid request id: expected uuid");
  return join(requestsDir(root), `${id}.json`);
}

function writeRequestAtomic(path: string, request: PolicyRequest): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(request, null, 2) + "\n", "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

// Match payment-guard's local-filesystem durability boundary. Windows cannot
// fsync directories through Node/Bun; file fsync is still mandatory.
function syncRequestsDirectory(root: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(requestsDir(root), "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Permanent single-attempt claim shared by approval and denial. Never reclaim
 * by PID/time or on exception: even a successful signer can lose its response
 * before the final request write, after the payment guard has been released.
 * Empty/corrupt claims also exclude all later decisions via exclusive create.
 */
function claimDecision(root: string, id: string, action: "approve" | "deny"): PolicyRequest {
  const request = readRequest(root, id);
  if (request.status !== "pending") throw new Error("Invalid request: not pending (status " + request.status + ")");
  const path = requestPath(root, id).replace(/\.json$/, ".decision.lock");
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Invalid request: decision held (active or unresolved). Human forensic recovery required; never retry or clear automatically.");
    }
    throw e;
  }
  // No cleanup, including partial persistence failures or successful decisions.
  try {
    writeFileSync(fd, JSON.stringify({ version: 1, id, action, started: new Date().toISOString() }) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncRequestsDirectory(root);
  const claimed = readRequest(root, id);
  if (claimed.status !== "pending") throw new Error("Invalid request: not pending (status " + claimed.status + ")");
  return claimed;
}

function readRequest(root: string, id: string): PolicyRequest {
  const path = requestPath(root, id);
  if (!existsSync(path)) throw new Error("Invalid request: not found: " + id);
  return JSON.parse(readFileSync(path, "utf8")) as PolicyRequest;
}

const DOOR_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function validate(input: { kind: RequestKind; address?: unknown; field?: unknown; value?: unknown; to?: unknown; amount?: unknown; reason?: unknown; door?: unknown; scopeCanonical?: unknown; expiryHeight?: unknown; maxEgressBytes?: unknown; sessionPubHex?: unknown }): void {
  if (!validReason(input.reason)) invalid("reason must be a single UTF-8 line of at most " + MAX_REASON_BYTES + " bytes");
  if (input.kind === "allow-destination") {
    if (!strictP2pkh(input.address)) invalid("address must be a mainnet P2PKH address");
    return;
  }
  if (input.kind === "permit-send") {
    if (!strictP2pkh(input.to)) invalid("to must be a mainnet P2PKH address");
    if (typeof input.amount !== "number" || !Number.isSafeInteger(input.amount) || input.amount <= 0) {
      invalid("amount must be a positive safe integer of satoshis");
    }
    return;
  }
  if (input.kind === "osp-grant") {
    if (typeof input.door !== "string" || !DOOR_NAME_RE.test(input.door)) invalid("door must be a valid door name");
    if (typeof input.scopeCanonical !== "string" || input.scopeCanonical.length === 0 || Buffer.byteLength(input.scopeCanonical, "utf8") > 4096) {
      invalid("scopeCanonical must be a non-empty canonical scope blob of at most 4096 bytes");
    }
    try {
      canonicalScope(input.scopeCanonical); // the exact door-side validation; the bytes are the ask
    } catch (e) {
      invalid(e instanceof Error ? e.message : String(e));
    }
    if (input.expiryHeight !== undefined && (!Number.isSafeInteger(input.expiryHeight) || (input.expiryHeight as number) < 1 || (input.expiryHeight as number) > 0xffffffff)) {
      invalid("expiryHeight must be a positive safe integer");
    }
    if (input.maxEgressBytes !== undefined && (!Number.isSafeInteger(input.maxEgressBytes) || (input.maxEgressBytes as number) < 1)) {
      invalid("maxEgressBytes must be a positive safe integer");
    }
    if (input.sessionPubHex !== undefined) {
      if (typeof input.sessionPubHex !== "string" || !/^[0-9a-f]{66}$/.test(input.sessionPubHex)) {
        invalid("sessionPubHex must be a 33-byte compressed pubkey as lowercase hex");
      }
    }
    return;
  }
  if (input.kind === "raise-cap") {
    if (input.field !== "maxSatsPerTx" && input.field !== "maxSatsPerDay" && input.field !== "maxSatsLifetime") {
      invalid("field must be maxSatsPerTx, maxSatsPerDay or maxSatsLifetime");
    }
    const nullable = input.field !== "maxSatsPerTx";
    if (input.value === null) {
      if (!nullable) invalid("maxSatsPerTx requires a positive integer value");
      return;
    }
    if (typeof input.value !== "number" || !Number.isInteger(input.value) || input.value <= 0) {
      invalid("value must be a positive integer" + (nullable ? " or null" : ""));
    }
    return;
  }
  invalid("kind must be allow-destination, raise-cap, permit-send or osp-grant");
}

function sameAsk(a: PolicyRequest, b: PolicyRequest): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "allow-destination") return a.address === b.address;
  if (a.kind === "permit-send") return a.to === b.to && a.amount === b.amount;
  if (a.kind === "osp-grant") {
    return a.door === b.door && a.scopeCanonical === b.scopeCanonical
      && a.expiryHeight === b.expiryHeight && a.maxEgressBytes === b.maxEgressBytes
      && a.sessionPubHex === b.sessionPubHex;
  }
  return a.field === b.field && a.value === b.value;
}

export function fileRequest(
  root: string,
  input: { kind: RequestKind; address?: unknown; field?: unknown; value?: unknown; to?: unknown; amount?: unknown; reason?: unknown; door?: unknown; scopeCanonical?: unknown; expiryHeight?: unknown; maxEgressBytes?: unknown; sessionPubHex?: unknown },
): { request: PolicyRequest; created: boolean } {
  validate(input);
  const pending = listRequests(root, "pending");
  const draft: PolicyRequest = {
    id: "",
    kind: input.kind,
    ...(input.kind === "allow-destination" ? { address: input.address as string } : {}),
    ...(input.kind === "raise-cap" ? { field: input.field as CapField, value: input.value as number | null } : {}),
    ...(input.kind === "permit-send" ? { to: input.to as string, amount: input.amount as number } : {}),
    ...(input.kind === "osp-grant"
      ? {
          door: input.door as string,
          scopeCanonical: input.scopeCanonical as string,
          ...(input.expiryHeight !== undefined ? { expiryHeight: input.expiryHeight as number } : {}),
          ...(input.maxEgressBytes !== undefined ? { maxEgressBytes: input.maxEgressBytes as number } : {}),
          ...(input.sessionPubHex !== undefined ? { sessionPubHex: input.sessionPubHex as string } : {}),
        }
      : {}),
    ...(input.reason !== undefined ? { reason: input.reason as string } : {}),
    status: "pending",
    createdAt: "",
  };
  const existing = pending.find((p) => sameAsk(p, draft));
  if (existing) return { request: existing, created: false };
  if (pending.length >= MAX_PENDING_REQUESTS) {
    throw new Error("Invalid request: backlog full (" + MAX_PENDING_REQUESTS + " pending) — a human must decide first");
  }
  const request: PolicyRequest = { ...draft, id: randomUUID(), createdAt: new Date().toISOString() };
  mkdirSync(requestsDir(root), { recursive: true, mode: 0o700 });
  writeRequestAtomic(requestPath(root, request.id), request);
  return { request, created: true };
}

export function listRequests(root: string, status?: PolicyRequest["status"]): PolicyRequest[] {
  const dir = requestsDir(root);
  if (!existsSync(dir)) return [];
  const out: PolicyRequest[] = [];
  for (const name of readdirSync(dir)) {
    if (!ID_RE.test(name.replace(/\.json$/, "")) || !name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as PolicyRequest;
      if (!status || parsed.status === status) out.push(parsed);
    } catch {
      // Skip torn/foreign files; a broken request never blocks the queue.
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Human-only (CLI): approval executes the SAME mutation as `allow`/policy edit — or issues a one-time send permit. */
export async function approveRequest(root: string, id: string, opts?: { fetchFn?: typeof fetch }): Promise<PolicyRequest> {
  const request = claimDecision(root, id, "approve");
  let decision: string | undefined;
  if (request.kind === "allow-destination") {
    allowDestination(root, request.address!);
  } else if (request.kind === "permit-send") {
    issuePermit(root, { id: request.id, to: request.to!, amount: request.amount!, reason: request.reason });
  } else if (request.kind === "osp-grant") {
    // Approve = the human's one-touch signature: re-validate the durable ask,
    // then sign + broadcast the exact scope bytes. No silent widening.
    validate(request);
    const { signOspGrant } = await import("./osp");
    const out = await signOspGrant({
      root,
      door: request.door!,
      scopeCanonical: request.scopeCanonical!,
      expiryHeight: request.expiryHeight,
      maxEgressBytes: request.maxEgressBytes,
      sessionPubHex: request.sessionPubHex,
      fetchFn: opts?.fetchFn,
    });
    decision = "osp grant broadcast " + out.txid + " on door " + request.door
      + (out.paymentSats > 0 ? " (paid " + out.paymentSats + " sats)" : "") + " fee " + out.fee;
  } else {
    updatePolicyCap(root, request.field!, request.value!);
  }
  const decided: PolicyRequest = {
    ...request,
    status: "approved",
    decidedAt: new Date().toISOString(),
    ...(decision !== undefined ? { decision } : {}),
  };
  writeRequestAtomic(requestPath(root, id), decided);
  return decided;
}

/** Human-only (CLI). */
export function denyRequest(root: string, id: string, reason?: string): PolicyRequest {
  if (!validReason(reason)) invalid("reason must be a single UTF-8 line of at most " + MAX_REASON_BYTES + " bytes");
  const request = claimDecision(root, id, "deny");
  const decided: PolicyRequest = {
    ...request,
    status: "denied",
    decidedAt: new Date().toISOString(),
    ...(reason !== undefined ? { decision: reason } : {}),
  };
  writeRequestAtomic(requestPath(root, id), decided);
  return decided;
}
