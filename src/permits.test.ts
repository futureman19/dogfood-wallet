import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P2PKH, Script, Transaction } from "@bsv/sdk";
import { fileRequest, approveRequest, denyRequest } from "./requests";
import { listPermits, revokePermit } from "./permits";
import { sendPayment } from "./send";
import { initVault, killVault, allowDestination, loadVault, vaultPaths } from "./vault";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./mcp";

const TO = "1GjcRUKdwqsnrxCHiDoHtF57rKqDd8oibT";
const OTHER = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dogfood-permits-"));
}

function source(script: Script, value: number): Transaction {
  const t = new Transaction();
  t.addInput({ sourceTXID: "00".repeat(32), sourceOutputIndex: 0xffffffff, unlockingScript: Script.fromASM("OP_0") });
  t.addOutput({ satoshis: value, lockingScript: script });
  return t;
}

/** Funded-send mocks: one 100k coin to the vault, broadcast echoes the real txid. */
function funded(root: string) {
  const vault = loadVault(root);
  const coin = source(new P2PKH().lock(vault.address), 100_000);
  return {
    fetchUtxos: async () => [{ tx_hash: coin.id("hex"), tx_pos: 0, value: 100_000 }],
    fetchTxHex: async () => coin.toHex(),
    broadcast: async (raw: string) => ({ txid: Transaction.fromHex(raw).id("hex") }),
  };
}

function approvePermit(root: string, to: string, amount: number, reason?: string) {
  const { request } = fileRequest(root, { kind: "permit-send", to, amount, reason });
  approveRequest(root, request.id);
  return request.id;
}

describe("permit-send requests", () => {
  test("file + approve creates an unspent permit; validation is strict", () => {
    const root = tmp();
    try {
      initVault(root);
      expect(() => fileRequest(root, { kind: "permit-send", to: "bad", amount: 1 })).toThrow(/Invalid request/);
      expect(() => fileRequest(root, { kind: "permit-send", to: "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", amount: 1 })).toThrow(/Invalid request/);
      expect(() => fileRequest(root, { kind: "permit-send", to: TO, amount: 0 })).toThrow(/Invalid request/);
      expect(() => fileRequest(root, { kind: "permit-send", to: TO, amount: -1 })).toThrow(/Invalid request/);
      expect(() => fileRequest(root, { kind: "permit-send", to: TO, amount: 1.5 })).toThrow(/Invalid request/);
      expect(() => fileRequest(root, { kind: "permit-send", to: TO, amount: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/Invalid request/);

      const { request, created } = fileRequest(root, { kind: "permit-send", to: TO, amount: 5000, reason: "pay the merchant" });
      expect(created).toBe(true);
      // identical pending ask dedupes
      expect(fileRequest(root, { kind: "permit-send", to: TO, amount: 5000 }).request.id).toBe(request.id);
      approveRequest(root, request.id);
      const permits = listPermits(root);
      expect(permits).toHaveLength(1);
      expect(permits[0]).toMatchObject({ id: request.id, to: TO, amount: 5000, status: "unspent", reason: "pay the merchant" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("denied permit-send issues no permit", () => {
    const root = tmp();
    try {
      initVault(root);
      const { request } = fileRequest(root, { kind: "permit-send", to: TO, amount: 5000 });
      denyRequest(root, request.id, "no");
      expect(listPermits(root)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sendPayment honors one-time permits", () => {
  test("permit waives the empty allowlist exactly once and stamps the txid", async () => {
    const root = tmp();
    try {
      initVault(root); // empty allowlist: every send denied
      const id = approvePermit(root, TO, 5000);
      const first = await sendPayment({ root, to: TO, amount: 5000, ...funded(root) });
      expect(first.ok).toBe(true);
      const spent = listPermits(root);
      expect(spent[0]!.status).toBe("spent");
      expect(spent[0]!.txid).toBe(first.ok ? first.txid : "");
      // the spend logged normally — accounting stays true
      const log = readFileSync(vaultPaths(root).log, "utf8");
      expect(log).toContain(`"amount":5000`);
      // second identical send: permit consumed, policy wall returns
      const second = await sendPayment({ root, to: TO, amount: 5000, ...funded(root) });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.code).toBe("ALLOWLIST");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("permit waives the per-tx cap", async () => {
    const root = tmp();
    try {
      initVault(root); // cap 10,000
      approvePermit(root, TO, 25_000);
      const result = await sendPayment({ root, to: TO, amount: 25_000, ...funded(root) });
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a normal policy-passing send does NOT consume the permit", async () => {
    const root = tmp();
    try {
      initVault(root);
      allowDestination(root, TO);
      approvePermit(root, TO, 5000);
      const result = await sendPayment({ root, to: TO, amount: 5000, ...funded(root) });
      expect(result.ok).toBe(true);
      expect(listPermits(root)[0]!.status).toBe("unspent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("killfile beats the permit and leaves it unspent", async () => {
    const root = tmp();
    try {
      initVault(root);
      approvePermit(root, TO, 5000);
      killVault(root);
      let fetched = false;
      const result = await sendPayment({
        root,
        to: TO,
        amount: 5000,
        fetchUtxos: async () => {
          fetched = true;
          return [];
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("KILL");
      expect(fetched).toBe(false);
      expect(listPermits(root)[0]!.status).toBe("unspent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pre-commitment failure releases the permit for retry", async () => {
    const root = tmp();
    try {
      initVault(root);
      approvePermit(root, TO, 5000);
      const broke = await sendPayment({
        root,
        to: TO,
        amount: 5000,
        fetchUtxos: async () => [], // INSUFFICIENT, before any commitment
      });
      expect(broke.ok).toBe(false);
      if (!broke.ok) expect(broke.code).toBe("INSUFFICIENT");
      expect(listPermits(root)[0]!.status).toBe("unspent");
      // retry once funded succeeds
      const retry = await sendPayment({ root, to: TO, amount: 5000, ...funded(root) });
      expect(retry.ok).toBe(true);
      expect(listPermits(root)[0]!.status).toBe("spent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exact match only: wrong amount or destination never touches the permit", async () => {
    const root = tmp();
    try {
      initVault(root);
      approvePermit(root, TO, 5000);
      for (const attempt of [
        { to: TO, amount: 5001 },
        { to: OTHER, amount: 5000 },
      ]) {
        const result = await sendPayment({ root, ...attempt, fetchUtxos: async () => [] });
        expect(result.ok).toBe(false);
        expect(listPermits(root)[0]!.status).toBe("unspent");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("revocation returns the send to the policy wall", async () => {
    const root = tmp();
    try {
      initVault(root);
      const id = approvePermit(root, TO, 5000);
      const revoked = revokePermit(root, id);
      expect(revoked.status).toBe("revoked");
      const result = await sendPayment({ root, to: TO, amount: 5000, ...funded(root) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("ALLOWLIST");
      expect(() => revokePermit(root, id)).toThrow(/not unspent/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two identical permits are consumed oldest-first", async () => {
    const root = tmp();
    try {
      initVault(root);
      const first = approvePermit(root, TO, 5000);
      const second = approvePermit(root, TO, 5000);
      await sendPayment({ root, to: TO, amount: 5000, ...funded(root) });
      const permits = listPermits(root);
      expect(permits.find((p) => p.id === first)!.status).toBe("spent");
      expect(permits.find((p) => p.id === second)!.status).toBe("unspent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("permit-send MCP + CLI surface", () => {
  test("MCP request_send files; no approve/revoke tools", async () => {
    const root = tmp();
    initVault(root);
    const server = createServer(root);
    const client = new Client({ name: "permit-test", version: "1" });
    try {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      await client.connect(a);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("request_send");
      expect(names.some((n) => /revoke/i.test(n))).toBe(false);
      const filed = await client.callTool({ name: "request_send", arguments: { to: TO, amount: 5000, reason: "mcp" } });
      expect(filed.isError).toBeFalsy();
      const payload = JSON.parse((filed.content as { type: string; text: string }[])[0]!.text);
      expect(payload.request.kind).toBe("permit-send");
    } finally {
      await client.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  const cli = new URL("./cli.ts", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");
  function childEnv(root: string) {
    return {
      PATH: process.env.PATH!,
      SystemRoot: process.env.SystemRoot!,
      TEMP: tmpdir(),
      TMP: tmpdir(),
      TMPDIR: tmpdir(),
      DOGFOOD_WALLET_DIR: root,
    };
  }
  function run(root: string, args: string[]) {
    return Bun.spawnSync([process.execPath, cli, ...args], { env: childEnv(root), stdout: "pipe", stderr: "pipe" });
  }

  test("CLI: request-send -> request-approve -> permits -> permit-revoke", () => {
    const root = tmp();
    try {
      initVault(root);
      const filed = run(root, ["request-send", TO, "5000", "one-off"]);
      expect(filed.exitCode).toBe(0);
      const { request } = JSON.parse(filed.stdout.toString());
      expect(request.kind).toBe("permit-send");
      expect(run(root, ["request-approve", request.id]).exitCode).toBe(0);
      const listed = JSON.parse(run(root, ["permits"]).stdout.toString());
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ to: TO, amount: 5000, status: "unspent" });
      const revoked = run(root, ["permit-revoke", request.id]);
      expect(revoked.exitCode).toBe(0);
      expect(JSON.parse(revoked.stdout.toString()).status).toBe("revoked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
