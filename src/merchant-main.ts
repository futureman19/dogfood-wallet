// Standalone merchant server entry for deployment (fly.io). No vault, no
// keys: the payee is a plain address from env. Local runs use the CLI
// `merchant` command instead, which derives payTo from the vault key.
import { createMerchantApp } from "./merchant";

const payTo = process.env.DOGFOOD_MERCHANT_PAYTO;
if (!payTo) {
  console.error("DOGFOOD_MERCHANT_PAYTO is required (public EVM address).");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8080);
const network = process.env.DOGFOOD_MERCHANT_NETWORK ?? "base-sepolia";
const facilitatorUrl = process.env.DOGFOOD_FACILITATOR_URL ?? "https://x402.org/facilitator";
const priceBaseUnits = Number(process.env.DOGFOOD_MERCHANT_PRICE ?? 1_000);

const app = createMerchantApp({
  payTo,
  priceBaseUnits,
  resourcePath: "/v1/fortune",
  facilitatorUrl,
  network,
  bsvPayTo: process.env.DOGFOOD_MERCHANT_BSV_PAYTO,
  bsvSatoshis: Number(process.env.DOGFOOD_MERCHANT_BSV_SATS ?? 500),
});

Bun.serve({ port, hostname: "0.0.0.0", fetch: app });
console.log(`dogfood-merchant on :${port} (${network}, ${priceBaseUnits} units/call, payTo ${payTo})`);
