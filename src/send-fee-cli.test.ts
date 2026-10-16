import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import { allowDestination, initVault } from "./vault";
import { inspectPaymentHold } from "./payment-guard";

const scenarios = [
  { args: ["--max-fee", "227", "ordinary", "note"], note: "ordinary note" },
  { args: ["ordinary", "--max-fee", "227", "note"], note: "ordinary note" },
  { args: ["ordinary", "note"], note: "ordinary note" },
  { args: ["--max-fee", "227", "--", "--max-fee", "literal"], note: "--max-fee literal" },
  { args: ["--max-fee", "9007199254740991"], note: "" },
  { args: ["--max-fee", "226"], over: true },
  { args: ["--max-fee", "0"], over: true },
  ...[
    ["--max-fee"], ["--max-fee", "227", "--max-fee", "227"],
    ["--max-fee=227"], ["--max-feee", "227"], ["--max-fee 227"],
    ...["-1", "+227", "1.0", "1e3", "0xff", "NaN", "Infinity", "", " 227", "227 ", "227x", "9007199254740992"].map(v => ["--max-fee", v]),
  ].map(args => ({ args, invalid: true })),
];
for (const scenario of scenarios) {
  const c = scenario as { args: string[]; note?: string; invalid?: boolean; over?: boolean };
  test(`CLI send fee ${JSON.stringify(c.args)}`, () => {
    const root = mkdtempSync(join(tmpdir(), "send-fee-cli-"));
    try {
      const { address } = initVault(root);
      const to = PrivateKey.fromRandom().toAddress();
      allowDestination(root, to);
      writeFileSync(join(root, "public-fixture.json"), JSON.stringify({ address }));
      const env: Record<string, string> = {};
      for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR"]) {
        if (process.env[key]) env[key] = process.env[key]!;
      }
      Object.assign(env, { DOGFOOD_WALLET_DIR: root, HOME: root, USERPROFILE: root });
      const result = Bun.spawnSync([process.execPath, "--no-install", "--preload", join(import.meta.dir, "test-support/send-fee-cli.ts"),
        join(import.meta.dir, "cli.ts"), "send", to, "1000", ...c.args], { env, timeout: 15000 });
      expect(result.exitCode).toBe(c.invalid || c.over ? 1 : 0);
      const calls = existsSync(join(root, "calls.jsonl")) ? readFileSync(join(root, "calls.jsonl"), "utf8") : "";
      if (c.invalid) {
        expect(result.stderr.toString()).toContain("REJECTED:");
        expect(calls).toBe("");
      } else if (c.over) {
        expect(result.stderr.toString()).toContain("Miner fee 227 sats exceeds");
        expect(calls).toContain("/hex");
        expect(calls).not.toContain('"sign"');
        expect(calls).not.toContain("arc.gorillapool");
      } else {
        expect(result.stdout.toString()).toContain("fee 227");
        expect(calls).toContain('"sign"');
        const log = readFileSync(join(root, "spends.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({ amount: 1000, fee: 227, note: c.note });
      }
      expect(inspectPaymentHold(root).blocked).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
