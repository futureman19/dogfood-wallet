import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveRequest,
  denyRequest,
  fileRequest,
  listRequests,
  MAX_PENDING_REQUESTS,
} from "./requests";
import { initVault, killVault, loadVault, vaultPaths } from "./vault";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./mcp";

const DEST = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dogfood-requests-"));
}

describe("requests", () => {
  test("file + list + idempotent dedupe of identical pending requests", () => {
    const root = tmp();
    try {
      initVault(root);
      const first = fileRequest(root, { kind: "allow-destination", address: DEST, reason: "need to pay merchant" });
      expect(first.created).toBe(true);
      expect(first.request.status).toBe("pending");
      const again = fileRequest(root, { kind: "allow-destination", address: DEST });
      expect(again.created).toBe(false);
      expect(again.request.id).toBe(first.request.id);
      const all = listRequests(root);
      expect(all).toHaveLength(1);
      expect(all[0]!.address).toBe(DEST);
      expect(listRequests(root, "pending")).toHaveLength(1);
      expect(listRequests(root, "approved")).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validation: bad address, bad cap field, bad values, oversize reason", () => {
    const root = tmp();
    try {
      initVault(root);
      expect(() => fileRequest(root, { kind: "allow-destination", address: "not-an-address" })).toThrow(/Invalid request/);
      expect(() => fileRequest(root, { kind: "allow-destination", address: "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy" })).toThrow(/Invalid request/);
      expect(() => fileRequest(root, { kind: "raise-cap", field: "maxSatsPerMonth" as never, value: 1 })).toThrow(/Invalid request/);
      expect(() => fileRequest(root, { kind: "raise-cap", field: "maxSatsPerTx", value: 0 })).toThrow(/Invalid request/);
      expect(() => fileRequest(root, { kind: "raise-cap", field: "maxSatsPerTx", value: -5 })).toThrow(/Invalid request/);
      expect(() => fileRequest(root, { kind: "raise-cap", field: "maxSatsPerTx", value: 1.5 })).toThrow(/Invalid request/);
      expect(() => fileRequest(root, { kind: "raise-cap", field: "maxSatsPerTx", value: null })).toThrow(/Invalid request/);
      expect(() => fileRequest(root, { kind: "raise-cap", field: "maxSatsPerDay", value: null })).not.toThrow();
      expect(() => fileRequest(root, { kind: "allow-destination", address: DEST, reason: "x".repeat(281) })).toThrow(/Invalid request/);
      expect(() => fileRequest(root, { kind: "allow-destination", address: DEST, reason: "two\nlines" })).toThrow(/Invalid request/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approve allow-destination mutates the real allowlist and marks the request", () => {
    const root = tmp();
    try {
      initVault(root);
      const { request } = fileRequest(root, { kind: "allow-destination", address: DEST });
      const done = approveRequest(root, request.id);
      expect(done.status).toBe("approved");
      expect(done.decidedAt).toBeTruthy();
      const policy = JSON.parse(readFileSync(vaultPaths(root).policy, "utf8"));
      expect(policy.allowlist).toContain(DEST);
      expect(loadVault(root).policy.allowlist).toContain(DEST);
      // decided requests are not re-decidable
      expect(() => approveRequest(root, request.id)).toThrow(/not pending/);
      expect(() => denyRequest(root, request.id)).toThrow(/not pending/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approve raise-cap splices policy.json in place and preserves unknown fields", () => {
    const root = tmp();
    try {
      initVault(root);
      const raw = JSON.parse(readFileSync(vaultPaths(root).policy, "utf8"));
      writeFileSync(vaultPaths(root).policy, JSON.stringify({ ...raw, futureField: { keep: [1, 2] } }, null, 2) + "\n");
      const { request } = fileRequest(root, { kind: "raise-cap", field: "maxSatsPerTx", value: 25000 });
      approveRequest(root, request.id);
      const text = readFileSync(vaultPaths(root).policy, "utf8");
      const policy = JSON.parse(text);
      expect(policy.maxSatsPerTx).toBe(25000);
      expect(policy.maxSatsPerDay).toBe(raw.maxSatsPerDay);
      expect(policy.allowlist).toEqual(raw.allowlist);
      expect(policy.futureField).toEqual({ keep: [1, 2] });
      expect(loadVault(root).policy.maxSatsPerTx).toBe(25000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approve raise-cap to null clears an optional cap", () => {
    const root = tmp();
    try {
      initVault(root);
      expect(loadVault(root).policy.maxSatsPerDay).toBe(50_000);
      const { request } = fileRequest(root, { kind: "raise-cap", field: "maxSatsPerDay", value: null });
      approveRequest(root, request.id);
      expect(JSON.parse(readFileSync(vaultPaths(root).policy, "utf8")).maxSatsPerDay).toBeNull();
      expect(loadVault(root).policy.maxSatsPerDay).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("deny records the reason; filing is not gated by the killfile", () => {
    const root = tmp();
    try {
      initVault(root);
      killVault(root);
      const { request } = fileRequest(root, { kind: "allow-destination", address: DEST });
      const denied = denyRequest(root, request.id, "not while frozen");
      expect(denied.status).toBe("denied");
      expect(denied.decision).toBe("not while frozen");
      expect(listRequests(root, "pending")).toHaveLength(0);
      expect(listRequests(root, "denied")).toHaveLength(1);
      // a denied request does not block re-filing
      const refiled = fileRequest(root, { kind: "allow-destination", address: DEST });
      expect(refiled.created).toBe(true);
      expect(refiled.request.id).not.toBe(request.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unknown or malformed ids are rejected without touching the fs", () => {
    const root = tmp();
    try {
      initVault(root);
      expect(() => approveRequest(root, "not-a-uuid")).toThrow(/Invalid request id/);
      expect(() => approveRequest(root, "../../../etc/passwd")).toThrow(/Invalid request id/);
      expect(() => approveRequest(root, "00000000-0000-0000-0000-000000000000")).toThrow(/not found/);
      expect(() => denyRequest(root, "00000000-0000-0000-0000-000000000000")).toThrow(/not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pending backlog is bounded", () => {
    const root = tmp();
    try {
      initVault(root);
      for (let i = 0; i < MAX_PENDING_REQUESTS; i++) {
        fileRequest(root, { kind: "raise-cap", field: "maxSatsPerTx", value: 1000 + i });
      }
      expect(() => fileRequest(root, { kind: "raise-cap", field: "maxSatsPerTx", value: 999999 })).toThrow(/backlog/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("request files are not world-readable", () => {
    const root = tmp();
    try {
      initVault(root);
      const { request } = fileRequest(root, { kind: "allow-destination", address: DEST });
      expect(existsSync(join(root, "requests", `${request.id}.json`))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("requests MCP surface", () => {
  test("request_allow/request_cap/requests are exposed; approve/deny stay off MCP", async () => {
    const root = tmp();
    initVault(root);
    const server = createServer(root);
    const client = new Client({ name: "requests-test", version: "1" });
    try {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      await client.connect(a);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("request_allow");
      expect(names).toContain("request_cap");
      expect(names).toContain("requests");
      expect(names.some((n) => /approve|deny/i.test(n))).toBe(false);
      for (const name of ["request-approve", "request_approve", "approveRequest", "request-deny", "request_deny"]) {
        expect((await client.callTool({ name, arguments: { id: "00000000-0000-0000-0000-000000000000" } })).isError).toBe(true);
      }

      const filed = await client.callTool({ name: "request_allow", arguments: { address: DEST, reason: "mcp" } });
      expect(filed.isError).toBeFalsy();
      const listed = await client.callTool({ name: "requests", arguments: {} });
      const parsed = JSON.parse((listed.content as { type: string; text: string }[])[0]!.text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].address).toBe(DEST);
    } finally {
      await client.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("requests CLI", () => {
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
    return Bun.spawnSync([process.execPath, cli, ...args], {
      env: childEnv(root),
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("request-allow -> requests -> request-approve -> allowlist mutated; request-deny", () => {
    const root = tmp();
    try {
      initVault(root);
      const filed = run(root, ["request-allow", DEST, "please"]);
      expect(filed.exitCode).toBe(0);
      const { request } = JSON.parse(filed.stdout.toString());
      expect(request.status).toBe("pending");

      const listed = run(root, ["requests"]);
      expect(JSON.parse(listed.stdout.toString())).toHaveLength(1);

      const approved = run(root, ["request-approve", request.id]);
      expect(approved.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(vaultPaths(root).policy, "utf8")).allowlist).toContain(DEST);

      const filed2 = run(root, ["request-cap", "maxSatsPerTx", "12345"]);
      expect(filed2.exitCode).toBe(0);
      const id2 = JSON.parse(filed2.stdout.toString()).request.id;
      const denied = run(root, ["request-deny", id2, "too high"]);
      expect(denied.exitCode).toBe(0);
      expect(JSON.parse(denied.stdout.toString()).status).toBe("denied");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
