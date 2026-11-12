import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Utils } from "@bsv/sdk";
import { allowDestination, updatePolicyCap, vaultPaths } from "./vault";

/**
 * Human-in-the-loop escalation: an agent that hits a policy denial FILES a
 * signed request instead of silently failing. Agents file and list; only the
 * human CLI approves or denies. Approval executes the exact same mutation as
 * the human's own `allow`/policy edit — no new policy powers exist for agents.
 */
export const MAX_PENDING_REQUESTS = 64;
const MAX_REASON_BYTES = 280;

export type CapField = "maxSatsPerTx" | "maxSatsPerDay" | "maxSatsLifetime";
export type RequestKind = "allow-destination" | "raise-cap";

export interface PolicyRequest {
  id: string;
  kind: RequestKind;
  address?: string;
  field?: CapField;
  value?: number | null;
  reason?: string;
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

function readRequest(root: string, id: string): PolicyRequest {
  const path = requestPath(root, id);
  if (!existsSync(path)) throw new Error("Invalid request: not found: " + id);
  return JSON.parse(readFileSync(path, "utf8")) as PolicyRequest;
}

function validate(input: { kind: RequestKind; address?: unknown; field?: unknown; value?: unknown; reason?: unknown }): void {
  if (!validReason(input.reason)) invalid("reason must be a single UTF-8 line of at most " + MAX_REASON_BYTES + " bytes");
  if (input.kind === "allow-destination") {
    // SDK P2PKH.test also accepts script-hash versions; require the real
    // mainnet P2PKH prefix so a queued ask can never strand a send.
    let ok = false;
    if (typeof input.address === "string") {
      try {
        const decoded = Utils.fromBase58Check(input.address);
        ok = decoded.prefix.length === 1 && decoded.prefix[0] === 0 && decoded.data.length === 20;
      } catch {
        ok = false;
      }
    }
    if (!ok) invalid("address must be a mainnet P2PKH address");
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
  invalid("kind must be allow-destination or raise-cap");
}

function sameAsk(a: PolicyRequest, b: PolicyRequest): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "allow-destination") return a.address === b.address;
  return a.field === b.field && a.value === b.value;
}

export function fileRequest(
  root: string,
  input: { kind: RequestKind; address?: unknown; field?: unknown; value?: unknown; reason?: unknown },
): { request: PolicyRequest; created: boolean } {
  validate(input);
  const pending = listRequests(root, "pending");
  const draft: PolicyRequest = {
    id: "",
    kind: input.kind,
    ...(input.kind === "allow-destination" ? { address: input.address as string } : {}),
    ...(input.kind === "raise-cap" ? { field: input.field as CapField, value: input.value as number | null } : {}),
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

/** Human-only (CLI): approval executes the SAME mutation as `allow`/policy edit. */
export function approveRequest(root: string, id: string): PolicyRequest {
  const request = readRequest(root, id);
  if (request.status !== "pending") throw new Error("Invalid request: not pending (status " + request.status + ")");
  if (request.kind === "allow-destination") {
    allowDestination(root, request.address!);
  } else {
    updatePolicyCap(root, request.field!, request.value!);
  }
  const decided: PolicyRequest = { ...request, status: "approved", decidedAt: new Date().toISOString() };
  writeRequestAtomic(requestPath(root, id), decided);
  return decided;
}

/** Human-only (CLI). */
export function denyRequest(root: string, id: string, reason?: string): PolicyRequest {
  if (!validReason(reason)) invalid("reason must be a single UTF-8 line of at most " + MAX_REASON_BYTES + " bytes");
  const request = readRequest(root, id);
  if (request.status !== "pending") throw new Error("Invalid request: not pending (status " + request.status + ")");
  const decided: PolicyRequest = {
    ...request,
    status: "denied",
    decidedAt: new Date().toISOString(),
    ...(reason !== undefined ? { decision: reason } : {}),
  };
  writeRequestAtomic(requestPath(root, id), decided);
  return decided;
}
