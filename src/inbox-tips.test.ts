import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInboxTips, markInboxTip, excludeInboxTips } from "./inbox-tips";
import { vaultPaths } from "./vault";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "dogfood-inbox-"));
}

const TIP = "ab".repeat(32) + ".0";
const TIP2 = "cd".repeat(32) + ".3";

describe("inbox tip exclusion store", () => {
  test("missing file means no exclusions", () => {
    const root = scratch();
    try {
      expect(loadInboxTips(root).size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mark + load round-trips and is idempotent", () => {
    const root = scratch();
    try {
      expect(markInboxTip(root, TIP)).toEqual([TIP]);
      expect(markInboxTip(root, TIP)).toEqual([TIP]);
      expect(markInboxTip(root, TIP2)).toEqual([TIP, TIP2]);
      expect([...loadInboxTips(root)]).toEqual([TIP, TIP2]);
      const stored = JSON.parse(readFileSync(vaultPaths(root).inboxTips, "utf8"));
      expect(stored.v).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mark rejects malformed outpoints", () => {
    const root = scratch();
    try {
      for (const bad of ["ab".repeat(32), "AB".repeat(32) + ".0", "ab".repeat(31) + ".0", "ab".repeat(32) + ".01", "ab".repeat(32) + ".-1", "ab".repeat(32) + ".4294967296"]) {
        expect(() => markInboxTip(root, bad)).toThrow();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed store fails closed on load", () => {
    const root = scratch();
    try {
      const path = vaultPaths(root).inboxTips;
      for (const bad of ["{corrupt", JSON.stringify({ v: 2, tips: [] }), JSON.stringify({ v: 1, tips: "x" }), JSON.stringify({ v: 1, tips: [TIP, TIP] }), JSON.stringify({ v: 1, tips: ["nope"] })]) {
        writeFileSync(path, bad);
        expect(() => loadInboxTips(root)).toThrow();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("excludeInboxTips removes only marked outpoints", () => {
    const utxos = [
      { tx_hash: "ab".repeat(32), tx_pos: 0, value: 1000 },
      { tx_hash: "ab".repeat(32), tx_pos: 1, value: 2000 },
      { tx_hash: "cd".repeat(32), tx_pos: 3, value: 3000 },
    ];
    const kept = excludeInboxTips(utxos, new Set([TIP, TIP2]));
    expect(kept).toEqual([utxos[1]]);
    expect(excludeInboxTips(utxos, new Set())).toEqual(utxos);
  });
});