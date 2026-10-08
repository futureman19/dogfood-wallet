import { describe, expect, test } from "bun:test";
import { PrivateKey } from "@bsv/sdk";
import { ed25519 } from "@noble/curves/ed25519";
import { VersionedTransaction } from "@solana/web3.js";

// The Solana pocket: the SAME 32 bytes of vault entropy interpreted as an
// ed25519 seed — one secret, third identity (BSV + EVM + Solana), no new key
// file, no new backup.

const FROZEN_PRIVKEY_ONE_SOLANA = "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt";

const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MERCHANT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const FEE_PAYER = "CkTDQfii4biNwDuWGbLCBxaY2M9VLsDu3fMNvWEbZvTa";

function keyOne() {
  return PrivateKey.fromHex("1".padStart(64, "0"));
}

function blockhashFetch(blockhash: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    if (body.includes("getLatestBlockhash")) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 100 } } }));
    }
    throw new Error(`unexpected RPC call: ${body.slice(0, 80)}`);
  }) as typeof fetch;
}

describe("deriveSolanaAddress", () => {
  test("privkey 1 matches the frozen vector", async () => {
    const { deriveSolanaAddress } = await import("./solana");
    expect(deriveSolanaAddress(keyOne())).toBe(FROZEN_PRIVKEY_ONE_SOLANA);
  });

  test("is deterministic", async () => {
    const { deriveSolanaAddress } = await import("./solana");
    expect(deriveSolanaAddress(keyOne())).toBe(deriveSolanaAddress(keyOne()));
  });
});

describe("buildSolanaX402PaymentHeader", () => {
  const requirement = {
    scheme: "exact",
    network: "solana-devnet",
    maxAmountRequired: "1000",
    payTo: MERCHANT,
    asset: USDC_DEVNET,
    extra: { feePayer: FEE_PAYER },
  };

  test("header carries a partially-signed versioned transaction", async () => {
    const { buildSolanaX402PaymentHeader } = await import("./solana");
    const header = await buildSolanaX402PaymentHeader({
      key: keyOne(),
      requirement,
      fetchFn: blockhashFetch("4uHCe4FhA1RqVhVPe7LBDhMvVKjCPyUKBiLfkPePbZZ7"),
    });
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    expect(decoded.x402Version).toBe(1);
    expect(decoded.scheme).toBe("exact");
    expect(decoded.network).toBe("solana-devnet");
    expect(typeof decoded.payload.transaction).toBe("string");

    const tx = VersionedTransaction.deserialize(Buffer.from(decoded.payload.transaction, "base64"));
    // Fee payer is the facilitator's, not ours — we never pay SOL.
    expect(tx.message.staticAccountKeys[0].toBase58()).toBe(FEE_PAYER);
    // Our key signed: find our slot and verify the ed25519 signature over the message.
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    const idx = keys.indexOf(FROZEN_PRIVKEY_ONE_SOLANA);
    expect(idx).toBeGreaterThan(-1);
    const sig = tx.signatures[idx];
    expect(sig.some((b) => b !== 0)).toBe(true);
    const valid = ed25519.verify(sig, tx.message.serialize(), new Uint8Array(tx.message.staticAccountKeys[idx].toBytes()));
    expect(valid).toBe(true);
  });

  test("transaction transfers the required USDC amount to the merchant", async () => {
    const { buildSolanaX402PaymentHeader, USDC_SOLANA_DEVNET } = await import("./solana");
    const header = await buildSolanaX402PaymentHeader({
      key: keyOne(),
      requirement,
      fetchFn: blockhashFetch("4uHCe4FhA1RqVhVPe7LBDhMvVKjCPyUKBiLfkPePbZZ7"),
    });
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const tx = VersionedTransaction.deserialize(Buffer.from(decoded.payload.transaction, "base64"));
    // ATA-create (idempotent) + transferChecked.
    expect(tx.message.compiledInstructions.length).toBe(2);
    const transfer = tx.message.compiledInstructions[1];
    // transferChecked data layout: [3 discriminator][8-byte LE amount][1 decimals]
    const data = Buffer.from(transfer.data);
    expect(data[0]).toBe(12); // TokenInstruction.TransferChecked
    expect(data.readBigUInt64LE(1)).toBe(1000n);
    expect(data[9]).toBe(6);
    expect(USDC_SOLANA_DEVNET).toBe(USDC_DEVNET);
  });

  test("defaults feePayer to ourselves when extra is absent", async () => {
    const { buildSolanaX402PaymentHeader } = await import("./solana");
    const header = await buildSolanaX402PaymentHeader({
      key: keyOne(),
      requirement: { ...requirement, extra: undefined },
      fetchFn: blockhashFetch("4uHCe4FhA1RqVhVPe7LBDhMvVKjCPyUKBiLfkPePbZZ7"),
    });
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const tx = VersionedTransaction.deserialize(Buffer.from(decoded.payload.transaction, "base64"));
    expect(tx.message.staticAccountKeys[0].toBase58()).toBe(FROZEN_PRIVKEY_ONE_SOLANA);
  });
});
