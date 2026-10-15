import { expect, test } from "bun:test";
import { resolve } from "node:path";

async function call(rail: string, failure = "none") {
  const child = Bun.spawn([process.execPath, "src/test-support/mcp-x402.ts", rail, failure], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, DOGFOOD_WALLET_DIR: resolve(import.meta.dir, "test-support/nonexistent-vault"), DOGFOOD_ORIGIN_TOKEN: "fixture" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  return JSON.parse(stdout);
}

for (const [rail, challenges, asset] of [["bsv", 1, "bsv"], ["base", 2, "usdc-base"], ["solana", 3, "usdc-solana"]] as const) {
  test(`MCP x402_pay settles ${rail} and logs only its asset usage`, async () => {
    const r = await call(rail);
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ ok: true, body: "fixture paid" });
    expect(r.payments).toEqual([rail]);
    expect(r.events.filter((e: string) => e === "challenge")).toHaveLength(challenges);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ kind: "send", asset, amount: 500, to: r.body.payTo, resource: "https://fixture.invalid/fortune", txid: rail === "bsv" ? r.body.txid : r.body.txHash });
    expect(Object.keys(r.body).sort()).toEqual((rail === "bsv" ? ["ok", "txid", "amount", "payTo", "fee", "body"] : ["ok", "txHash", "amountUsdc", "payTo", "body"]).sort());
  });
  for (const [failure, code] of [["cap", "CAP"], ["day", "DAY"], ["allowlist", "ALLOWLIST"], ["kill", "KILL"], ["settle", "SETTLE_FAILED"]]) {
    test(`MCP ${rail} ${failure} fails closed without another rail or spend row`, async () => {
      const r = await call(rail, failure);
      expect(r.isError).toBe(true);
      expect(r.body).toMatchObject({ ok: false, code });
      expect(r.events.filter((e: string) => e === "challenge")).toHaveLength(challenges);
      expect(r.payments).toEqual(failure === "settle" ? [rail] : []);
      if (failure !== "settle") expect(r.events).toEqual(Array(challenges).fill("challenge"));
      expect(r.rows).toEqual([]);
    });
  }
}

test("MCP BSV funding refusal does not fall through to offered Base/Solana", async () => {
  const r = await call("bsv", "funding");
  expect(r.isError).toBe(true);
  expect(r.body).toMatchObject({ ok: false, code: "INSUFFICIENT" });
  expect(r.events).toEqual(["challenge", "utxos"]);
  expect(r.payments).toEqual([]);
  expect(r.rows).toEqual([]);
});

test("MCP BSV invalid BRC181 fails before funding instead of switching assets", async () => {
  const r = await call("bsv", "brc181");
  expect(r.isError).toBe(true);
  expect(r.body.ok).toBe(false);
  expect(r.body.code).toBe("BAD_SIG");
  expect(r.events).toEqual(["challenge"]);
  expect(r.payments).toEqual([]);
  expect(r.rows).toEqual([]);
});
