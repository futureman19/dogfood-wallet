import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P2PKH, PrivateKey, Spend, Transaction } from "@bsv/sdk";
import { initVault, allowDestination, loadUsage } from "./vault";
import { sendPayment } from "./send";

for (const fault of ["understated-value", "wrong-hash", "wrong-script", "missing-output", "duplicate", "fractional-value", "unsafe-total"] as const) {
  test(`send refuses ${fault} funding before signing or reservation`, async () => {
    const root = mkdtempSync(join(tmpdir(), "send-source-"));
    const original = Transaction.prototype.sign;
    let signs = 0;
    Transaction.prototype.sign = async function (...args) { signs++; return original.apply(this, args); };
    try {
      const { address } = initVault(root);
      const to = PrivateKey.fromRandom().toAddress();
      allowDestination(root, to);
      const source = new Transaction();
      source.addOutput({ satoshis: 100_000, lockingScript: new P2PKH().lock(fault === "wrong-script" ? to : address) });
      const u = { tx_hash: source.id("hex"), tx_pos: 0, value: 100_000 };
      if (fault === "understated-value") u.value = 1000;
      if (fault === "wrong-hash") u.tx_hash = "aa".repeat(32);
      if (fault === "missing-output") u.tx_pos = 1;
      if (fault === "fractional-value") u.value = 1000.5;
      if (fault === "duplicate") u.value = 500;
      if (fault === "unsafe-total") u.value = Number.MAX_SAFE_INTEGER + 1;
      const submitted: { actualFee: number; validSignature: boolean }[] = [];
      let error: unknown;
      try {
        await sendPayment({ root, to, amount: 500,
          fetchUtxos: async () => fault === "duplicate" ? [u, u] : [u],
          fetchTxHex: async () => source.toHex(),
          broadcast: async raw => {
            const tx = Transaction.fromHex(raw);
            const validSignature = fault === "understated-value" && new Spend({
              sourceTXID: source.id("hex"), sourceOutputIndex: 0, sourceSatoshis: 100_000,
              lockingScript: source.outputs[0]!.lockingScript, transactionVersion: tx.version,
              otherInputs: [], outputs: tx.outputs, inputIndex: 0,
              unlockingScript: tx.inputs[0]!.unlockingScript!, inputSequence: tx.inputs[0]!.sequence!, lockTime: tx.lockTime,
            }).validate();
            submitted.push({ actualFee: 100_000 - tx.outputs.reduce((sum, o) => sum + o.satoshis!, 0), validSignature });
            return { txid: tx.id("hex") };
          },
        });
      } catch (e) { error = e; }
      expect(submitted).toEqual([]);
      expect(signs).toBe(0);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/Invalid send source/);
      expect(loadUsage(root).spentLifetime).toBe(0);
      expect(existsSync(join(root, "payment.pending.json"))).toBe(false);
      expect(existsSync(join(root, "payment.lock"))).toBe(false);
    } finally {
      Transaction.prototype.sign = original;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
