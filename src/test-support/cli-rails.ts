// Subprocess-only fixtures: no vault IO, chain RPC, or signed payment leaves this process.
import { mock } from "bun:test";
import { PrivateKey } from "@bsv/sdk";
import * as vault from "../vault";
import { BsvX402Error } from "../bsv-x402";
import { UsdcX402Error } from "../evm-x402";
const key = PrivateKey.fromHex("1".padStart(64, "0"));
mock.module("../vault", () => ({ ...vault,
  loadVault: () => ({ key, address: key.toAddress(), policy: { maxSatsPerTx: 1000, maxSatsPerDay: null, maxSatsLifetime: null, allowlist: [], killfileOn: false } }),
  loadUsage: (_root: string, _now: Date, asset = "bsv") => ({ spentToday: asset === "bsv" ? 7 : 0, spentLifetime: 0 }),
}));
const scenario = process.env.RAIL_SCENARIO;
mock.module("../bsv-x402", () => ({ BsvX402Error, settleBsvX402: async (opts: any) => {
  console.log("RAIL:bsv");
  if (opts.usage.spentToday !== 7 || opts.from !== key.toAddress()) throw new Error("wrong BSV usage or funding address");
  if (scenario === "bsv") return { ok: true, rail: "bsv" };
  if (scenario === "cap") throw new BsvX402Error("CAP", "test cap refusal");
  if (scenario === "settle") throw new BsvX402Error("SETTLE_FAILED", "test settlement refusal");
  throw new BsvX402Error("UNSUPPORTED", "no BSV");
} }));
mock.module("../evm-x402", () => ({ UsdcX402Error, settleUsdcX402: async () => {
  console.log("RAIL:base");
  if (scenario === "solana") throw new UsdcX402Error("UNSUPPORTED", "no Base");
  if (scenario === "base-cap") throw new UsdcX402Error("CAP", "test Base cap refusal");
  return { ok: true, rail: "base" };
} }));
mock.module("../solana-x402", () => ({ settleSolanaX402: async () => {
  console.log("RAIL:solana"); return { ok: true, rail: "solana" };
} }));
globalThis.fetch = (async () => { throw new Error("Unexpected live network"); }) as typeof fetch;
