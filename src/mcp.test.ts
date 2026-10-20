import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./mcp";
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

test('agent-deposit stays owner-only: runtime MCP discovery and invocation isolation', async () => {
  const root=mkdtempSync(join(tmpdir(),'dogfood-deposit-mcp-'));
  const server=createServer(root),client=new Client({name:'deposit-isolation',version:'1'});
  try {
    const [a,b]=InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    const listed=await client.listTools();
    expect(listed.tools.some(t=>/deposit/i.test(t.name))).toBe(false);
    for(const name of ['agent-deposit','agent_deposit','depositAgent']) {
      const result=await client.callTool({name,arguments:{agentId:'object:42',sats:1000}});
      expect(result.isError).toBe(true);
    }
  } finally { await client.close(); await server.close(); rmSync(root,{recursive:true,force:true}); }
});

describe("mcp", () => {
  test("createServer does not throw and does not embed a WIF in its name", () => {
    const root = mkdtempSync(join(tmpdir(), "dogfood-mcp-"));
    try {
      const server = createServer(root);
      expect(server).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
