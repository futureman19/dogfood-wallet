import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault, killVault, allowDestination } from "./vault";
import { sendPayment } from "./send";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "dogfood-send-"));
}

const TO = "1GjcRUKdwqsnrxCHiDoHtF57rKqDd8oibT";

describe("sendPayment policy gate", () => {
  test("does not fetch UTXOs when over cap", async () => {
    const root = scratch();
    try {
      initVault(root);
      allowDestination(root, TO);
      let fetched = false;
      const result = await sendPayment({
        root,
        to: TO,
        amount: 10_001,
        fetchUtxos: async () => {
          fetched = true;
          return [];
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("CAP");
      expect(fetched).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not fetch UTXOs when killfile is on", async () => {
    const root = scratch();
    try {
      initVault(root);
      allowDestination(root, TO);
      killVault(root);
      let fetched = false;
      const result = await sendPayment({
        root,
        to: TO,
        amount: 100,
        fetchUtxos: async () => {
          fetched = true;
          return [];
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("KILL");
      expect(fetched).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns INSUFFICIENT when funded below amount plus fee", async () => {
    const root = scratch();
    try {
      initVault(root);
      allowDestination(root, TO);
      const result = await sendPayment({
        root,
        to: TO,
        amount: 1000,
        fetchUtxos: async () => [{ tx_hash: "ab".repeat(32), tx_pos: 0, value: 50 }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("INSUFFICIENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not fetch UTXOs when allowlist is empty", async () => {
    const root = scratch();
    try {
      initVault(root);
      let fetched = false;
      const result = await sendPayment({
        root,
        to: TO,
        amount: 100,
        fetchUtxos: async () => {
          fetched = true;
          return [];
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("ALLOWLIST");
      expect(fetched).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
