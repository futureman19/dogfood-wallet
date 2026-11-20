// agent-message-inbox-enc.test.ts — S7: the keyless inbox MARKS encrypted
// messages (encrypted:true, ciphertext body) and NEVER decrypts during scan.
// Injectable WoC; no vault key, no funds, no network.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P2PKH, PrivateKey, Script, Transaction, UnlockingScript } from "@bsv/sdk";
import { buildMessageScript, type Envelope } from "./agent-message";
import { encryptMessageBody } from "./agent-message-crypto";
import { scanInbox, verifyMessageTx } from "./agent-message-inbox";

const ONE = new PrivateKey(1);
const TWO = new PrivateKey(2);
const ADDR_ONE = ONE.toAddress().toString();
const ADDR_TWO = TWO.toAddress().toString();
const NONCE = "000102030405060708090a0b0c0d0e0f";
const TS = 1763000000;
const NOW = 1763100000;
const noSleep = async () => {};

function unsignedTx(outputs: { satoshis: number; lockingScript: Script }[]): Transaction {
  const tx = new Transaction();
  tx.addInput({ sourceTXID: "ab".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  for (const o of outputs) tx.addOutput(o);
  return tx;
}
/** Encrypted message tx: 546-sat tip to recipient + enc=brc78 OP_RETURN + change. */
function encMessageTx(plaintext: string, type = "message"): { tx: Transaction; ciphertextB64: string } {
  const enc = encryptMessageBody(ONE, TWO.toPublicKey().toString(), plaintext);
  const env: Envelope = { v: 1, app: "dogfood", type, from: ADDR_ONE, to: ADDR_TWO, nonce: NONCE, ts: TS, enc: "brc78", body: enc.ciphertextB64 };
  const tx = unsignedTx([
    { satoshis: 546, lockingScript: new P2PKH().lock(ADDR_TWO) },
    { satoshis: 0, lockingScript: Script.fromHex(buildMessageScript(ONE, env)) },
    { satoshis: 1000, lockingScript: new P2PKH().lock(ADDR_ONE) },
  ]);
  return { tx, ciphertextB64: enc.ciphertextB64 };
}
function plainMessageTx(plaintext: string): Transaction {
  const env: Envelope = { v: 1, app: "dogfood", type: "message", from: ADDR_ONE, to: ADDR_TWO, nonce: NONCE, ts: TS, body: plaintext };
  return unsignedTx([
    { satoshis: 546, lockingScript: new P2PKH().lock(ADDR_TWO) },
    { satoshis: 0, lockingScript: Script.fromHex(buildMessageScript(ONE, env)) },
    { satoshis: 1000, lockingScript: new P2PKH().lock(ADDR_ONE) },
  ]);
}
function wocStub(txs: Transaction[], history: Record<string, { confirmed: { tx_hash: string; height: number }[]; unconfirmed: string[] }>) {
  const hexes = new Map(txs.map(t => [t.id("hex"), t.toHex()]));
  const fetchFn = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    const hexMatch = u.pathname.match(/\/tx\/([a-f0-9]{64})\/hex$/);
    if (hexMatch) { const hex = hexes.get(hexMatch[1]!); return hex ? new Response(hex) : new Response("not found", { status: 404 }); }
    const addrMatch = u.pathname.match(/\/address\/([^/]+)\/(confirmed|unconfirmed)\/history$/);
    if (addrMatch) {
      const table = history[addrMatch[1]!] ?? { confirmed: [], unconfirmed: [] };
      if (addrMatch[2] === "unconfirmed") return new Response(JSON.stringify({ result: table.unconfirmed.map(tx_hash => ({ tx_hash })), error: "" }));
      const minHeight = Number(u.searchParams.get("height") ?? "0");
      const rows = table.confirmed.filter(r => r.height >= minHeight).sort((a, b) => a.height - b.height);
      return new Response(JSON.stringify({ result: rows, error: "" }));
    }
    return new Response("unexpected url", { status: 404 });
  }) as typeof fetch;
  return { fetchFn };
}
function rootWithAddress(addr: string): string {
  const root = mkdtempSync(join(tmpdir(), "dogfood-inbox-enc-"));
  writeFileSync(join(root, "address.txt"), `${addr}\n`);
  return root;
}

describe("S7 inbox: keyless encrypted marking", () => {
  test("verifyMessageTx marks an encrypted message without decrypting", async () => {
    const { tx, ciphertextB64 } = encMessageTx("secret terms");
    const { fetchFn } = wocStub([tx], {});
    const r = await verifyMessageTx(tx.id("hex"), { fetchFn });
    expect(r.message).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.encrypted).toBe(true);
    expect(r.body).toBe(ciphertextB64);
    expect(r.body).not.toBe("secret terms");
    expect(r.to).toBe(ADDR_TWO);
    expect(r.untrusted).toBe(true);
  });

  test("verifyMessageTx marks a plaintext message encrypted:false", async () => {
    const tx = plainMessageTx("hello");
    const { fetchFn } = wocStub([tx], {});
    const r = await verifyMessageTx(tx.id("hex"), { fetchFn });
    expect(r.message).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.encrypted).toBe(false);
    expect(r.body).toBe("hello");
  });

  test("scanInbox surfaces an encrypted entry as ciphertext, never plaintext", async () => {
    const { tx, ciphertextB64 } = encMessageTx("topsecret");
    const root = rootWithAddress(ADDR_TWO);
    try {
      const { fetchFn } = wocStub([tx], { [ADDR_TWO]: { confirmed: [{ tx_hash: tx.id("hex"), height: 800000 }], unconfirmed: [] } });
      const r = await scanInbox({ root, fetchFn, sleep: noSleep, now: NOW });
      expect(r.newCount).toBe(1);
      const entry = r.entries[0]!;
      expect(entry.encrypted).toBe(true);
      expect(entry.body).toBe(ciphertextB64);
      expect(entry.body).not.toBe("topsecret");
      expect(entry.verified).toBe(true);
      expect(entry.untrusted).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("scanInbox marks a plaintext entry encrypted:false", async () => {
    const tx = plainMessageTx("hello");
    const root = rootWithAddress(ADDR_TWO);
    try {
      const { fetchFn } = wocStub([tx], { [ADDR_TWO]: { confirmed: [{ tx_hash: tx.id("hex"), height: 800000 }], unconfirmed: [] } });
      const r = await scanInbox({ root, fetchFn, sleep: noSleep, now: NOW });
      expect(r.entries[0]!.encrypted).toBe(false);
      expect(r.entries[0]!.body).toBe("hello");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
