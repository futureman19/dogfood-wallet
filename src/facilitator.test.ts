import { describe, expect, test } from "bun:test";
import { getAddress, recoverTypedDataAddress } from "viem";
import { PrivateKey } from "@bsv/sdk";
import { evmTransferAuthorizationTypes, signTransferWithAuthorization, USDC_BASE } from "./evm";

// The self-hosted facilitator: our merchant settles its OWN mainnet USDC
// payments by submitting transferWithAuthorization itself, gas paid from our
// pocket's ETH. No Coinbase account, no third party — the key never leaves
// this machine (local runs only; the fly deployment stays keyless).

const key = PrivateKey.fromHex("1".padStart(64, "0"));
const PAYER = getAddress("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"); // privkey 1
const MERCHANT = getAddress("0x3285Bb4b72eCa1d2955928Fb8437Ac7ED167abdd");
const FACILITATOR = getAddress("0x209693Bc6afc0C5328bA36FaF03C18EF3122C5EA");

const DOMAIN = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE };

async function makePayment(over?: { to?: string; value?: string; validBefore?: string }) {
  const authorization = {
    from: PAYER,
    to: over?.to ?? MERCHANT,
    value: over?.value ?? "1000",
    validAfter: "0",
    validBefore: over?.validBefore ?? "4102444800",
    nonce: ("0x" + "ab".repeat(32)) as `0x${string}`,
  };
  const signature = await signTransferWithAuthorization({ key, domain: DOMAIN, authorization });
  return { x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization } };
}

const requirement = {
  scheme: "exact",
  network: "base",
  maxAmountRequired: "1000",
  payTo: MERCHANT,
  asset: USDC_BASE,
  extra: { name: "USD Coin", version: "2" },
};

type WriteArgs = Record<string, unknown>;
function fakeChain(over?: {
  sigValid?: boolean;
  nonceUsed?: boolean;
  balance?: bigint;
  receiptStatus?: string;
}): { chain: import("./facilitator").FacilitatorChain; writes: WriteArgs[] } {
  const writes: WriteArgs[] = [];
  const chain: import("./facilitator").FacilitatorChain = {
    async verifyTypedData(args) {
      if (over?.sigValid === false) return false;
      const recovered = await recoverTypedDataAddress({
        domain: args.domain as never,
        types: args.types as never,
        primaryType: "TransferWithAuthorization",
        message: args.message as never,
        signature: args.signature as `0x${string}`,
      });
      return recovered === getAddress(args.address);
    },
    async readContract(args) {
      expect(args.functionName).toBe("authorizationState");
      return over?.nonceUsed === true;
    },
    async writeContract(args) {
      writes.push(args as WriteArgs);
      return ("0x" + "ff".repeat(32)) as `0x${string}`;
    },
    async waitForTransactionReceipt() {
      return { status: over?.receiptStatus ?? "success" };
    },
    async getBalance() {
      return over?.balance ?? 10n ** 15n; // 0.001 ETH default
    },
  };
  return { chain, writes };
}

describe("selfSettle", () => {
  test("happy path: verifies signature, submits transferWithAuthorization, returns txHash", async () => {
    const { selfSettle } = await import("./facilitator");
    const { chain, writes } = fakeChain();
    const r = await selfSettle({ chain, account: FACILITATOR, payment: await makePayment(), requirement });
    expect(r).toEqual({ success: true, txHash: "0x" + "ff".repeat(32) });
    expect(writes).toHaveLength(1);
    expect(String(writes[0].address).toLowerCase()).toBe(USDC_BASE.toLowerCase());
    expect(writes[0].functionName).toBe("transferWithAuthorization");
    const args = writes[0].args as unknown[];
    expect(args[0]).toBe(PAYER);
    expect(args[1]).toBe(MERCHANT);
    expect(args[2]).toBe(1000n);
    expect(args[5]).toBe("0x" + "ab".repeat(32));
  });

  test("refuses when the authorization pays someone else", async () => {
    const { selfSettle, FacilitatorError } = await import("./facilitator");
    const { chain, writes } = fakeChain();
    const other = await makePayment({ to: PAYER });
    const err = await selfSettle({ chain, account: FACILITATOR, payment: other, requirement }).catch((e) => e);
    expect(err).toBeInstanceOf(FacilitatorError);
    expect((err as InstanceType<typeof FacilitatorError>).code).toBe("PAYEE_MISMATCH");
    expect(writes).toHaveLength(0);
  });

  test("refuses when the amount does not match the requirement", async () => {
    const { selfSettle, FacilitatorError } = await import("./facilitator");
    const { chain, writes } = fakeChain();
    const err = await selfSettle({
      chain,
      account: FACILITATOR,
      payment: await makePayment({ value: "999" }),
      requirement,
    }).catch((e) => e);
    expect((err as InstanceType<typeof FacilitatorError>).code).toBe("AMOUNT_MISMATCH");
    expect(writes).toHaveLength(0);
  });

  test("refuses a spent nonce before spending gas", async () => {
    const { selfSettle, FacilitatorError } = await import("./facilitator");
    const { chain, writes } = fakeChain({ nonceUsed: true });
    const err = await selfSettle({ chain, account: FACILITATOR, payment: await makePayment(), requirement }).catch((e) => e);
    expect((err as InstanceType<typeof FacilitatorError>).code).toBe("NONCE_USED");
    expect(writes).toHaveLength(0);
  });

  test("refuses a bad signature", async () => {
    const { selfSettle, FacilitatorError } = await import("./facilitator");
    const { chain, writes } = fakeChain({ sigValid: false });
    const err = await selfSettle({ chain, account: FACILITATOR, payment: await makePayment(), requirement }).catch((e) => e);
    expect((err as InstanceType<typeof FacilitatorError>).code).toBe("BAD_SIGNATURE");
    expect(writes).toHaveLength(0);
  });

  test("refuses an expired authorization", async () => {
    const { selfSettle, FacilitatorError } = await import("./facilitator");
    const { chain, writes } = fakeChain();
    const payment = await makePayment({ validBefore: "1000" });
    const err = await selfSettle({ chain, account: FACILITATOR, payment, requirement, now: 2000 }).catch((e) => e);
    expect((err as InstanceType<typeof FacilitatorError>).code).toBe("EXPIRED");
    expect(writes).toHaveLength(0);
  });

  test("refuses to settle without gas money", async () => {
    const { selfSettle, FacilitatorError } = await import("./facilitator");
    const { chain, writes } = fakeChain({ balance: 0n });
    const err = await selfSettle({ chain, account: FACILITATOR, payment: await makePayment(), requirement }).catch((e) => e);
    expect((err as InstanceType<typeof FacilitatorError>).code).toBe("GAS");
    expect(writes).toHaveLength(0);
  });

  test("reverted on-chain execution surfaces as SETTLE_REVERTED", async () => {
    const { selfSettle, FacilitatorError } = await import("./facilitator");
    const { chain } = fakeChain({ receiptStatus: "reverted" });
    const err = await selfSettle({ chain, account: FACILITATOR, payment: await makePayment(), requirement }).catch((e) => e);
    expect((err as InstanceType<typeof FacilitatorError>).code).toBe("SETTLE_REVERTED");
  });

  test("refuses to facilitate payments not paying this facilitator's merchant config", async () => {
    const { selfSettle, FacilitatorError } = await import("./facilitator");
    const { chain, writes } = fakeChain();
    const foreign = { ...requirement, payTo: PAYER };
    const err = await selfSettle({ chain, account: FACILITATOR, payment: await makePayment(), requirement: foreign, ownPayTo: MERCHANT }).catch((e) => e);
    expect((err as InstanceType<typeof FacilitatorError>).code).toBe("FOREIGN_PAYEE");
    expect(writes).toHaveLength(0);
  });
});
