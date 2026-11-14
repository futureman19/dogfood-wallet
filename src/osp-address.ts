// osp-address.ts — the vault's OSP door-owner identity.
// Same self-ECDH derivation doctrine as the BTC/DOGE adapters: door tips are
// locked to a DERIVED subkey, never the raw vault key. Change from OSP
// transitions returns to the MAIN vault address, which is distinct from the
// tip script — satisfying the OSP-0001 change/continuation ambiguity rule.

import { P2PKH, Utils, type PrivateKey } from "@bsv/sdk";

export const OSP_DOMAIN = "dogfood/osp/v1";

/** Same SDK self-ECDH/Type42 derivation as btcKey; distinct invoice domain. */
export function ospKey(key: PrivateKey): PrivateKey {
  return key.deriveChild(key.toPublicKey(), OSP_DOMAIN);
}
export function ospAddress(key: PrivateKey): string {
  return ospKey(key).toAddress();
}
export function ospTipScriptHex(key: PrivateKey): string {
  return new P2PKH().lock(ospAddress(key)).toHex();
}

/** Strict mainnet P2PKH (SDK/test regexes also accept script-hash "3..." — refuse). */
export function strictP2pkhAddress(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const decoded = Utils.fromBase58Check(v);
    return decoded.prefix.length === 1 && decoded.prefix[0] === 0 && decoded.data.length === 20;
  } catch {
    return false;
  }
}
export function p2pkhScriptHex(address: string): string {
  if (!strictP2pkhAddress(address)) throw new Error("BAD_ADDRESS: mainnet P2PKH address required");
  return new P2PKH().lock(address).toHex();
}
