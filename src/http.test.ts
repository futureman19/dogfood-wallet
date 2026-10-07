import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "./vault";
import { assertSafeBind, listenHttp } from "./http";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "dogfood-http-"));
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

async function mcpPost(url: string, body: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...extra },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const raw = dataLine ? dataLine.slice(6) : text;
  try {
    json = JSON.parse(raw);
  } catch {
    json = text;
  }
  return { status: res.status, json, text };
}

describe("assertSafeBind", () => {
  test("allows loopback without a token", () => {
    expect(() => assertSafeBind("127.0.0.1", undefined)).not.toThrow();
  });

  test("refuses a public bind without a token", () => {
    expect(() => assertSafeBind("0.0.0.0", undefined)).toThrow(/DOGFOOD_MCP_TOKEN/);
  });

  test("allows a public bind when a token is set", () => {
    expect(() => assertSafeBind("0.0.0.0", "secret-token")).not.toThrow();
  });
});

describe("listenHttp", () => {
  test("health is ok and /mcp tools/list has no allow or sweep", async () => {
    const root = scratch();
    let close: (() => Promise<void>) | undefined;
    try {
      initVault(root);
      const { url, close: c } = await listenHttp({ root, host: "127.0.0.1", port: 0 });
      close = c;
      const health = await fetch(`${url}/health`);
      expect(health.status).toBe(200);
      const h = (await health.json()) as { ok: boolean; tools?: string[] };
      expect(h.ok).toBe(true);

      const init = await mcpPost(`${url}/mcp`, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "dogfood-test", version: "0" },
        },
      });
      expect(init.status).toBe(200);

      const listed = await mcpPost(`${url}/mcp`, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      const names =
        (listed.json as { result?: { tools?: Array<{ name: string }> } }).result?.tools?.map((t) => t.name) ??
        [];
      expect(names.sort()).toEqual(
        ["address", "balance", "kill", "send", "status", "x402_inspect", "x402_proof"].sort(),
      );
      expect(names).not.toContain("allow");
      expect(names).not.toContain("sweep");
      expect(JSON.stringify(listed.json)).not.toMatch(/\b5[HJK][1-9A-HJ-NP-Za-km-z]{50,52}\b/);
    } finally {
      await close?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-loopback with token rejects /mcp without Authorization", async () => {
    const root = scratch();
    let close: (() => Promise<void>) | undefined;
    try {
      initVault(root);
      const { url, close: c } = await listenHttp({
        root,
        host: "127.0.0.1",
        port: 0,
        token: "sekrit",
      });
      close = c;
      const denied = await mcpPost(`${url}/mcp`, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "dogfood-test", version: "0" },
        },
      });
      expect(denied.status).toBe(401);

      const ok = await mcpPost(
        `${url}/mcp`,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "dogfood-test", version: "0" },
          },
        },
        { authorization: "Bearer sekrit" },
      );
      expect(ok.status).toBe(200);
    } finally {
      await close?.();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
