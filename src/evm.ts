import { createPublicClient, getAddress, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKey } from "@bsv/sdk";

// The EVM pocket: same secret as the BSV vault key, second identity.
// secp256k1 is shared by both chains, so no new key file exists — the EVM
// address is derived on demand from the decrypted vault key.

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_CHAIN_ID = 8453;
export const BASE_RPC = "https://mainnet.base.org";

function keyToHex(key: PrivateKey): `0x${string}` {
  return `0x${key.toHex()}` as `0x${string}`;
}

export function deriveEvmAddress(key: PrivateKey): string {
  return privateKeyToAccount(keyToHex(key)).address;
}

export function evmTransferAuthorizationTypes() {
  return {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  } as const;
}

export type Eip712Domain = { name: string; version: string; chainId: number; verifyingContract: string };

export type TransferAuthorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
};

export async function signTransferWithAuthorization(opts: {
  key: PrivateKey;
  domain: Eip712Domain;
  authorization: TransferAuthorization;
}): Promise<string> {
  const account = privateKeyToAccount(keyToHex(opts.key));
  // Normalize to EIP-55 checksums: viem rejects mixed-case addresses whose
  // checksum doesn't match, and merchants send arbitrary casing.
  return account.signTypedData({
    domain: {
      name: opts.domain.name,
      version: opts.domain.version,
      chainId: opts.domain.chainId,
      verifyingContract: getAddress(opts.domain.verifyingContract),
    },
    types: evmTransferAuthorizationTypes(),
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(opts.authorization.from),
      to: getAddress(opts.authorization.to),
      value: BigInt(opts.authorization.value),
      validAfter: BigInt(opts.authorization.validAfter),
      validBefore: BigInt(opts.authorization.validBefore),
      nonce: opts.authorization.nonce as `0x${string}`,
    },
  });
}

export type X402ExactRequirement = {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payTo: string;
  asset: string;
  extra?: { name?: string; version?: string };
};

// Builds the base64 X-PAYMENT header for the Coinbase x402 `exact` scheme
// (EIP-3009 transferWithAuthorization, signed with EIP-712 typed data). The
// facilitator submits on-chain and pays gas — the pocket only needs USDC.
export async function buildX402PaymentHeader(opts: {
  key: PrivateKey;
  requirement: X402ExactRequirement;
  from: string;
  now?: number;
  nonceHex?: string;
  validitySeconds?: number;
}): Promise<string> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const nonce =
    opts.nonceHex ?? `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
  const authorization: TransferAuthorization = {
    from: opts.from,
    to: opts.requirement.payTo,
    value: opts.requirement.maxAmountRequired,
    validAfter: String(now),
    validBefore: String(now + (opts.validitySeconds ?? 3600)),
    nonce,
  };
  const signature = await signTransferWithAuthorization({
    key: opts.key,
    domain: {
      name: opts.requirement.extra?.name ?? "USD Coin",
      version: opts.requirement.extra?.version ?? "2",
      chainId: BASE_CHAIN_ID,
      verifyingContract: opts.requirement.asset,
    },
    authorization,
  });
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: opts.requirement.network,
      payload: { signature, authorization },
    }),
  ).toString("base64");
}

export async function usdcBalanceOf(address: string, rpcUrl: string = BASE_RPC): Promise<bigint> {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  return (await client.readContract({
    address: USDC_BASE as `0x${string}`,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  })) as bigint;
}
