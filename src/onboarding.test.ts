import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Actual CLI processes, absolute paths, unrelated cwd, unfunded generated vaults.
// No payment/balance tools are called. Only loopback HTTP is used.
test("newcomer CLI and both MCP transports select the same isolated vault", async () => {
  const root = mkdtempSync(join(tmpdir(), "dogfood-onboarding-"));
  const cli = resolve(import.meta.dir, "cli.ts");
  const env = { ...process.env, DOGFOOD_WALLET_DIR: root, DOGFOOD_MCP_HOST: "127.0.0.1", DOGFOOD_MCP_PORT: "0", DOGFOOD_MCP_TOKEN: "" } as Record<string, string>;
  const run = (...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, cli, ...args], { cwd: tmpdir(), env });
    expect(p.exitCode).toBe(0);
    return p.stdout.toString().trim();
  };
  const names = ["address", "balance", "kill", "send", "status", "x402_inspect", "x402_proof", "x402_delegate", "x402_pay"].sort();
  const clients: Client[] = [];
  let http: ReturnType<typeof Bun.spawn> | undefined;
  try {
    expect(JSON.parse(run("doctor")).vault).toBe("missing");
    expect(run("init")).toContain("Allowlist is empty");
    const address = run("address");
    expect(run("status")).toContain("Allowlist: (empty)");
    run("allow", address); // self address is an unfunded fixture, not a recommended merchant
    expect(JSON.parse(run("doctor")).policy.destinations).toBe(1);
    const stdio = new Client({ name: "onboarding-stdio", version: "1" });
    clients.push(stdio);
    await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, cwd: tmpdir() }));
    expect((await stdio.listTools()).tools.map(t => t.name).sort()).toEqual(names);
    expect(JSON.stringify(await stdio.callTool({ name: "address", arguments: {} }))).toContain(address);
    http = Bun.spawn([process.execPath, cli, "mcp-http"], { cwd: tmpdir(), env, stdout: "pipe", stderr: "pipe" });
    const reader = (http.stderr as ReadableStream<Uint8Array>).getReader();
    let banner = "";
    while (!banner.includes("/health)")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("HTTP CLI exited before readiness");
      banner += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const url = banner.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    expect((await (await fetch(`${url}/health`)).json()).ok).toBe(true);
    const remote = new Client({ name: "onboarding-http", version: "1" });
    clients.push(remote);
    await remote.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    expect((await remote.listTools()).tools.map(t => t.name).sort()).toEqual(names);
    expect(JSON.stringify(await remote.callTool({ name: "address", arguments: {} }))).toContain(address);
    run("kill");
    expect(JSON.parse(run("doctor")).kill).toBe("present");
    expect(JSON.stringify(await stdio.callTool({ name: "status", arguments: {} }))).toContain('\\"killfile\\": true');
    writeFileSync(join(root, "payment.lock"), "fixture orphan lock; no payment occurred");
    expect(JSON.parse(run("payment-inspect"))).toEqual({ blocked: true, lock: "present", pending: "absent" });
    expect(JSON.parse(run("doctor")).hold.blocked).toBe(true);
  } finally {
    for (const client of clients) await client.close();
    if (http) { http.kill(); await http.exited; }
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
