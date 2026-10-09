import { describe, expect, test } from "bun:test";
import { PrivateKey } from "@bsv/sdk";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { createMerchantApp, type MerchantConfig } from "./merchant";
import { buildSolanaX402PaymentHeader, USDC_SOLANA_DEVNET, deriveSolanaAddress } from "./solana";
import { createMemoryReplayStore } from "./replay-store";

// Merchant-side Solana: accept x402 `exact` payments on solana-devnet. Local
// self-facilitation only — the merchant IS the fee payer (vault-derived
// ed25519 key), so this runs with keys on this machine, never on fly.

const merchantKey = PrivateKey.fromHex("9".repeat(64));
const payerKey = PrivateKey.fromHex("8".repeat(64));
const merchantAddr = deriveSolanaAddress(merchantKey);
const payerAddr = deriveSolanaAddress(payerKey);

const base: MerchantConfig = {
  payTo: "0x1111111111111111111111111111111111111111",
  priceBaseUnits: 1000,
  resourcePath: "/v1/fortune",
  facilitatorUrl: "https://facilitator.invalid",
  network: "base-sepolia",
};

const BLOCKHASH = "4uHCe4FhA1RqVhVPe7LBDhMvVKjCPyUKBiLfkPePbZZ7";
const SIG_OK = "5xMerchantSettlementSig";

function world(over?: { confirmStatus?: string | null; sendFails?: boolean }) {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    if (body.includes("getLatestBlockhash")) {
      return Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } } });
    }
    if (body.includes("sendTransaction")) {
      calls.push("sendTransaction");
      if (over?.sendFails) return Response.json({ jsonrpc: "2.0", id: 1, error: { message: "blockhash not found" } });
      return Response.json({ jsonrpc: "2.0", id: 1, result: SIG_OK });
    }
    if (body.includes("getSignatureStatuses")) {
      calls.push("getSignatureStatuses");
      const status = over?.confirmStatus === undefined ? "confirmed" : over.confirmStatus;
      return Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 2 }, value: [status ? { confirmationStatus: status, err: null } : null] } });
    }
    throw new Error(`Unexpected RPC: ${body.slice(0, 90)}`);
  }) as typeof fetch;
  return { fetchFn, calls };
}

async function payHeader(over?: { price?: number; feePayer?: string; payTo?: string; asset?: string }) {
  return buildSolanaX402PaymentHeader({
    key: payerKey,
    requirement: {
      scheme: "exact",
      network: "solana-devnet",
      maxAmountRequired: String(over?.price ?? 1000),
      payTo: over?.payTo ?? merchantAddr,
      asset: over?.asset ?? USDC_SOLANA_DEVNET,
      extra: { feePayer: over?.feePayer ?? merchantAddr },
    },
    fetchFn: world().fetchFn,
  });
}

function mkApp(fetchFn: typeof fetch, over?: Partial<MerchantConfig>) {
  return createMerchantApp({
    ...base,
    fetchFn,
    solanaPayTo: merchantAddr,
    solanaNetwork: "solana-devnet",
    solanaFeePayerKey: merchantKey,
    ...over,
  });
}

const pay = (app: ReturnType<typeof createMerchantApp>, header: string) =>
  app(new Request("https://merchant.invalid/v1/fortune", { headers: { "X-PAYMENT": header } }));

describe("merchant Solana rail", () => {
  test("advertises a solana-devnet entry with ourselves as feePayer", async () => {
    const { fetchFn } = world();
    const res = await mkApp(fetchFn)(new Request("https://merchant.invalid/v1/fortune"));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: Record<string, unknown>[] };
    const sol = body.accepts.find((a) => a.network === "solana-devnet");
    expect(sol).toMatchObject({
      scheme: "exact",
      asset: USDC_SOLANA_DEVNET,
      maxAmountRequired: "1000",
      payTo: merchantAddr,
      extra: { feePayer: merchantAddr },
    });
  });

  test("full loop: our own client header verifies and settles", async () => {
    const { fetchFn, calls } = world();
    const app = mkApp(fetchFn);
    const res = await pay(app, await payHeader());
    expect(res.status).toBe(200);
    const receipt = JSON.parse(Buffer.from(res.headers.get("x-payment-response")!, "base64").toString());
    expect(receipt).toMatchObject({ success: true, transaction: SIG_OK, network: "solana-devnet" });
    expect(calls).toEqual(["sendTransaction", "getSignatureStatuses"]);
  });

  test("rejects an underpaying transaction before spending gas", async () => {
    const { fetchFn, calls } = world();
    const res = await pay(mkApp(fetchFn), await payHeader({ price: 999 }));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toContain("amount");
    expect(calls).toEqual([]);
  });

  test("rejects payment to the wrong destination", async () => {
    const { fetchFn, calls } = world();
    const res = await pay(mkApp(fetchFn), await payHeader({ payTo: payerAddr }));
    expect(res.status).toBe(402);
    expect(calls).toEqual([]);
  });

  test("rejects the wrong mint", async () => {
    const { fetchFn, calls } = world();
    const res = await pay(mkApp(fetchFn), await payHeader({ asset: Keypair.generate().publicKey.toBase58() }));
    expect(res.status).toBe(402);
    expect(calls).toEqual([]);
  });

  test("rejects a wrong fee payer", async () => {
    const { fetchFn, calls } = world();
    const res = await pay(mkApp(fetchFn), await payHeader({ feePayer: payerAddr }));
    expect(res.status).toBe(402);
    expect(calls).toEqual([]);
  });

  test("replay of the same header is refused and never re-submitted", async () => {
    const { fetchFn, calls } = world();
    const app = mkApp(fetchFn, { replayStore: createMemoryReplayStore() });
    const header = await payHeader();
    expect((await pay(app, header)).status).toBe(200);
    const second = await pay(app, header);
    expect(second.status).toBe(402);
    expect((await second.json()).error).toContain("replay");
    expect(calls.filter((c) => c === "sendTransaction")).toHaveLength(1);
  });

  test("submit failure surfaces as a 402 settlement error", async () => {
    const { fetchFn } = world({ sendFails: true });
    const res = await pay(mkApp(fetchFn), await payHeader());
    expect(res.status).toBe(402);
    expect((await res.json()).error).toContain("Settlement failed");
  });

  test("unconfirmed transaction surfaces as a 402 settlement error", async () => {
    const { fetchFn } = world({ confirmStatus: null });
    const res = await pay(mkApp(fetchFn, { solanaConfirmTries: 2, solanaConfirmDelayMs: 0 }), await payHeader());
    expect(res.status).toBe(402);
  });

  test("rail omitted entirely when not configured", async () => {
    const app = createMerchantApp(base);
    const res = await app(new Request("https://merchant.invalid/v1/fortune"));
    const body = (await res.json()) as { accepts: Record<string, unknown>[] };
    expect(body.accepts.every((a) => !String(a.network ?? "").startsWith("solana"))).toBe(true);
  });
});
