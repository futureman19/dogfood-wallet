// One-off diagnostic: replay the x402 v2 EVM payment against a URL and dump the
// merchant's raw response to the signed request (status + headers + body).
// Thin wrapper over tested src/ modules only. Run:
//   bun scripts/x402-v2-probe.mts <url>
import { withPaymentGuard } from "../src/payment-guard";
import { loadVault, loadUsage, vaultPaths } from "../src/vault";
import { loadPolicyEnvelope } from "../src/brc181";
import { deriveEvmAddress } from "../src/evm";
import { settleUsdcX402, UsdcX402Error } from "../src/evm-x402";

const url = process.argv[2];
if (!url) throw new Error("usage: bun scripts/x402-v2-probe.mts <url>");
const root = process.env.DOGFOOD_WALLET_DIR ?? undefined;

async function loggingFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const res = await fetch(input as string, init);
  const clone = res.clone();
  const body = await clone.text();
  console.log(`\n=== ${init?.method ?? "GET"} ${String(input)} -> HTTP ${res.status}`);
  res.headers.forEach((v, k) => console.log(`  ${k}: ${v.length > 220 ? v.slice(0, 220) + "…" : v}`));
  const pr = res.headers.get("payment-response");
  if (pr) {
    try { console.log(`  DECODED payment-response: ${Buffer.from(pr, "base64").toString("utf8")}`); }
    catch { console.log("  (payment-response not base64-json)"); }
  }
  console.log(`  body: ${body.slice(0, 600)}`);
  return res;
}

const r = await withPaymentGuard(root ?? `${process.env.USERPROFILE}/.dogfood-wallet`, "x402-pay", async (guard) => {
  const vault = loadVault(root ?? `${process.env.USERPROFILE}/.dogfood-wallet`);
  return settleUsdcX402({
    url,
    key: vault.key,
    from: deriveEvmAddress(vault.key),
    requireReceipt: true,
    fetchFn: loggingFetch as typeof fetch,
    pocket: vault.policy.evm?.usdc,
    killfileOn: vault.policy.killfileOn,
    usage: loadUsage(root ?? `${process.env.USERPROFILE}/.dogfood-wallet`, new Date(), "usdc-base"),
    brc181SpentTotal: loadUsage(root ?? `${process.env.USERPROFILE}/.dogfood-wallet`, new Date(), "brc181-usdc-base").spentLifetime,
    get policyEnvelope() {
      const loaded = loadPolicyEnvelope(vaultPaths(root ?? `${process.env.USERPROFILE}/.dogfood-wallet`).brc181);
      if (!loaded.ok) throw new UsdcX402Error(loaded.code, loaded.message);
      return loaded.envelope;
    },
    beforeSign: guard.reserve,
    onSpend: guard.log,
  });
});
console.log("\nRESULT:", JSON.stringify(r));
