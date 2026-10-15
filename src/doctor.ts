// Deliberately dependency-free: also runnable before `bun install`.
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { inspectPaymentHold } from "./payment-guard";

function fileState(path: string): "missing" | "present" | "unreadable" {
  try { return lstatSync(path).isFile() ? "present" : "unreadable"; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable"; }
}
function policySummary(path: string) {
  const state = fileState(path);
  if (state !== "present") return { state };
  try {
    const p = JSON.parse(readFileSync(path, "utf8"));
    if (!p || typeof p !== "object" || Array.isArray(p)) return { state: "invalid" };
    const cap = (v: unknown) => v === undefined || v === null || (Number.isSafeInteger(v) && (v as number) > 0);
    if (!cap(p.maxSatsPerTx) || !cap(p.maxSatsPerDay) || !cap(p.maxSatsLifetime)
      || (p.allowlist != null && (!Array.isArray(p.allowlist) || !p.allowlist.every((a: unknown) => typeof a === "string")))) return { state: "invalid" };
    return {
      state: "configured",
      allowlist: p.allowlist == null ? "unrestricted" : p.allowlist.length ? "restricted" : "deny-all",
      destinations: Array.isArray(p.allowlist) ? p.allowlist.length : null,
      maxSatsPerTx: p.maxSatsPerTx ?? 10000,
      maxSatsPerDay: p.maxSatsPerDay ?? null,
      maxSatsLifetime: p.maxSatsLifetime ?? null,
    };
  } catch { return { state: "invalid" }; }
}

/** Local metadata only. Not payment authorization, key validation or chain health. */
export function doctor(root: string) {
  root = resolve(root);
  const files = Object.fromEntries(["wif.enc", "wrap.key", "address.txt"].map(n => [n, fileState(join(root, n))]));
  const states = Object.values(files);
  const dependencies = ["@bsv/sdk", "@modelcontextprotocol/sdk", "@solana/spl-token", "@solana/web3.js", "viem"].map(name => ({
    name, available: fileState(join(import.meta.dir, "..", "node_modules", name, "package.json")) === "present",
  }));
  return {
    root, network: "BSV mainnet", runtime: { bun: Bun.version, executable: process.execPath }, dependencies,
    vault: states.every(s => s === "missing") ? "missing" : states.every(s => s === "present") ? "files-present-unverified" : "incomplete-or-unreadable",
    files, policy: policySummary(join(root, "policy.json")), kill: fileState(join(root, "STOP_SPENDING")),
    brc181: fileState(join(root, "brc181.json")), hold: inspectPaymentHold(root),
    note: "Read-only, offline metadata; keys are not read/decrypted, addresses and balances are not verified. Missing/invalid policy needs human review; legacy missing allowlist is unrestricted. A hold requires docs/payment-recovery.md; never auto-clear. Installed package metadata is not a runtime compatibility check.",
  };
}

if (import.meta.main) console.log(JSON.stringify(doctor(process.env.DOGFOOD_WALLET_DIR?.trim() || join(homedir(), ".dogfood-wallet")), null, 2));
