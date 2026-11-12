import { BigNumber, BSM, PrivateKey, Signature, Utils } from "@bsv/sdk";
import { existsSync } from "node:fs";
import { loadVault, vaultPaths } from "./vault";

/**
 * Sign-to-auth: agents prove control of the vault address WITHOUT moving funds.
 * Domain-separated from every other Dogfood/Gryd signature surface so an auth
 * signature can never replay as a payment, a Locus signed write, or an
 * attestation. Verification is keyless — any service can check it.
 */
export const AUTH_PREFIX = "Dogfood Auth v1\n";
/** Challenges are nonces/tickets, not documents. Bound the signed blob. */
export const MAX_AUTH_MESSAGE_BYTES = 4096;

export interface AuthSignature {
  address: string;
  pubkey: string;
  message: string;
  signature: string; // compact-recoverable BSM, base64
}

function invalid(message: string): never {
  throw new Error("Invalid auth: " + message);
}

/** Single-line UTF-8 challenge text: non-empty, bounded, no control chars. */
function validMessage(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    Buffer.byteLength(v, "utf8") <= MAX_AUTH_MESSAGE_BYTES &&
    Buffer.from(v).toString("utf8") === v &&
    !/[\x00-\x1f\x7f]/.test(v)
  );
}

export function canonicalAuthMessage(message: unknown): string {
  if (!validMessage(message)) invalid("message must be 1.." + MAX_AUTH_MESSAGE_BYTES + " single-line UTF-8 bytes");
  return AUTH_PREFIX + message;
}

function validMainnetP2pkh(address: unknown): address is string {
  if (typeof address !== "string") return false;
  try {
    const decoded = Utils.fromBase58Check(address);
    return decoded.prefix.length === 1 && decoded.prefix[0] === 0 && decoded.data.length === 20;
  } catch {
    return false;
  }
}

export function signAuthMessage(key: PrivateKey, message: unknown): AuthSignature {
  const canonical = canonicalAuthMessage(message);
  return {
    address: key.toAddress(),
    pubkey: key.toPublicKey().toString(),
    message: message as string,
    signature: BSM.sign(Utils.toArray(canonical, "utf8"), key, "base64") as string,
  };
}

/**
 * Strict verification of a third party's claimed auth signature.
 * Recovers the pubkey from the compact signature and binds it to the claimed
 * vault address — the wire shape needs no pubkey. Throws on ANY mismatch.
 */
export function verifyAuthMessage(value: unknown): { address: string; pubkey: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("object required");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "address,message,signature" && keys !== "address,message,pubkey,signature") {
    invalid("exact fields required: address, message, signature (pubkey optional)");
  }
  const v = value as Record<string, unknown>;
  if (keys.includes("pubkey") && (typeof v.pubkey !== "string" || !/^(02|03)[a-f0-9]{64}$/.test(v.pubkey))) {
    invalid("public key encoding");
  }
  if (!validMainnetP2pkh(v.address)) invalid("mainnet P2PKH address");
  const canonical = canonicalAuthMessage(v.message);
  if (typeof v.signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.signature)) invalid("signature encoding");
  const bytes = Buffer.from(v.signature, "base64");
  if (bytes.length !== 65 || bytes.toString("base64") !== v.signature) invalid("compact 65-byte signature");
  if (bytes[0]! < 31 || bytes[0]! > 34) invalid("compact compressed BSM");
  const message = Utils.toArray(canonical, "utf8");
  const signature = Signature.fromCompact(v.signature, "base64");
  const pubkey = signature.RecoverPublicKey(bytes[0]! - 31, new BigNumber(BSM.magicHash(message)));
  if (pubkey.toAddress() !== v.address) invalid("signature does not match address");
  if (typeof v.pubkey === "string" && pubkey.toString() !== v.pubkey) invalid("pubkey does not match signature");
  if (!BSM.verify(message, signature, pubkey)) invalid("signature");
  return { address: v.address as string, pubkey: pubkey.toString() };
}

/**
 * Vault-side signing. Killfile gates BEFORE key access: STOP_SPENDING freezes
 * all agent activity including auth. Caps/allowlist do NOT apply — no funds move.
 */
export function signVaultAuth(root: string, message: unknown): AuthSignature {
  if (existsSync(vaultPaths(root).kill)) {
    throw new Error("KILLED: STOP_SPENDING present — a human must delete it to resume");
  }
  return signAuthMessage(loadVault(root).key, message);
}
