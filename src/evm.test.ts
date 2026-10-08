import { describe, expect, test } from "bun:test";
import { PrivateKey } from "@bsv/sdk";
import { getAddress, recoverTypedDataAddress } from "viem";
import {
  buildX402PaymentHeader,
  deriveEvmAddress,
  evmTransferAuthorizationTypes,
  signTransferWithAuthorization,
  USDC_BASE,
} from "./evm";

// Same secret, two identities: the BSV vault key and the EVM pocket address
// are two views of one secp256k1 key.
const KEY_ONE = PrivateKey.fromHex("0".repeat(63) + "1");
const ADDR_ONE = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"; // canonical vector for privkey=1

describe("deriveEvmAddress", () => {
  test("derives the canonical EVM address for privkey=1", () => {
    expect(deriveEvmAddress(KEY_ONE)).toBe(ADDR_ONE);
  });

  test("is deterministic across random keys", () => {
    const k = PrivateKey.fromRandom();
    expect(deriveEvmAddress(k)).toBe(deriveEvmAddress(k));
    expect(deriveEvmAddress(k)).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("signTransferWithAuthorization", () => {
  test("produces an EIP-712 signature that recovers to the vault EVM address", async () => {
    const authorization = {
      from: ADDR_ONE,
      to: "0x209693Bc6afc0C5328bA36FaF03C18EF3122C5EA",
      value: "10000",
      validAfter: "0",
      validBefore: "1799999999",
      nonce: "0x" + "ab".repeat(32),
    };
    const signature = await signTransferWithAuthorization({
      key: KEY_ONE,
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE },
      authorization,
    });
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    const recovered = await recoverTypedDataAddress({
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE },
      types: evmTransferAuthorizationTypes(),
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(ADDR_ONE),
        to: getAddress("0x209693Bc6afc0C5328bA36FaF03C18EF3122C5EA"),
        value: 10000n,
        validAfter: 0n,
        validBefore: 1799999999n,
        nonce: "0x" + "ab".repeat(32),
      },
      signature: signature as `0x${string}`,
    });
    expect(recovered.toLowerCase()).toBe(ADDR_ONE.toLowerCase());
  });
});

describe("buildX402PaymentHeader", () => {
  test("base64-decodes to the exact x402 v1 payload shape", async () => {
    const header = await buildX402PaymentHeader({
      key: KEY_ONE,
      requirement: {
        scheme: "exact",
        network: "base",
        maxAmountRequired: "10000",
        payTo: "0x209693Bc6afc0C5328bA36FaF03C18EF3122C5EA",
        asset: USDC_BASE,
        extra: { name: "USD Coin", version: "2" },
      },
      from: ADDR_ONE,
      now: 1_700_000_000,
      nonceHex: "0x" + "cd".repeat(32),
    });
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    expect(decoded.x402Version).toBe(1);
    expect(decoded.scheme).toBe("exact");
    expect(decoded.network).toBe("base");
    expect(decoded.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(decoded.payload.authorization).toEqual({
      from: ADDR_ONE,
      to: "0x209693Bc6afc0C5328bA36FaF03C18EF3122C5EA",
      value: "10000",
      validAfter: "0",
      validBefore: "1700003600",
      nonce: "0x" + "cd".repeat(32),
    });
  });
});
