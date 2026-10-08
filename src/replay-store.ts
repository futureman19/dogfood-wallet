import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// Replay ledger for the merchant's BSV rail. Reservations are kept forever
// (a broadcast timeout is ambiguous — a client must never be able to obtain
// the resource twice with one payment). The file flavor appends BEFORE the
// merchant broadcasts, so a process restart cannot lose the memory.

export type ReplayStore = {
  /** True if this txid OR any of these outpoints was already reserved. */
  has(txid: string, outpoints: string[]): boolean;
  /** Synchronously record a payment as honored. Never throws on duplicates. */
  reserve(txid: string, outpoints: string[]): void;
};

export function createMemoryReplayStore(): ReplayStore {
  const txids = new Set<string>();
  const outpoints = new Set<string>();
  return {
    has(txid, points) {
      return txids.has(txid) || points.some((p) => outpoints.has(p));
    },
    reserve(txid, points) {
      txids.add(txid);
      for (const p of points) outpoints.add(p);
    },
  };
}

export function createFileReplayStore(path: string): ReplayStore {
  const txids = new Set<string>();
  const outpoints = new Set<string>();
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as { txid?: unknown; outpoints?: unknown };
        if (typeof row.txid === "string") txids.add(row.txid);
        if (Array.isArray(row.outpoints)) {
          for (const p of row.outpoints) if (typeof p === "string") outpoints.add(p);
        }
      } catch {
        // A torn final line (crash mid-append) must not wed the ledger.
      }
    }
  }
  return {
    has(txid, points) {
      return txids.has(txid) || points.some((p) => outpoints.has(p));
    },
    reserve(txid, points) {
      txids.add(txid);
      for (const p of points) outpoints.add(p);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify({ txid, outpoints: points }) + "\n");
    },
  };
}
