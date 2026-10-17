import { mockFetch } from "./fetch";
// Routing-only subprocess fixtures: mocked keys/rails, real disposable lock files.
// Full payment/hold integration is covered by mcp-x402 and payment-safety tests.
import { mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "cli-rails-"));
process.env.DOGFOOD_WALLET_DIR = root;
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
import { PrivateKey } from "@bsv/sdk";
import * as vault from "../vault";
import { BsvX402Error } from "../bsv-x402";
import { UsdcX402Error } from "../evm-x402";
const key = PrivateKey.fromHex("1".padStart(64, "0"));
mock.module("../vault", () => ({ ...vault,
  loadVault: () => ({ key, address: key.toAddress(), policy: { maxSatsPerTx: 1000, maxSatsPerDay: null, maxSatsLifetime: null, allowlist: [], killfileOn: false } }),
  loadUsage: (_root: string, _now: Date, asset = "bsv") => ({
    spentToday: asset === "bsv" ? 7 : 0,
    spentLifetime: asset === "brc181-bsv" ? 17 : asset === "brc181-usdc-base" ? 11 : asset === "brc181-usdc-solana" ? 13 : 0,
  }),
}));
const scenario = process.env.RAIL_SCENARIO;
mock.module("../bsv-x402", () => ({ BsvX402Error, settleBsvX402: async (opts: any) => {
  console.log("RAIL:bsv");
  if (opts.usage.spentToday !== 7 || opts.from !== key.toAddress()) throw new Error("wrong BSV usage or funding address");
  if (opts.brc181SpentTotal !== 17) throw new Error("wrong BRC-181 BSV usage scope");
  if (opts.policyEnvelope !== null) throw new Error("expected a null policy envelope without brc181.json");
  if (scenario === "bsv") return { ok: true, rail: "bsv" };
  if (scenario === "cap") throw new BsvX402Error("CAP", "test cap refusal");
  if (scenario === "settle") throw new BsvX402Error("SETTLE_FAILED", "test settlement refusal");
  throw new BsvX402Error("UNSUPPORTED", "no BSV");
} }));
mock.module("../evm-x402", () => ({ UsdcX402Error, settleUsdcX402: async (opts: any) => {
  console.log("RAIL:base");
  if (opts.brc181SpentTotal !== 11) throw new Error("wrong BRC-181 USDC-Base usage scope");
  if (opts.policyEnvelope !== null) throw new Error("expected a null policy envelope without brc181.json");
  if (scenario === "solana") throw new UsdcX402Error("UNSUPPORTED", "no Base");
  if (scenario === "base-cap") throw new UsdcX402Error("CAP", "test Base cap refusal");
  return { ok: true, rail: "base" };
} }));
mock.module("../solana-x402", () => ({ settleSolanaX402: async (opts: any) => {
  console.log("RAIL:solana");
  if (opts.brc181SpentTotal !== 13) throw new Error("wrong BRC-181 USDC-Solana usage scope");
  if (opts.policyEnvelope !== null) throw new Error("expected a null policy envelope without brc181.json");
  return { ok: true, rail: "solana" };
} }));
globalThis.fetch = mockFetch((async () => { throw new Error("Unexpected live network"); }));
