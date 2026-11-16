import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { encodeProofHeader, txidFromRawHex, type X402Proof } from "./x402";

// vectors[7] (invalid_proof_version, v:0) is the frozen v1 proof key-set oracle.
const oracle = (JSON.parse(readFileSync(join(import.meta.dir, "..", "testdata", "x402-vectors-v1.json"), "utf8"))
  .vectors as Array<{ name: string; proof?: X402Proof }>).find(v => v.name === "invalid_proof_version")!.proof!;

async function call() {
  const child = Bun.spawn([process.execPath, "src/test-support/mcp-x402-delegate.ts"], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, DOGFOOD_WALLET_DIR: resolve(import.meta.dir, "test-support/nonexistent-vault") },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  return JSON.parse(stdout);
}

test("MCP x402_delegate sponsor result is frozen v1: proof keys match vectors[7], header is the canonical proof, vault pays nothing", async () => {
  const r = await call();
  expect(r.isError).toBe(false);
  const body = JSON.parse(r.content[0].text);
  expect(body.ok).toBe(true);
  expect(body.broadcast).toBe(false);
  expect(body.vaultPaid).toBe(false);
  const p: X402Proof = body.proof;
  expect(Object.keys(p).sort()).toEqual(Object.keys(oracle).sort());
  expect(Object.keys(p.payment).sort()).toEqual(Object.keys(oracle.payment).sort());
  expect(Object.keys(p.request).sort()).toEqual(Object.keys(oracle.request).sort());
  expect(p.v).toBe(1);
  expect(p.scheme).toBe("bsv-tx-v1");
  expect(p.request.method).toBe("GET");
  expect(p.request.path).toBe("/v1/resource");
  expect(txidFromRawHex(Buffer.from(p.payment.rawtx_b64, "base64").toString("hex"))).toBe(p.payment.txid);
  expect(body.txid).toBe(p.payment.txid);
  expect(body.header).toBe(encodeProofHeader(p));
  expect(JSON.parse(Buffer.from(body.header, "base64url").toString("utf8"))).toEqual(p);
});
