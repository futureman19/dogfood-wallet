// agent-message-send-enc.test.ts — S7 encrypted send rides the guarded rail.
// encryptTo binds the recipient pubkey to the address; policy/fee/guard rails
// are unchanged; evidence stores ciphertext only (never plaintext). Injectable
// transport — no real network, no funds.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transaction, P2PKH, PrivateKey } from "@bsv/sdk";
import { initVault, killVault, loadVault, vaultPaths } from "./vault";
import { sendAgentMessage } from "./agent-message-send";
import { verifyMessageScript, MESSAGE_TIP_SATS } from "./agent-message";
import { decryptMessageBody } from "./agent-message-crypto";

const scratch = () => mkdtempSync(join(tmpdir(), "dogfood-msg-enc-"));
const TS = 1763000000;
const NOW = () => TS * 1000;
const NONCE = "000102030405060708090a0b0c0d0e0f";
// Recipient is a fixed test key; its address is the send target.
const RECIPIENT = PrivateKey.fromString("9".padStart(64, "0"), 16);
const RECIPIENT_ADDR = RECIPIENT.toAddress();
const RECIPIENT_PUB = RECIPIENT.toPublicKey().toString();
const STRANGER_PUB = PrivateKey.fromString("7".padStart(64, "0"), 16).toPublicKey().toString();

function enableMessages(root: string, block: Record<string, unknown> = {}): void {
  const path = vaultPaths(root).policy;
  const policy = JSON.parse(readFileSync(path, "utf8"));
  policy.messages = { recipients: [RECIPIENT_ADDR], ...block };
  writeFileSync(path, JSON.stringify(policy, null, 2));
}
function intercepted() {
  const sent: string[] = [];
  return { sent, broadcast: async (rawTx: string) => { sent.push(rawTx); return { txid: Transaction.fromHex(rawTx).id("hex") }; } };
}
function funding(root: string, value = 100_000) {
  const v = loadVault(root);
  const src = new Transaction();
  src.addOutput({ satoshis: value, lockingScript: new P2PKH().lock(v.address) });
  const hex = src.toHex();
  const coin = { tx_hash: src.id("hex"), tx_pos: 0, value };
  return { coin, fetchUtxos: async () => [coin], fetchTxHex: async () => hex };
}
function envelopeFromRaw(rawTx: string) {
  const tx = Transaction.fromHex(rawTx);
  const out = tx.outputs.find((o) => o.lockingScript.toHex().startsWith("006a"));
  if (!out) throw new Error("no OP_RETURN output");
  return { v: verifyMessageScript(out.lockingScript.toHex()), tip: tx.outputs[0].satoshis };
}

describe("S7 send: encryptTo", () => {
  test("encrypted send round-trips through the guarded rail", async () => {
    const root = scratch();
    try {
      initVault(root); enableMessages(root);
      const f = funding(root); const net = intercepted();
      const r = await sendAgentMessage({ root, to: RECIPIENT_ADDR, body: "secret terms", encryptTo: RECIPIENT_PUB, nonce: NONCE, ts: TS, now: NOW, ...f, broadcast: net.broadcast });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const { v, tip } = envelopeFromRaw(net.sent[0]);
      expect(v.envelope.enc).toBe("brc78");
      expect(v.envelope.body).not.toBe("secret terms");
      expect(tip).toBe(MESSAGE_TIP_SATS);
      const senderPub = loadVault(root).key.toPublicKey().toString();
      const out = decryptMessageBody(RECIPIENT, v.envelope, senderPub);
      expect(out.body).toBe("secret terms");
      expect(out.senderPubHex).toBe(senderPub);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("evidence stores ciphertext only, never the plaintext", async () => {
    const root = scratch();
    try {
      initVault(root); enableMessages(root);
      const f = funding(root); const net = intercepted();
      const r = await sendAgentMessage({ root, to: RECIPIENT_ADDR, body: "topsecret-plaintext", encryptTo: RECIPIENT_PUB, nonce: NONCE, ts: TS, now: NOW, ...f, broadcast: net.broadcast });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const evidence = readFileSync(r.evidence, "utf8");
      expect(evidence.includes("topsecret-plaintext")).toBe(false);
      expect(JSON.parse(evidence).envelope.enc).toBe("brc78");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("encryptTo that does not hash to the recipient address rejects before fetch", async () => {
    const root = scratch();
    try {
      initVault(root); enableMessages(root);
      let fetched = false;
      const r = await sendAgentMessage({ root, to: RECIPIENT_ADDR, body: "x", encryptTo: STRANGER_PUB, fetchUtxos: async () => { fetched = true; return []; } });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("ENCRYPT");
      expect(fetched).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("malformed encryptTo rejects before fetch", async () => {
    const root = scratch();
    try {
      initVault(root); enableMessages(root);
      const r = await sendAgentMessage({ root, to: RECIPIENT_ADDR, body: "x", encryptTo: "nope", fetchUtxos: async () => [] });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("ENCRYPT");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("killfile still rejects an encrypted send before fetch", async () => {
    const root = scratch();
    try {
      initVault(root); enableMessages(root); killVault(root);
      let fetched = false;
      const r = await sendAgentMessage({ root, to: RECIPIENT_ADDR, body: "x", encryptTo: RECIPIENT_PUB, fetchUtxos: async () => { fetched = true; return []; } });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("KILL");
      expect(fetched).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("recipient allowlist still applies to encrypted sends", async () => {
    const root = scratch();
    try {
      initVault(root); enableMessages(root, { recipients: [] });
      const r = await sendAgentMessage({ root, to: RECIPIENT_ADDR, body: "x", encryptTo: RECIPIENT_PUB, fetchUtxos: async () => [] });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("ALLOWLIST");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("plaintext body byte cap still applies to encrypted sends", async () => {
    const root = scratch();
    try {
      initVault(root); enableMessages(root, { maxBodyBytes: 5 });
      let fetched = false;
      const r = await sendAgentMessage({ root, to: RECIPIENT_ADDR, body: "x".repeat(6), encryptTo: RECIPIENT_PUB, fetchUtxos: async () => { fetched = true; return []; } });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("CAP");
      expect(fetched).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("typed osp.grant.receipt body encrypts and decrypts at filing parity", async () => {
    const root = scratch();
    try {
      initVault(root); enableMessages(root);
      const f = funding(root); const net = intercepted();
      const body = { grantTxid: "a".repeat(64), scopeHash: "b".repeat(64), doorGenesisTxid: "c".repeat(64) };
      const r = await sendAgentMessage({ root, to: RECIPIENT_ADDR, type: "osp.grant.receipt", body, encryptTo: RECIPIENT_PUB, nonce: NONCE, ts: TS, now: NOW, ...f, broadcast: net.broadcast });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const { v } = envelopeFromRaw(net.sent[0]);
      const senderPub = loadVault(root).key.toPublicKey().toString();
      expect(decryptMessageBody(RECIPIENT, v.envelope, senderPub).body).toEqual(body);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
