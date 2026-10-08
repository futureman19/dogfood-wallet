import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const [scenario, rails, code] of [
  ["bsv", ["bsv"], 0],
  ["base", ["bsv", "base"], 0],
  ["solana", ["bsv", "base", "solana"], 0],
  ["cap", ["bsv"], 1],
  ["settle", ["bsv"], 1],
  ["base-cap", ["bsv", "base"], 1],
] as const) {
  test(`CLI x402-pay rail selection: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--preload", "./src/test-support/cli-rails.ts", "src/cli.ts", "x402-pay", "https://fixture.invalid/fortune"], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, DOGFOOD_WALLET_DIR: resolve(import.meta.dir, "test-support/nonexistent-vault"), RAIL_SCENARIO: scenario },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stdout.split(/\r?\n/).filter(l => l.startsWith("RAIL:")).map(l => l.slice(5))).toEqual([...rails]);
    expect(exit).toBe(code);
    if (code === 0) expect(stderr).toBe("");
  });
}

test("CLI merchant works keylessly from explicit public env addresses", async () => {
  const port = 18410;
  const child = Bun.spawn([process.execPath, "src/cli.ts", "merchant", String(port)], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, DOGFOOD_WALLET_DIR: resolve(import.meta.dir, "test-support/nonexistent-vault"), DOGFOOD_MERCHANT_PAYTO: "0x" + "42".repeat(20), DOGFOOD_MERCHANT_BSV_PAYTO: "1M5aSsbBEXhPFSj4QUikCaZ2GQmf7TRwFN", DOGFOOD_MERCHANT_BSV_SATS: "500" },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("Merchant listening");
    reader.releaseLock();
    const res = await fetch(`http://127.0.0.1:${port}/v1/fortune`);
    expect(res.status).toBe(402);
    expect(res.headers.get("x-bsv-payment-satoshis-required")).toBe("500");
    const body = await res.json();
    expect(body.accepts.map((a: any) => a.scheme)).toEqual(["exact", "bsv-direct"]);
  } finally {
    child.kill(); await child.exited;
  }
});
