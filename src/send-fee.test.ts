import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P2PKH, PrivateKey, Transaction } from "@bsv/sdk";
import { allowDestination, initVault, loadUsage } from "./vault";
import { canonicalDest, canonicalPayloadBytes } from "./brc181";
import { inspectPaymentHold } from "./payment-guard";
import { sendPayment } from "./send";

for (const maxFeeSats of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, null, "226", true]) {
  test(`invalid fee cap ${String(maxFeeSats)} rejects before vault/funding access`, async () => {
    const root = mkdtempSync(join(tmpdir(), "send-fee-invalid-"));
    let reads = 0;
    try {
      const result = await sendPayment({ root, to: "unused", amount: 100,
        maxFeeSats: maxFeeSats as number,
        fetchUtxos: async () => { reads++; throw new Error("network forbidden"); },
        fetchTxHex: async () => { reads++; throw new Error("network forbidden"); },
        broadcast: async () => { reads++; throw new Error("network forbidden"); },
      });
      expect(result).toMatchObject({ ok: false, code: "BAD_MAX_FEE" });
      expect(reads).toBe(0);
      expect(inspectPaymentHold(root).blocked).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

const cases = [
  { name: "over cap", value: 2000, cap: 225, code: "FEE_CAP" },
  { name: "zero cap", value: 2000, cap: 0, code: "FEE_CAP" },
  { name: "exact equality", value: 2000, cap: 226 },
  { name: "maximum safe cap", value: 2000, cap: Number.MAX_SAFE_INTEGER },
  { name: "omitted change over cap", value: 1227, cap: 226, code: "FEE_CAP" },
  { name: "omitted change equality", value: 1227, cap: 227 },
  { name: "no cap compatibility", value: 1227 },
  { name: "stricter signed fee", value: 2000, cap: 500, signedCap: 225, code: "POLICY" },
  { name: "stricter explicit fee", value: 2000, cap: 225, signedCap: 500, code: "FEE_CAP" },
  { name: "both equal", value: 2000, cap: 226, signedCap: 226 },
  { name: "ambiguous broadcast", value: 2000, cap: 226, ambiguous: true },
];
for (const c of cases) {
  test(`send fee boundary: ${c.name}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "send-fee-"));
    const original = Transaction.prototype.sign;
    let signs = 0, broadcasts = 0, sources = 0;
    Transaction.prototype.sign = async function (...args) { signs++; return original.apply(this, args); };
    try {
      const { address } = initVault(root);
      const to = PrivateKey.fromRandom().toAddress();
      allowDestination(root, to);
      if (c.signedCap !== undefined) {
        const vectors = JSON.parse(readFileSync(join(import.meta.dir, "../testdata/brc-181-vectors.json"), "utf8"));
        const payload = JSON.parse(vectors.vectorA.canonical);
        const issuer = PrivateKey.fromRandom();
        Object.assign(payload, { issuer: issuer.toPublicKey().toString(), per_tx_cap: 2000, total_budget: 10000,
          max_fee: c.signedCap, dest_allowlist: [canonicalDest(new P2PKH().lock(to).toHex())], dest_caps: [] });
        writeFileSync(join(root, "brc181.json"), JSON.stringify({ payload, sig: {
          alg: "ECDSA-SHA256-secp256k1", issuer: payload.issuer,
          signature: issuer.sign(Array.from(canonicalPayloadBytes(payload))).toDER("hex"),
        } }));
      }
      const source = new Transaction();
      source.addOutput({ satoshis: c.value, lockingScript: new P2PKH().lock(address) });
      const run = () => sendPayment({ root, to, amount: 1000, maxFeeSats: c.cap, origin: "agt-marketplace-bidder-01",
        fetchUtxos: async () => [{ tx_hash: source.id("hex"), tx_pos: 0, value: c.value }],
        fetchTxHex: async () => { sources++; return source.toHex(); },
        broadcast: async raw => {
          broadcasts++;
          expect(inspectPaymentHold(root).pending).toBe("valid");
          if (c.ambiguous) throw new Error("synthetic timeout");
          const tx = Transaction.fromHex(raw);
          expect(c.value - tx.outputs.reduce((s, o) => s + o.satoshis!, 0)).toBe(c.value === 1227 ? 227 : 226);
          return { txid: tx.id("hex") };
        },
      });
      if (c.ambiguous) {
        await expect(run()).rejects.toThrow("synthetic timeout");
        expect(inspectPaymentHold(root).blocked).toBe(true);
        expect(loadUsage(root).spentLifetime).toBe(0);
        expect(await run()).toMatchObject({ ok: false, code: "PAYMENT_HELD" });
        expect(broadcasts).toBe(1);
      } else {
        const result = await run();
        expect(result).toMatchObject(c.code ? { ok: false, code: c.code } : { ok: true, fee: c.value === 1227 ? 227 : 226 });
        expect(signs).toBe(c.code ? 0 : 1);
        expect(broadcasts).toBe(c.code ? 0 : 1);
        if (c.code === "FEE_CAP") expect(sources).toBe(1);
        expect(loadUsage(root).spentLifetime).toBe(c.code ? 0 : 1000);
        expect(inspectPaymentHold(root).blocked).toBe(false);
        expect(existsSync(join(root, "payment.pending.json"))).toBe(false);
      }
    } finally {
      Transaction.prototype.sign = original;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
