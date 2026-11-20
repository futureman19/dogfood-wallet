// agent-message-decrypt.test.ts — S7: the owner-gated decrypt operation.
// Gate-before-decrypt (killfile), recipient addressability, verified authorship,
// expiry, tamper, and a fail-closed msgId replay store. Injectable WoC; the
// vault's OWN key is the only decryption key. No funds, no broadcast.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P2PKH, PrivateKey, Script, Transaction, UnlockingScript, Utils, BSM } from "@bsv/sdk";
import { initVault, killVault, loadVault, vaultPaths } from "./vault";
import { buildMessageScript, parseMessageScript, aipPreimage, type Envelope } from "./agent-message";
import { encryptMessageBody } from "./agent-message-crypto";
import { decryptInboxMessage } from "./agent-message-decrypt";

const ONE = new PrivateKey(1);
const THREE = new PrivateKey(3);
const NONCE = "000102030405060708090a0b0c0d0e0f";
const TS = 1763000000;
const noSleep = async () => {};

function unsignedTx(outputs: { satoshis: number; lockingScript: Script }[]): Transaction {
  const tx = new Transaction();
  tx.addInput({ sourceTXID: "ab".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  for (const o of outputs) tx.addOutput(o);
  return tx;
}
function encodePushes(prefixHex: string, pushes: Buffer[]): string {
  const out: number[] = [...Utils.toArray(prefixHex, "hex")];
  for (const p of pushes) {
    if (p.length <= 75) out.push(p.length);
    else if (p.length <= 255) out.push(0x4c, p.length);
    else out.push(0x4d, p.length & 0xff, (p.length >> 8) & 0xff);
    out.push(...p);
  }
  return Utils.toHex(out);
}
/** Encrypted tx addressed to `toAddr`, ciphertext for `recipientPub`, AIP-signed
 * by `signer` (defaults to the BRC-78 sender ONE). badAip re-signs with THREE. */
function encTx(opts: { toAddr: string; recipientPub: string; plaintext: string; type?: string; expiryHeight?: number; signer?: PrivateKey; badAip?: boolean; tamper?: boolean }): Transaction {
  const signer = opts.signer ?? ONE;
  const enc = encryptMessageBody(ONE, opts.recipientPub, opts.plaintext, opts.expiryHeight !== undefined ? { expiryHeight: opts.expiryHeight } : undefined);
  const env: Envelope = { v: 1, app: "dogfood", type: opts.type ?? "message", from: signer.toAddress().toString(), to: opts.toAddr, nonce: NONCE, ts: TS, enc: "brc78", body: enc.ciphertextB64 };
  let scriptHex = buildMessageScript(signer, env);
  if (opts.badAip) {
    const { pushes } = parseMessageScript(scriptHex);
    const sig = Buffer.from(BSM.sign(Array.from(aipPreimage(pushes.slice(0, 14))), THREE, "base64") as string, "base64");
    scriptHex = encodePushes("006a", [...pushes.slice(0, 17), sig]);
  }
  if (opts.tamper) {
    const b = Utils.toArray(scriptHex, "hex");
    b[b.length - 5] ^= 0xff; // corrupt a ciphertext byte inside the body push
    scriptHex = Utils.toHex(b);
  }
  return unsignedTx([
    { satoshis: 546, lockingScript: new P2PKH().lock(opts.toAddr) },
    { satoshis: 0, lockingScript: Script.fromHex(scriptHex) },
    { satoshis: 1000, lockingScript: new P2PKH().lock(ONE.toAddress()) },
  ]);
}
function plainTx(toAddr: string): Transaction {
  const env: Envelope = { v: 1, app: "dogfood", type: "message", from: ONE.toAddress().toString(), to: toAddr, nonce: NONCE, ts: TS, body: "hello" };
  return unsignedTx([
    { satoshis: 546, lockingScript: new P2PKH().lock(toAddr) },
    { satoshis: 0, lockingScript: Script.fromHex(buildMessageScript(ONE, env)) },
    { satoshis: 1000, lockingScript: new P2PKH().lock(ONE.toAddress()) },
  ]);
}
function wocStub(txs: Transaction[]) {
  const hexes = new Map(txs.map(t => [t.id("hex"), t.toHex()]));
  const fetchFn = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    const m = u.pathname.match(/\/tx\/([a-f0-9]{64})\/hex$/);
    if (m) { const hex = hexes.get(m[1]!); return hex ? new Response(hex) : new Response("not found", { status: 404 }); }
    return new Response("unexpected url", { status: 404 });
  }) as typeof fetch;
  return { fetchFn };
}
const scratch = () => mkdtempSync(join(tmpdir(), "dogfood-decrypt-"));

describe("S7 gated decrypt operation", () => {
  test("owner decrypts an addressed, verified, encrypted message and records the msgId", async () => {
    const root = scratch();
    try {
      initVault(root);
      const v = loadVault(root);
      const tx = encTx({ toAddr: v.address, recipientPub: v.key.toPublicKey().toString(), plaintext: "secret terms" });
      const { fetchFn } = wocStub([tx]);
      const r = await decryptInboxMessage({ root, txid: tx.id("hex"), fetchFn, sleep: noSleep });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.body).toBe("secret terms");
      expect(r.senderPubHex).toBe(ONE.toPublicKey().toString());
      expect(r.to).toBe(v.address);
      expect(typeof r.msgId).toBe("string");
      const store = JSON.parse(readFileSync(vaultPaths(root).decrypted, "utf8"));
      expect(store.msgIds[r.msgId]).toBeDefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a second decrypt of the same message is rejected as REPLAY", async () => {
    const root = scratch();
    try {
      initVault(root);
      const v = loadVault(root);
      const tx = encTx({ toAddr: v.address, recipientPub: v.key.toPublicKey().toString(), plaintext: "once" });
      const { fetchFn } = wocStub([tx]);
      const first = await decryptInboxMessage({ root, txid: tx.id("hex"), fetchFn, sleep: noSleep });
      expect(first.ok).toBe(true);
      const second = await decryptInboxMessage({ root, txid: tx.id("hex"), fetchFn, sleep: noSleep });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.code).toBe("REPLAY");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("killfile rejects decryption before any decrypt (gate-before-decrypt)", async () => {
    const root = scratch();
    try {
      initVault(root);
      const v = loadVault(root);
      const tx = encTx({ toAddr: v.address, recipientPub: v.key.toPublicKey().toString(), plaintext: "x" });
      killVault(root);
      const { fetchFn } = wocStub([tx]);
      const r = await decryptInboxMessage({ root, txid: tx.id("hex"), fetchFn, sleep: noSleep });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("KILL");
      expect(existsSync(vaultPaths(root).decrypted)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a message not addressed to this vault is rejected NOT_ADDRESSED", async () => {
    const root = scratch();
    try {
      initVault(root);
      const v = loadVault(root);
      const otherAddr = THREE.toAddress().toString();
      const tx = encTx({ toAddr: otherAddr, recipientPub: v.key.toPublicKey().toString(), plaintext: "x" });
      const { fetchFn } = wocStub([tx]);
      const r = await decryptInboxMessage({ root, txid: tx.id("hex"), fetchFn, sleep: noSleep });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("NOT_ADDRESSED");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a plaintext message is rejected NOT_ENCRYPTED", async () => {
    const root = scratch();
    try {
      initVault(root);
      const v = loadVault(root);
      const tx = plainTx(v.address);
      const { fetchFn } = wocStub([tx]);
      const r = await decryptInboxMessage({ root, txid: tx.id("hex"), fetchFn, sleep: noSleep });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("NOT_ENCRYPTED");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("an unverified (bad AIP) message is rejected UNVERIFIED, never decrypted", async () => {
    const root = scratch();
    try {
      initVault(root);
      const v = loadVault(root);
      const tx = encTx({ toAddr: v.address, recipientPub: v.key.toPublicKey().toString(), plaintext: "x", badAip: true });
      const { fetchFn } = wocStub([tx]);
      const r = await decryptInboxMessage({ root, txid: tx.id("hex"), fetchFn, sleep: noSleep });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("UNVERIFIED");
      expect(existsSync(vaultPaths(root).decrypted)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("an expired message is rejected EXPIRED", async () => {
    const root = scratch();
    try {
      initVault(root);
      const v = loadVault(root);
      const tx = encTx({ toAddr: v.address, recipientPub: v.key.toPublicKey().toString(), plaintext: "x", expiryHeight: 800000 });
      const { fetchFn } = wocStub([tx]);
      const r = await decryptInboxMessage({ root, txid: tx.id("hex"), fetchFn, sleep: noSleep, height: 800001 });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("EXPIRED");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("BRC-78 sender that does not match the AIP authorship key is rejected", async () => {
    const root = scratch();
    try {
      initVault(root);
      const v = loadVault(root);
      // ciphertext sender = ONE, but AIP signed by THREE (valid AIP, wrong authorship)
      const tx = encTx({ toAddr: v.address, recipientPub: v.key.toPublicKey().toString(), plaintext: "x", signer: THREE });
      const { fetchFn } = wocStub([tx]);
      const r = await decryptInboxMessage({ root, txid: tx.id("hex"), fetchFn, sleep: noSleep });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("DECRYPT");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a tampered ciphertext is rejected DECRYPT (GCM)", async () => {
    const root = scratch();
    try {
      initVault(root);
      const v = loadVault(root);
      const tx = encTx({ toAddr: v.address, recipientPub: v.key.toPublicKey().toString(), plaintext: "x", tamper: true });
      const { fetchFn } = wocStub([tx]);
      const r = await decryptInboxMessage({ root, txid: tx.id("hex"), fetchFn, sleep: noSleep });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(["DECRYPT", "UNVERIFIED"]).toContain(r.code);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a malformed decrypted.json store fails closed", async () => {
    const root = scratch();
    try {
      initVault(root);
      const v = loadVault(root);
      writeFileSync(vaultPaths(root).decrypted, "{not json");
      const tx = encTx({ toAddr: v.address, recipientPub: v.key.toPublicKey().toString(), plaintext: "x" });
      const { fetchFn } = wocStub([tx]);
      const r = await decryptInboxMessage({ root, txid: tx.id("hex"), fetchFn, sleep: noSleep });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("STORE");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
