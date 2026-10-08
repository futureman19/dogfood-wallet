import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { PrivateKey } from "@bsv/sdk";

// The Solana pocket: the SAME 32 bytes of vault entropy interpreted as an
// ed25519 seed — one secret, third identity (BSV + EVM + Solana). No new key
// file, no new backup. The facilitator is fee payer; the pocket needs no SOL.

export const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_SOLANA_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
export const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";

export function rpcForSolanaNetwork(network: string): string {
  return network === "solana" ? SOLANA_RPC : SOLANA_DEVNET_RPC;
}

function keypairFromKey(key: PrivateKey): Keypair {
  const seed = new Uint8Array(Buffer.from(key.toHex().padStart(64, "0"), "hex"));
  return Keypair.fromSeed(seed);
}

export function deriveSolanaAddress(key: PrivateKey): string {
  return keypairFromKey(key).publicKey.toBase58();
}

export class SolanaError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SolanaError";
    this.code = code;
  }
}

async function rpcCall(
  fetchFn: typeof fetch,
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const res = await fetchFn(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new SolanaError("RPC", `Solana RPC ${method} failed: HTTP ${res.status}.`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new SolanaError("RPC", `Solana RPC ${method}: ${body.error.message ?? "unknown error"}.`);
  return body.result;
}

export type SolanaExactRequirement = {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payTo: string;
  asset: string;
  extra?: { feePayer?: string };
};

// Builds the base64 X-PAYMENT header for the x402 `exact` scheme on Solana:
// a versioned transaction (idempotent destination-ATA create + transferChecked
// of the required USDC amount), partially signed by the pocket. The
// facilitator co-signs as fee payer and submits — we never touch SOL.
export async function buildSolanaX402PaymentHeader(opts: {
  key: PrivateKey;
  requirement: SolanaExactRequirement;
  rpcUrl?: string;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const rpcUrl = opts.rpcUrl ?? rpcForSolanaNetwork(opts.requirement.network);
  const kp = keypairFromKey(opts.key);
  const feePayer = new PublicKey(opts.requirement.extra?.feePayer ?? kp.publicKey.toBase58());
  const mint = new PublicKey(opts.requirement.asset);
  const destOwner = new PublicKey(opts.requirement.payTo);
  const sourceAta = getAssociatedTokenAddressSync(mint, kp.publicKey);
  const destAta = getAssociatedTokenAddressSync(mint, destOwner);

  const result = (await rpcCall(fetchFn, rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }])) as {
    value?: { blockhash?: string };
  };
  const blockhash = result?.value?.blockhash;
  if (!blockhash) throw new SolanaError("RPC", "Solana RPC getLatestBlockhash returned no blockhash.");

  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions: [
      createAssociatedTokenAccountIdempotentInstruction(feePayer, destAta, destOwner, mint),
      createTransferCheckedInstruction(sourceAta, mint, destAta, kp.publicKey, BigInt(opts.requirement.maxAmountRequired), 6),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([kp]); // partial: the fee payer's slot stays empty for the facilitator

  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: opts.requirement.network,
      payload: { transaction: Buffer.from(tx.serialize()).toString("base64") },
    }),
  ).toString("base64");
}

export async function solanaUsdcBalance(opts: {
  address: string;
  mint?: string;
  rpcUrl?: string;
  fetchFn?: typeof fetch;
}): Promise<bigint> {
  const fetchFn = opts.fetchFn ?? fetch;
  const rpcUrl = opts.rpcUrl ?? SOLANA_RPC;
  const mint = opts.mint ?? USDC_SOLANA;
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(opts.address));
  const result = (await rpcCall(fetchFn, rpcUrl, "getAccountInfo", [
    ata.toBase58(),
    { encoding: "jsonParsed" },
  ])) as { value?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } | null } | null };
  const amount = result?.value?.data?.parsed?.info?.tokenAmount?.amount;
  return amount ? BigInt(amount) : 0n;
}
