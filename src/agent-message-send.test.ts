import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Transaction, P2PKH } from "@bsv/sdk";
import { initVault, killVault, loadVault, vaultPaths } from "./vault";
import { sendAgentMessage } from "./agent-message-send";
import { buildMessageScript, verifyMessageScript } from "./agent-message";
import { inspectPaymentHold } from "./payment-guard";
import { markInboxTip } from "./inbox-tips";
import { usageFromLog } from "./policy";
import { canonicalDest } from "./brc181";
import { makePayload, signEnvelope as signBrc181 } from "./test-support/brc181";
import { createServer } from "./mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "dogfood-msg-send-"));
}

const TO = "1GjcRUKdwqsnrxCHiDoHtF57rKqDd8oibT";
const OTHER = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const NONCE = "000102030405060708090a0b0c0d0e0f";
const TS = 1763000000;
const NOW = () => TS * 1000;
const TXID = "ef".repeat(32);
const COIN = { tx_hash: "ab".repeat(32), tx_pos: 0, value: 100_000 };

function enableMessages(root: string, block: Record<string, unknown> = {}): void {
  const path = vaultPaths(root).policy;
  const policy = JSON.parse(readFileSync(path, "utf8"));
  policy.messages = block;
  writeFileSync(path, JSON.stringify(policy, null, 2));
}

function seedLog(root: string, rows: Array<Record<string, unknown>>): void {
  writeFileSync(vaultPaths(root).log, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function intercepted() {
  const sent: string[] = [];
  return {
    sent,
    broadcast: async (rawTx: string) => {
      sent.push(rawTx);
      return { txid: Transaction.fromHex(rawTx).id("hex") };
    },
  };
}

/** Synthetic funded source tx owned by the vault, with injectable transport.
 *  The coin's tx_hash is the REAL id of the source tx so source verification
 *  (id/value/script binding) passes without network access. */
function funding(root: string, value = 100_000) {
  const v = loadVault(root);
  const src = new Transaction();
  src.addOutput({ satoshis: value, lockingScript: new P2PKH().lock(v.address) });
  const hex = src.toHex();
  const coin = { tx_hash: src.id("hex"), tx_pos: 0, value };
  return { coin, fetchUtxos: async () => [coin], fetchTxHex: async () => hex };
}

describe("sendAgentMessage policy gate (no fetch before rejection)", () => {
  test("absent policy.messages disables the rail", async () => {
    const root = scratch();
    try {
      initVault(root);
      let fetched = false;
      const r = await sendAgentMessage({ root, to: TO, body: "hi", fetchUtxos: async () => { fetched = true; return []; } });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("DISABLED");
      expect(fetched).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("killfile rejects before fetch", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      killVault(root);
      let fetched = false;
      const r = await sendAgentMessage({ root, to: TO, body: "hi", fetchUtxos: async () => { fetched = true; return []; } });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("KILL");
      expect(fetched).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("empty recipients allowlist rejects before fetch", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root, { recipients: [] });
      let fetched = false;
      const r = await sendAgentMessage({ root, to: TO, body: "hi", fetchUtxos: async () => { fetched = true; return []; } });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("ALLOWLIST");
      expect(fetched).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("recipient outside the allowlist rejects before fetch", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root, { recipients: [OTHER] });
      const r = await sendAgentMessage({ root, to: TO, body: "hi", fetchUtxos: async () => [] });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("ALLOWLIST");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("body over the policy byte cap rejects before fetch", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root, { maxBodyBytes: 10 });
      let fetched = false;
      const r = await sendAgentMessage({ root, to: TO, body: "x".repeat(11), fetchUtxos: async () => { fetched = true; return []; } });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("CAP");
      expect(fetched).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("daily count cap rejects before fetch", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root, { maxPerDay: 2 });
      seedLog(root, [0, 1].map(() => ({ kind: "agent-message", t: new Date(TS * 1000).toISOString(), amount: 1, fee: 300, to: TO, txid: TXID })));
      let fetched = false;
      const r = await sendAgentMessage({ root, to: TO, body: "hi", now: NOW, fetchUtxos: async () => { fetched = true; return []; } });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("DAY");
      expect(fetched).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("non-mainnet recipient rejects before fetch", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      const r = await sendAgentMessage({ root, to: "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", body: "hi", fetchUtxos: async () => [] });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("BAD_ADDRESS");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("type gate: unknown types BAD_TYPE; S4 typed types pass the gate but demand valid bodies", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      const unknown = await sendAgentMessage({ root, to: TO, body: "hi", type: "osp.grant.bogus", fetchUtxos: async () => [] });
      expect(unknown.ok).toBe(false);
      if (unknown.ok) return;
      expect(unknown.code).toBe("BAD_TYPE");
      // S4: osp.grant.request is an allowed type now — a plain-text body is
      // BAD_BODY (filing parity), not BAD_TYPE, and still no fetch.
      let fetched = false;
      const typed = await sendAgentMessage({ root, to: TO, body: "hi", type: "osp.grant.request", fetchUtxos: async () => { fetched = true; return []; } });
      expect(typed.ok).toBe(false);
      if (typed.ok) return;
      expect(typed.code).toBe("BAD_BODY");
      expect(fetched).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("codec-invalid body rejects before fetch", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      let fetched = false;
      const r = await sendAgentMessage({ root, to: TO, body: "bad\x00body", fetchUtxos: async () => { fetched = true; return []; } });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("BAD_ENVELOPE");
      expect(fetched).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("malformed brc181.json rejects before fetch", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      writeFileSync(vaultPaths(root).brc181, "{corrupt");
      const r = await sendAgentMessage({ root, to: TO, body: "hi", fetchUtxos: async () => [] });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("BAD_SIG");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("BRC-181 destination gate rejects before fetch", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      const otherDest = canonicalDest(new P2PKH().lock(OTHER).toHex())!;
      writeFileSync(vaultPaths(root).brc181, JSON.stringify(signBrc181(makePayload({ dest_allowlist: [otherDest] }))));
      let fetched = false;
      const r = await sendAgentMessage({ root, to: TO, body: "hi", fetchUtxos: async () => { fetched = true; return []; } });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("POLICY");
      expect(fetched).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("malformed inbox-tip store fails closed before fetch", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      writeFileSync(vaultPaths(root).inboxTips, "{corrupt");
      let fetched = false;
      const r = await sendAgentMessage({ root, to: TO, body: "hi", fetchUtxos: async () => { fetched = true; return []; } });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("INBOX_TIPS");
      expect(fetched).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("sendAgentMessage funding and tx shape (intercepted transport)", () => {
  test("INSUFFICIENT when coins cannot cover tip plus fee", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      const r = await sendAgentMessage({ root, to: TO, body: "hi", nonce: NONCE, ts: TS, fetchUtxos: async () => [{ ...COIN, value: 10 }] });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("INSUFFICIENT");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("marked inbox tips are excluded from funding", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      markInboxTip(root, `${COIN.tx_hash}.${COIN.tx_pos}`);
      const r = await sendAgentMessage({ root, to: TO, body: "hi", nonce: NONCE, ts: TS, fetchUtxos: async () => [COIN] });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("INSUFFICIENT");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("BRC-181 fee gate rejects after funding but before any hold", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      writeFileSync(vaultPaths(root).brc181, JSON.stringify(signBrc181(makePayload({ max_fee: 1 }))));
      const cap = intercepted();
      const r = await sendAgentMessage({ root, to: TO, body: "hi", nonce: NONCE, ts: TS, fetchUtxos: async () => [COIN], broadcast: cap.broadcast });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("POLICY");
      expect(cap.sent.length).toBe(0);
      expect(existsSync(join(root, "payment.pending.json"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("happy path: 1-sat tip, verified OP_RETURN, change, log, evidence, hold cleared", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      const v = loadVault(root);
      const f = funding(root);
      const cap = intercepted();
      const r = await sendAgentMessage({ root, to: TO, body: "handoff: build the inbox", nonce: NONCE, ts: TS, now: NOW, fetchUtxos: f.fetchUtxos, fetchTxHex: f.fetchTxHex, broadcast: cap.broadcast });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const expectedTxid = Transaction.fromHex(cap.sent[0]!).id("hex");
      expect(r.txid).toBe(expectedTxid);
      expect(r.tip).toBe(1);
      expect(r.nonce).toBe(NONCE);
      expect(cap.sent.length).toBe(1);

      const tx = Transaction.fromHex(cap.sent[0]!);
      expect(tx.inputs.length).toBe(1);
      expect(tx.outputs.length).toBe(3);
      // out0: 1-sat P2PKH tip to the recipient inbox
      expect(tx.outputs[0]!.satoshis).toBe(1);
      expect(tx.outputs[0]!.lockingScript.toHex()).toBe(new P2PKH().lock(TO).toHex());
      // out1: 0-sat OP_RETURN B|MAP|AIP message, AIP signer = vault
      expect(tx.outputs[1]!.satoshis).toBe(0);
      const scriptHex = tx.outputs[1]!.lockingScript.toHex();
      expect(scriptHex.startsWith("6a")).toBe(true);
      const verified = verifyMessageScript(scriptHex);
      expect(verified.aipAddress).toBe(v.address);
      expect(verified.envelope.from).toBe(v.address);
      expect(verified.envelope.to).toBe(TO);
      expect(verified.envelope.type).toBe("message");
      expect(verified.envelope.body).toBe("handoff: build the inbox");
      expect(verified.envelope.nonce).toBe(NONCE);
      expect(verified.envelope.ts).toBe(TS);
      // out2: change back to the vault
      const change = tx.outputs[2]!.satoshis!;
      expect(change).toBeGreaterThan(1);
      expect(tx.outputs[2]!.lockingScript.toHex()).toBe(new P2PKH().lock(v.address).toHex());
      // fee accounting: everything leaving the vault is tip + fee
      expect(r.fee).toBe(COIN.value - 1 - change);
      expect(cap.sent[0]!.length / 2).toBeLessThanOrEqual(r.fee); // >= 1 sat/byte

      // durable usage row feeds the messages scope fee-inclusive
      const lines = readFileSync(vaultPaths(root).log, "utf8").split(/\r?\n/);
      const u = usageFromLog(lines, new Date(TS * 1000), "messages");
      expect(u.spentToday).toBe(1 + r.fee);
      const row = JSON.parse(lines.find((l) => l.includes("agent-message"))!);
      expect(row.kind).toBe("agent-message");
      expect(row.amount).toBe(1);
      expect(row.to).toBe(TO);
      expect(row.txid).toBe(expectedTxid);

      // fsynced evidence survives as a broadcast record
      const evidence = JSON.parse(readFileSync(r.evidence, "utf8"));
      expect(evidence.status).toBe("broadcast");
      expect(evidence.guardId).toBe(r.guardId);
      expect(evidence.rawTx).toBe(cap.sent[0]);
      expect(evidence.envelope.body).toBe("handoff: build the inbox");

      // hold fully cleared
      expect(existsSync(join(root, "payment.pending.json"))).toBe(false);
      expect(existsSync(join(root, "payment.lock"))).toBe(false);
      expect(inspectPaymentHold(root).blocked).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("dust change folds into the fee (two outputs)", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      const v = loadVault(root);
      const env = { v: 1, app: "dogfood", type: "message", from: v.address, to: TO, nonce: NONCE, ts: TS, body: "hi" };
      const scriptBytes = buildMessageScript(v.key, env).length / 2;
      const plannedFee = 10 + 148 + 68 + scriptBytes + 8; // one input, fee model pinned
      const f = funding(root, plannedFee + 2); // change would be 1 sat -> folded
      const cap = intercepted();
      const r = await sendAgentMessage({ root, to: TO, body: "hi", nonce: NONCE, ts: TS, now: NOW, fetchUtxos: f.fetchUtxos, fetchTxHex: f.fetchTxHex, broadcast: cap.broadcast });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const tx = Transaction.fromHex(cap.sent[0]!);
      expect(tx.outputs.length).toBe(2);
      expect(r.fee).toBe(f.coin.value - 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("deterministic bytes: same key/inputs/nonce/ts produce identical rawTx", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      const f = funding(root);
      const cap = intercepted();
      const args = { root, to: TO, body: "determinism", nonce: NONCE, ts: TS, now: NOW, fetchUtxos: f.fetchUtxos, fetchTxHex: f.fetchTxHex, broadcast: cap.broadcast };
      const a = await sendAgentMessage(args);
      const b = await sendAgentMessage(args);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(cap.sent.length).toBe(2);
      expect(cap.sent[0]).toBe(cap.sent[1]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("4 KB body: fee covers the full script size and the message verifies", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      const body = "x".repeat(4096);
      const f = funding(root);
      const cap = intercepted();
      const r = await sendAgentMessage({ root, to: TO, body, nonce: NONCE, ts: TS, now: NOW, fetchUtxos: f.fetchUtxos, fetchTxHex: f.fetchTxHex, broadcast: cap.broadcast });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const tx = Transaction.fromHex(cap.sent[0]!);
      expect(cap.sent[0]!.length / 2).toBeLessThanOrEqual(r.fee);
      const verified = verifyMessageScript(tx.outputs[1]!.lockingScript.toHex());
      expect(verified.envelope.body).toBe(body);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("defaults: random 32-hex nonce and current ts", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      const f = funding(root);
      const cap = intercepted();
      const r = await sendAgentMessage({ root, to: TO, body: "hi", fetchUtxos: f.fetchUtxos, fetchTxHex: f.fetchTxHex, broadcast: cap.broadcast });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.nonce).toMatch(/^[0-9a-f]{32}$/);
      const tx = Transaction.fromHex(cap.sent[0]!);
      const env = verifyMessageScript(tx.outputs[1]!.lockingScript.toHex()).envelope;
      expect(env.nonce).toBe(r.nonce);
      expect(Math.abs(Number(env.ts) - Math.floor(Date.now() / 1000))).toBeLessThan(120);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("sendAgentMessage failure discipline", () => {
  test("broadcast failure retains the hold and signed evidence; never retries", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      const f = funding(root);
      let calls = 0;
      await expect(sendAgentMessage({
        root, to: TO, body: "hi", nonce: NONCE, ts: TS, now: NOW,
        fetchUtxos: f.fetchUtxos, fetchTxHex: f.fetchTxHex,
        broadcast: async () => { calls++; throw new Error("ARC unreachable"); },
      })).rejects.toThrow();
      expect(calls).toBe(1);
      const hold = inspectPaymentHold(root);
      expect(hold.blocked).toBe(true);
      expect(hold.pending).toBe("valid");
      expect(hold.intent?.amount).toBe(1);
      const dir = vaultPaths(root).messages;
      const files = require("node:fs").readdirSync(dir) as string[];
      expect(files.length).toBe(1);
      const evidence = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
      expect(evidence.status).toBe("signed");
      expect(evidence.rawTx.length).toBeGreaterThan(0);
      expect(existsSync(vaultPaths(root).log)).toBe(false);
      // a second attempt is blocked by the hold, not silently retried
      const r = await sendAgentMessage({ root, to: TO, body: "again", fetchUtxos: f.fetchUtxos, fetchTxHex: f.fetchTxHex });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("PAYMENT_HELD");
      expect(calls).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("killfile flipped after policy evaluation stops the broadcast and retains the hold", async () => {
    const root = scratch();
    try {
      initVault(root);
      enableMessages(root);
      const f = funding(root);
      const cap = intercepted();
      await expect(sendAgentMessage({
        root, to: TO, body: "hi", nonce: NONCE, ts: TS, now: NOW,
        fetchUtxos: async () => { killVault(root); return [f.coin]; },
        fetchTxHex: f.fetchTxHex,
        broadcast: cap.broadcast,
      })).rejects.toThrow(/killfile/i);
      expect(cap.sent.length).toBe(0);
      expect(inspectPaymentHold(root).blocked).toBe(true);
      const dir = vaultPaths(root).messages;
      const files = require("node:fs").readdirSync(dir) as string[];
      const evidence = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
      expect(evidence.status).toBe("signed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("agent_message MCP boundary", () => {
  test("tool is registered and rejects a disabled vault with structured error", async () => {
    const root = scratch();
    const server = createServer(root);
    const client = new Client({ name: "msg-test", version: "1" });
    try {
      initVault(root);
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      await client.connect(a);
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("agent_message");
      const res = await client.callTool({ name: "agent_message", arguments: { to: TO, body: "hello" } });
      expect(res.isError).toBe(true);
      const parsed = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe("DISABLED");
    } finally {
      await client.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // S4: typed bodies ride the same tool. Validation parity runs BEFORE the
  // policy gate, so a disabled vault still surfaces BAD_BODY/BAD_TYPE for
  // malformed typed input — and never reaches the network.
  const TYPED_REQ = JSON.stringify({
    scope: '{"allow":["read:users"],"rate":"60/min","salt":"00112233445566778899aabbccddeeff"}',
    doorGenesisTxid: "ab".repeat(32),
    doorOwnerAddress: TO,
    reason: "need read access",
    sessionPubHex: "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
  });

  async function callAgentMessage(root: string, args: Record<string, unknown>) {
    const server = createServer(root);
    const client = new Client({ name: "msg-typed-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      const res = await client.callTool({ name: "agent_message", arguments: args });
      return JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    } finally {
      await client.close();
      await server.close();
    }
  }

  test("S4: invalid typed body rejects BAD_BODY before the policy gate", async () => {
    const root = scratch();
    try {
      initVault(root); // messages policy absent = disabled
      const parsed = await callAgentMessage(root, { to: TO, body: JSON.stringify({ scope: "" }), type: "osp.grant.request" });
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe("BAD_BODY");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("S4: unknown type rejects BAD_TYPE before the policy gate", async () => {
    const root = scratch();
    try {
      initVault(root);
      const parsed = await callAgentMessage(root, { to: TO, body: "hello", type: "osp.grant.bogus" });
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe("BAD_TYPE");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("S4: valid typed body on a disabled vault still DISABLED (validation precedes policy)", async () => {
    const root = scratch();
    try {
      initVault(root);
      const parsed = await callAgentMessage(root, { to: TO, body: TYPED_REQ, type: "osp.grant.request" });
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe("DISABLED");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("agent-message CLI boundary", () => {
  test("disabled vault exits 1 with a REJECTED message", async () => {
    const root = scratch();
    try {
      initVault(root);
      const child = Bun.spawn([process.execPath, "src/cli.ts", "agent-message", TO, "hello"], {
        cwd: resolve(import.meta.dir, ".."),
        env: { ...process.env, DOGFOOD_WALLET_DIR: root },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("REJECTED");
      expect(stderr.toLowerCase()).toContain("disabled");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("--json prints the structured rejection on stdout", async () => {
    const root = scratch();
    try {
      initVault(root);
      const child = Bun.spawn([process.execPath, "src/cli.ts", "agent-message", TO, "hello", "--json"], {
        cwd: resolve(import.meta.dir, ".."),
        env: { ...process.env, DOGFOOD_WALLET_DIR: root },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe("DISABLED");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("missing arguments print usage and exit 1", async () => {
    const root = scratch();
    try {
      initVault(root);
      const child = Bun.spawn([process.execPath, "src/cli.ts", "agent-message"], {
        cwd: resolve(import.meta.dir, ".."),
        env: { ...process.env, DOGFOOD_WALLET_DIR: root },
        stdout: "pipe", stderr: "pipe",
      });
      const [, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit).toBe(1);
      expect(stderr).toContain("Usage");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("S4: --type osp.grant.request with a bad body exits 1 BAD_BODY before the policy gate", async () => {
    const root = scratch();
    try {
      initVault(root); // disabled vault: typed validation must still win
      const child = Bun.spawn([process.execPath, "src/cli.ts", "agent-message", TO, '{"scope":""}', "--type", "osp.grant.request", "--json"], {
        cwd: resolve(import.meta.dir, ".."),
        env: { ...process.env, DOGFOOD_WALLET_DIR: root },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe("BAD_BODY");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});