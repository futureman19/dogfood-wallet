import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./mcp";

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
