import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./mcp";

export type HttpOpts = {
  root: string;
  host?: string;
  port?: number;
  token?: string;
};

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function assertSafeBind(host: string, token: string | undefined): void {
  if (!isLoopback(host) && !token) {
    throw new Error("REFUSED: non-loopback MCP bind requires DOGFOOD_MCP_TOKEN.");
  }
}

function unauthorized(res: http.ServerResponse) {
  res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
}

export async function listenHttp(opts: HttpOpts): Promise<{
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
}> {
  const host = opts.host ?? "127.0.0.1";
  const token = opts.token;
  assertSafeBind(host, token);

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "dogfood-wallet" }));
      return;
    }

    if (url.pathname === "/mcp") {
      if (token) {
        const got = String(req.headers.authorization ?? "");
        if (got !== `Bearer ${token}`) {
          unauthorized(res);
          return;
        }
      }
      if (req.method === "POST") {
        let body: unknown;
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }),
          );
          return;
        }
        const server = createServer(opts.root);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
        } catch (err) {
          console.error("MCP request error:", err instanceof Error ? err.message : String(err));
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32603, message: "Internal server error" },
                id: null,
              }),
            );
          }
        }
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        res.writeHead(405, { "content-type": "application/json", allow: "POST" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed in stateless mode." },
            id: null,
          }),
        );
        return;
      }
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port ?? 38402, host, () => resolve());
  });

  const addr = httpServer.address();
  if (!addr || typeof addr === "string") {
    httpServer.close();
    throw new Error("failed to bind MCP HTTP");
  }

  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${addr.port}`;
  return {
    url,
    host,
    port: addr.port,
    close: () =>
      new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export async function runHttp(root: string) {
  const host = process.env.DOGFOOD_MCP_HOST ?? "127.0.0.1";
  const port = Number(process.env.DOGFOOD_MCP_PORT ?? 38402);
  const token = process.env.DOGFOOD_MCP_TOKEN;
  const { url } = await listenHttp({ root, host, port, token });
  console.error(`dogfood-wallet MCP HTTP ${url}/mcp (health ${url}/health)`);
  if (!isLoopback(host)) console.error("Bind is not loopback. Bearer token required.");
}
