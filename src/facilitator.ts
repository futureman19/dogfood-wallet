import {
  createPublicClient,
  createWalletClient,
  getAddress,
  hexToSignature,
  http,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKey } from "@bsv/sdk";
import { BASE_RPC, USDC_BASE, evmTransferAuthorizationTypes } from "./evm";

// The self-hosted facilitator: settle OUR OWN merchant's mainnet USDC
// payments by submitting transferWithAuthorization ourselves. The vault key
// pays gas in ETH from the EVM pocket. This runs LOCALLY only (the CLI
// `merchant` command with DOGFOOD_SELF_FACILITATE=1) — keys never go to fly.
// It deliberately settles only payments addressed to our own payee: this is
// a cash register component, not a public settlement service.

export class FacilitatorError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FacilitatorError";
    this.code = code;
  }
}

export const MIN_FACILITATOR_GAS_WEI = 20_000_000_000_000n; // 0.00002 ETH

const EIP3009_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Minimal chain surface so tests can inject a fake; viem backs it in prod. */
export type FacilitatorChain = {
  verifyTypedData(args: {
    address: string;
    domain: Record<string, unknown>;
    types: unknown;
    primaryType: string;
    message: Record<string, unknown>;
    signature: string;
  }): Promise<boolean>;
  readContract(args: {
    address: string;
    abi: unknown;
    functionName: string;
    args: unknown[];
  }): Promise<unknown>;
  writeContract(args: {
    address: string;
    abi: unknown;
    functionName: string;
    args: unknown[];
    account?: unknown;
    chain?: unknown;
  }): Promise<string>;
  waitForTransactionReceipt(args: { hash: string }): Promise<{ status: string }>;
  getBalance(args: { address: string }): Promise<bigint>;
};

export function makeBaseFacilitatorChain(key: PrivateKey, rpcUrl: string = BASE_RPC): {
  chain: FacilitatorChain;
  account: Address;
} {
  const account = privateKeyToAccount(`0x${key.toHex().padStart(64, "0")}` as Hex);
  const pub = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
  return {
    account: account.address,
    chain: {
      verifyTypedData: (args) =>
        pub.verifyTypedData({
          address: args.address as Address,
          domain: args.domain as never,
          types: args.types as never,
          primaryType: "TransferWithAuthorization",
          message: args.message as never,
          signature: args.signature as Hex,
        }),
      readContract: (args) =>
        pub.readContract({
          address: args.address as Address,
          abi: args.abi as never,
          functionName: args.functionName as never,
          args: args.args as never,
        }),
      writeContract: (args) =>
        wallet.writeContract({
          address: args.address as Address,
          abi: args.abi as never,
          functionName: args.functionName as never,
          args: args.args as never,
          account,
          chain: base,
        }),
      waitForTransactionReceipt: (args) => pub.waitForTransactionReceipt({ hash: args.hash as Hex }),
      getBalance: (args) => pub.getBalance({ address: args.address as Address }),
    },
  };
}

type PaymentPayload = {
  payload?: { signature?: string; authorization?: Record<string, string> };
};

type SettleRequirement = {
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  extra?: { name?: string; version?: string };
};

export async function selfSettle(opts: {
  chain: FacilitatorChain;
  account: string;
  payment: PaymentPayload;
  requirement: SettleRequirement;
  ownPayTo?: string;
  now?: number;
}): Promise<{ success: true; txHash: string }> {
  const { chain, requirement } = opts;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const auth = opts.payment.payload?.authorization;
  const signature = opts.payment.payload?.signature;
  if (!auth || !signature) throw new FacilitatorError("BAD_PAYLOAD", "Payment payload missing signature/authorization.");
  if (requirement.network !== "base" || requirement.asset.toLowerCase() !== USDC_BASE.toLowerCase()) {
    throw new FacilitatorError("UNSUPPORTED", "Self-facilitation only settles exact/base USDC.");
  }
  const ownPayTo = opts.ownPayTo ?? requirement.payTo;
  if (requirement.payTo.toLowerCase() !== ownPayTo.toLowerCase()) {
    throw new FacilitatorError("FOREIGN_PAYEE", "Refusing to settle a payment that does not pay our own address.");
  }
  const from = getAddress(auth.from ?? "");
  const to = getAddress(auth.to ?? "");
  if (to.toLowerCase() !== requirement.payTo.toLowerCase()) {
    throw new FacilitatorError("PAYEE_MISMATCH", "Authorization pays a different address than required.");
  }
  if (BigInt(auth.value ?? "0") !== BigInt(requirement.maxAmountRequired)) {
    throw new FacilitatorError("AMOUNT_MISMATCH", "Authorization value does not match the requirement.");
  }
  if (BigInt(auth.validAfter ?? "0") > BigInt(now)) throw new FacilitatorError("NOT_YET_VALID", "Authorization is not yet valid.");
  if (BigInt(auth.validBefore ?? "0") < BigInt(now)) throw new FacilitatorError("EXPIRED", "Authorization expired.");

  const domain = {
    name: requirement.extra?.name ?? "USD Coin",
    version: requirement.extra?.version ?? "2",
    chainId: 8453,
    verifyingContract: getAddress(requirement.asset),
  };
  const message = {
    from,
    to,
    value: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter ?? "0"),
    validBefore: BigInt(auth.validBefore ?? "0"),
    nonce: auth.nonce as Hex,
  };
  const validSig = await chain.verifyTypedData({
    address: from,
    domain,
    types: evmTransferAuthorizationTypes(),
    primaryType: "TransferWithAuthorization",
    message: message as unknown as Record<string, unknown>,
    signature,
  });
  if (!validSig) throw new FacilitatorError("BAD_SIGNATURE", "Signature does not recover the payer.");

  const used = await chain.readContract({
    address: USDC_BASE,
    abi: EIP3009_ABI,
    functionName: "authorizationState",
    args: [from, auth.nonce],
  });
  if (used === true) throw new FacilitatorError("NONCE_USED", "Authorization nonce already used on-chain.");

  const gas = await chain.getBalance({ address: opts.account });
  if (gas < MIN_FACILITATOR_GAS_WEI) {
    throw new FacilitatorError("GAS", `Facilitator needs ETH for gas (have ${gas} wei).`);
  }

  const { v, r, s } = hexToSignature(signature as Hex);
  const hash = await chain.writeContract({
    address: USDC_BASE,
    abi: EIP3009_ABI,
    functionName: "transferWithAuthorization",
    args: [from, to, BigInt(auth.value), BigInt(auth.validAfter ?? "0"), BigInt(auth.validBefore ?? "0"), auth.nonce, Number(v), r, s],
  });
  const receipt = await chain.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new FacilitatorError("SETTLE_REVERTED", `transferWithAuthorization reverted on-chain (tx ${hash}).`);
  }
  return { success: true, txHash: hash };
}
