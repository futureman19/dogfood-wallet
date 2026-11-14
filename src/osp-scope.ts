// osp-scope.ts — OSP-0002 §4 scope blob canonicalization (JCS subset).
// Byte-exact port of the audited door verifier's rules: sorted keys, no
// floats/unsafe numbers, the blob must already be in canonical form, and a
// mandatory 128-bit lowercase-hex salt makes scope hashes unforgeable by
// brute force (Codex/Grok review findings upstream).

import { createHash } from "node:crypto";

export function jcs(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("scope: floats/unsafe numbers forbidden");
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(jcs).join(",") + "]";
  if (typeof v === "object" && v !== null) {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return (
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + jcs((v as Record<string, unknown>)[k])).join(",") +
      "}"
    );
  }
  throw new Error("scope: unsupported value type");
}

/** Validate a scope blob exactly as the door does at admission. */
export function canonicalScope(blobStr: string): Record<string, unknown> {
  let obj: unknown;
  try {
    obj = JSON.parse(blobStr);
  } catch {
    throw new Error("scope blob is not valid JSON");
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error("scope blob must be a JSON object");
  }
  const canon = jcs(obj); // also rejects floats; duplicate keys collapse → mismatch below
  if (canon !== blobStr) throw new Error("scope blob is not canonical JCS-subset");
  const salt = (obj as Record<string, unknown>).salt;
  if (typeof salt !== "string" || !/^[0-9a-f]{32}$/.test(salt)) {
    throw new Error("scope blob missing 128-bit salt (32 lowercase hex chars)");
  }
  return obj as Record<string, unknown>;
}

export function scopeHashHex(canonicalBlobStr: string): string {
  return createHash("sha256").update(canonicalBlobStr, "utf8").digest("hex");
}

/** OSP-0005 §4: payment terms, when present, ride inside the scope blob. */
export function scopePayment(obj: Record<string, unknown>): { amount_sats: number; script: string } | undefined {
  const pay = obj.payment;
  if (pay === undefined) return undefined;
  if (typeof pay !== "object" || pay === null || Array.isArray(pay)) throw new Error("malformed payment terms");
  const p = pay as Record<string, unknown>;
  if (!Number.isSafeInteger(p.amount_sats) || (p.amount_sats as number) < 1) throw new Error("malformed payment terms");
  if (typeof p.script !== "string" || !/^[0-9a-f]+$/.test(p.script)) throw new Error("malformed payment terms");
  return { amount_sats: p.amount_sats as number, script: p.script };
}
