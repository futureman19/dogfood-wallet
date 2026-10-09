import { ed25519 } from "@noble/curves/ed25519";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { PrivateKey } from "@bsv/sdk";
import { createMemoryReplayStore, type ReplayStore } from "./replay-store";
import { rpcForSolanaNetwork, USDC_SOLANA, USDC_SOLANA_DEVNET } from "./solana";

// Merchant-side Solana: verify and settle x402 `exact` payments ourselves.
// We are the fee payer (LOCAL self-facilitation — the ed25519 key derived
// from the vault key never leaves this machine). The payer must have signed;
// we co-sign as fee payer and submit. Fail-closed at every step.

export class SolanaMerchantError extends Error {
  kind: "INVALID" | "SETTLE";
  constructor(kind: "INVALID" | "SETTLE", message: string) {
    super(message);
    this.name = "SolanaMerchantError";
    this.kind = kind;
  }
}
const invalid = (m: string) => new SolanaMerchantError("INVALID", m);
const settleFail = (m: string) => new SolanaMerchantError("SETTLE", m);

export type SolanaMerchantConfig = {
  solanaPayTo?: string;
  solanaNetwork?: string;
  solanaFeePayerKey?: PrivateKey;
  solanaRpcUrl?: string;
  fetchFn?: typeof fetch;
  replayStore?: ReplayStore;
  priceBaseUnits: number;
  /** Confirmation polling after submit (default 6 tries × 2s). Tests pass 0s. */
  solanaConfirmTries?: number;
  solanaConfirmDelayMs?: number;
};

function keypairFromKey(key: PrivateKey): Keypair {
  return Keypair.fromSeed(new Uint8Array(Buffer.from(key.toHex().padStart(64, "0"), "hex")));
}

export function mintForSolanaNetwork(network: string): string {
  return network === "solana" ? USDC_SOLANA : USDC_SOLANA_DEVNET;
}

export function createSolanaMerchant(cfg: SolanaMerchantConfig) {
  if (!cfg.solanaPayTo || !cfg.solanaFeePayerKey) return undefined;
  const network = cfg.solanaNetwork ?? "solana-devnet";
  if (network !== "solana" && network !== "solana-devnet") throw new Error("solanaNetwork must be solana or solana-devnet");
  const kp = keypairFromKey(cfg.solanaFeePayerKey);
  const feePayer = kp.publicKey.toBase58();
  if (cfg.solanaPayTo !== feePayer) {
    // v1: the fee payer and payee are the same vault identity (self-facilitation).
    throw new Error("Solana self-facilitation requires solanaPayTo == derived feePayer address");
  }
  const mint = mintForSolanaNetwork(network);
  const ourAta = getAssociatedTokenAddressSync(new PublicKey(mint), kp.publicKey).toBase58();
  const rpcUrl = cfg.solanaRpcUrl ?? rpcForSolanaNetwork(network);
  const fetchFn = cfg.fetchFn ?? globalThis.fetch.bind(globalThis);
  const store = cfg.replayStore ?? createMemoryReplayStore();

  const requirement = {
    scheme: "exact",
    network,
    maxAmountRequired: String(cfg.priceBaseUnits),
    payTo: cfg.solanaPayTo,
    asset: mint,
    maxTimeoutSeconds: 60,
    extra: { feePayer },
  } as const;

  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`Solana RPC ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`Solana RPC ${method}: ${body.error.message ?? "unknown"}`);
    return body.result;
  }

  async function settle(headerBase64: string): Promise<string> {
    let decoded: { scheme?: string; network?: string; payload?: { transaction?: string } };
    try {
      decoded = JSON.parse(Buffer.from(headerBase64, "base64").toString("utf8"));
    } catch {
      throw invalid("bad X-PAYMENT encoding");
    }
    if (decoded.scheme !== "exact" || decoded.network !== network || typeof decoded.payload?.transaction !== "string") {
      throw invalid("X-PAYMENT is not an exact solana payment for this network");
    }
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(decoded.payload.transaction, "base64"));
    } catch {
      throw invalid("invalid transaction encoding");
    }
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    if (keys[0] !== feePayer) throw invalid("fee payer must be this merchant");
    if (tx.message.numRequiredSignatures > tx.signatures.length) throw invalid("malformed signature table");

    // Find the USDC transferChecked to our ATA with the exact price.
    let authorityIdx = -1;
    let matched = false;
    for (const ix of tx.message.compiledInstructions) {
      const programId = keys[ix.programIdIndex];
      if (programId !== TOKEN_PROGRAM_ID.toBase58()) continue;
      const data = Buffer.from(ix.data);
      if (data[0] !== 12 || data.length < 10) continue; // TransferChecked
      const [sourceIdx, mintIdx, destIdx, ownerIdx] = ix.accountKeyIndexes;
      if (keys[mintIdx] !== mint) throw invalid("wrong token mint");
      if (keys[destIdx] !== ourAta) throw invalid("wrong destination token account");
      const amount = data.readBigUInt64LE(1);
      if (amount !== BigInt(cfg.priceBaseUnits)) throw invalid("payment amount mismatch");
      if (data[9] !== 6) throw invalid("wrong token decimals");
      authorityIdx = ownerIdx;
      matched = true;
    }
    if (!matched) throw invalid("no USDC transfer to this merchant found");
    if (authorityIdx < 0 || authorityIdx >= tx.message.numRequiredSignatures) throw invalid("payer must be a signer");

    // The payer's signature must be present and valid over the message.
    const payerSig = tx.signatures[authorityIdx];
    if (!payerSig || payerSig.every((b) => b === 0)) throw invalid("missing payer signature");
    const msgBytes = tx.message.serialize();
    const sigOk = ed25519.verify(payerSig, msgBytes, new Uint8Array(new PublicKey(keys[authorityIdx]).toBytes()));
    if (!sigOk) throw invalid("invalid payer signature");

    // Idempotency: the payer's signature uniquely identifies this payment.
    const replayKey = `sol:${Buffer.from(payerSig).toString("hex")}`;
    if (store.has(replayKey, [])) throw invalid("Solana payment replay: signature already used");
    store.reserve(replayKey, []);

    // Co-sign as fee payer and submit, then poll for confirmation — a single
    // immediate status check races Solana's confirmation ("pending" != failed).
    tx.sign([kp]);
    let signature: string;
    try {
      signature = (await rpc("sendTransaction", [
        Buffer.from(tx.serialize()).toString("base64"),
        { encoding: "base64", preflightCommitment: "confirmed" },
      ])) as string;
    } catch (err) {
      throw settleFail(err instanceof Error ? err.message : "submit failed");
    }
    const tries = cfg.solanaConfirmTries ?? 6;
    const delay = cfg.solanaConfirmDelayMs ?? 2000;
    let st: { confirmationStatus?: string; err?: unknown } | null | undefined;
    for (let i = 0; i < tries; i++) {
      let status: { value?: ({ confirmationStatus?: string; err?: unknown } | null)[] };
      try {
        status = (await rpc("getSignatureStatuses", [[signature]])) as typeof status;
      } catch (err) {
        throw settleFail(err instanceof Error ? err.message : "status check failed");
      }
      st = status?.value?.[0];
      if (st?.err) break;
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) break;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delay));
    }
    if (!st || st.err || !(st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      throw settleFail(`transaction not confirmed: ${JSON.stringify(st?.err ?? st?.confirmationStatus ?? "pending")}`);
    }
    return signature;
  }

  return { requirement, settle };
}
