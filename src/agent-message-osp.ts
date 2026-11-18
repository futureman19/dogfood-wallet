// agent-message-osp.ts — S4: OSP typed messages (design §8).
//
// Two typed bodies ride the S2 guarded send rail:
//   osp.grant.request — an agent asks another agent's owner for a grant.
//   osp.grant.receipt — the owner's wallet points at the on-chain grant.
//
// The WIRE FORMAT was pinned by the S1 codec (agent-message.ts): typed
// bodies are JSON OBJECTS. A grant request carries {scope, doorGenesisTxid,
// doorOwnerAddress, reason, sessionPubHex} with optional {expiryHeight,
// maxEgressBytes}; a receipt is exactly {grantTxid, scopeHash,
// doorGenesisTxid}. This module adds filing-parity validation and the
// on-chain receipt check around that pinned format — not a new format.
//
// Doctrine:
//   - Validation parity: bodies are checked with the SAME rules requests.ts
//     applies at filing (canonical JCS scope, salt, wallet P2PKH payment
//     restriction, bounds, reason rules) BEFORE any key or chain access.
//     Where the codec is looser than filing (e.g. expiryHeight 0), the
//     filing rule wins here: anything parseable must be filable.
//   - The scope travels BYTE-PINNED; nothing here rewrites it.
//   - Filing stays an explicit agent action (fileRequest): this module only
//     parses, matches and maps — it never auto-files or approves.
//   - Receipts are pointers. The chain is the truth: verifyGrantReceipt
//     fetches the grant tx and checks the envelope, never trusts the body.
//   - Keyless: no vault, no signing, no broadcast anywhere in this module.

import { Transaction } from "@bsv/sdk";
import { canonicalScope, scopeHashHex, scopePayment } from "./osp-scope";
import { strictP2pkhAddress } from "./osp-address";
import { bytesToHex, decode, hexToBytes, reverseHexBytes, type OspEnvelope } from "./osp-envelope";
import { defaultFetchTxHex } from "./send";

const TXID_RE = /^[0-9a-f]{64}$/;
const PUB33_RE = /^(02|03)[0-9a-f]{64}$/; // same profile as the S1 codec
const MAX_SCOPE_BYTES = 4096;
const MAX_REASON_BYTES = 280;

/** Wire shape pinned by the S1 codec (scope is the canonical JSON string). */
export type GrantRequestBody = {
  scope: string;
  doorGenesisTxid: string;
  doorOwnerAddress: string;
  reason: string;
  sessionPubHex: string;
  expiryHeight?: number;
  maxEgressBytes?: number;
};

export type GrantReceiptBody = {
  grantTxid: string;
  scopeHash: string;
  doorGenesisTxid: string;
};

function fail(m: string): never {
  throw new Error(m);
}

/** Typed bodies arrive as objects (inbox) or JSON text (CLI/MCP). */
function parseObject(body: unknown): Record<string, unknown> {
  let parsed: unknown = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      fail("body must be a JSON object");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function rejectUnknown(o: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`unknown field "${k}"`);
}

function txidField(v: unknown, name: string): string {
  if (typeof v !== "string" || !TXID_RE.test(v)) fail(`${name} must be 64 lowercase hex chars`);
  return v;
}

/** Parse + validate an osp.grant.request body with filing-parity rules. Throws. */
export function parseGrantRequestBody(body: unknown): GrantRequestBody {
  const o = parseObject(body);
  rejectUnknown(o, ["scope", "doorGenesisTxid", "doorOwnerAddress", "reason", "sessionPubHex", "expiryHeight", "maxEgressBytes"]);
  for (const k of ["scope", "doorGenesisTxid", "doorOwnerAddress", "reason", "sessionPubHex"]) {
    if (!(k in o)) fail(`missing required field "${k}"`);
  }
  const doorGenesisTxid = txidField(o.doorGenesisTxid, "doorGenesisTxid");
  if (!strictP2pkhAddress(o.doorOwnerAddress)) fail("doorOwnerAddress must be a mainnet P2PKH address");
  const doorOwnerAddress = o.doorOwnerAddress;
  if (typeof o.scope !== "string") fail("scope must be a canonical JSON string");
  const scopeBytes = new TextEncoder().encode(o.scope).length;
  if (scopeBytes === 0 || scopeBytes > MAX_SCOPE_BYTES) fail(`scope must be 1..${MAX_SCOPE_BYTES} bytes`);
  try {
    const scope = canonicalScope(o.scope); // canonical JCS + salt, exactly as at filing
    scopePayment(scope); // wallet P2PKH payment restriction, exactly as at filing
  } catch (e) {
    fail(`scope rejected: ${(e as Error).message}`);
  }
  if (typeof o.reason !== "string" || new TextEncoder().encode(o.reason).length > MAX_REASON_BYTES || /[\x00-\x1f\x7f]/.test(o.reason))
    fail("reason must be <= 280 bytes, single line, no control chars");
  if (typeof o.sessionPubHex !== "string" || !PUB33_RE.test(o.sessionPubHex)) fail("sessionPubHex must be a 33-byte compressed pubkey (02/03 prefix)");
  const out: GrantRequestBody = { scope: o.scope, doorGenesisTxid, doorOwnerAddress, reason: o.reason, sessionPubHex: o.sessionPubHex };
  // Filing bounds (requests.ts): the codec allows 0, filing does not — the
  // stricter filing rule wins so anything parseable is filable.
  if (o.expiryHeight !== undefined) {
    if (typeof o.expiryHeight !== "number" || !Number.isInteger(o.expiryHeight) || o.expiryHeight < 1 || o.expiryHeight > 0xffffffff)
      fail("expiryHeight must be an integer in [1, 2^32-1]");
    out.expiryHeight = o.expiryHeight;
  }
  if (o.maxEgressBytes !== undefined) {
    if (typeof o.maxEgressBytes !== "number" || !Number.isSafeInteger(o.maxEgressBytes) || o.maxEgressBytes < 1)
      fail("maxEgressBytes must be a positive safe integer");
    out.maxEgressBytes = o.maxEgressBytes;
  }
  return out;
}

/** Parse + validate an osp.grant.receipt body. Throws. */
export function parseGrantReceiptBody(body: unknown): GrantReceiptBody {
  const o = parseObject(body);
  rejectUnknown(o, ["grantTxid", "scopeHash", "doorGenesisTxid"]);
  return {
    grantTxid: txidField(o.grantTxid, "grantTxid"),
    scopeHash: txidField(o.scopeHash, "scopeHash"),
    doorGenesisTxid: txidField(o.doorGenesisTxid, "doorGenesisTxid"),
  };
}

/** The filing agent must match door identification against its OWN registry. */
export function matchDoor(req: GrantRequestBody, door: { genesisDisplayTxid: string; ownerAddress: string }): boolean {
  return req.doorGenesisTxid === door.genesisDisplayTxid && req.doorOwnerAddress === door.ownerAddress;
}

/** Map a validated request to a fileRequest input. Scope stays byte-pinned
 * (wire `scope` -> filing `scopeCanonical`). Filing itself remains the
 * explicit agent action — nothing auto-files. */
export function grantRequestToFilingInput(req: GrantRequestBody, door: string): {
  kind: "osp-grant";
  door: string;
  scopeCanonical: string;
  reason: string;
  sessionPubHex: string;
  expiryHeight?: number;
  maxEgressBytes?: number;
} {
  return {
    kind: "osp-grant",
    door,
    scopeCanonical: req.scope,
    reason: req.reason,
    sessionPubHex: req.sessionPubHex,
    ...(req.expiryHeight !== undefined ? { expiryHeight: req.expiryHeight } : {}),
    ...(req.maxEgressBytes !== undefined ? { maxEgressBytes: req.maxEgressBytes } : {}),
  };
}

export type GrantReceiptVerification =
  | { ok: true; txid: string; scopeHash: string; doorGenesisTxid: string; paymentSats: number }
  | { ok: false; reason: string };

/** Verify a receipt pointer ON-CHAIN. Keyless; every failure is a verdict,
 * never a throw-through trust. The receipt body is never trusted past its
 * role as a pointer: txid, scopeHash and door binding are checked against
 * the fetched transaction's actual envelope. With scopeCanonical supplied,
 * the hash must reproduce from those exact bytes AND any scope payment
 * output must be present in the tx. */
export async function verifyGrantReceipt(opts: {
  receipt: GrantReceiptBody;
  fetchTxHex?: (txid: string) => Promise<string>;
  scopeCanonical?: string;
}): Promise<GrantReceiptVerification> {
  const fetchTx = opts.fetchTxHex ?? ((txid: string) => defaultFetchTxHex(txid));
  let hex: string;
  try {
    hex = await fetchTx(opts.receipt.grantTxid);
  } catch {
    return { ok: false, reason: "grant tx fetch failed" };
  }
  let tx: Transaction;
  try {
    tx = Transaction.fromHex(hex);
  } catch {
    return { ok: false, reason: "grant tx unparsable" };
  }
  if (tx.id("hex") !== opts.receipt.grantTxid) return { ok: false, reason: "fetched tx does not match grantTxid" };

  // The grant envelope is the tx's 0-sat OP_RETURN output (OSP-0002):
  // framing is 006a + minimalPush(envelope). Parse the push header directly
  // — SDK chunk views fold the push bytes into OP_RETURN data. Only the
  // GRANT variant carries scope/session fields (revoke is skipped).
  let env: Extract<OspEnvelope, { type: "grant" }> | undefined;
  for (const o of tx.outputs) {
    const scriptHex = o.lockingScript.toHex();
    if (o.satoshis !== 0 || !scriptHex.startsWith("006a")) continue;
    const bytes = hexToBytes(scriptHex);
    const op = bytes[2];
    let data: Uint8Array | undefined;
    if (op === 0x4c && bytes.length >= 4) {
      const len = bytes[3]!;
      if (bytes.length >= 4 + len) data = bytes.slice(4, 4 + len);
    } else if (op !== undefined && op >= 0x01 && op <= 0x4b && bytes.length >= 3 + op) {
      data = bytes.slice(3, 3 + op);
    }
    if (!data) continue;
    try {
      const decoded = decode(data);
      if (decoded.type === "grant") { env = decoded; break; }
    } catch {
      continue; // not an OSP envelope (e.g. an agent-message OP_RETURN)
    }
  }
  if (!env) return { ok: false, reason: "no OSP grant envelope in tx" };
  if (bytesToHex(env.scopeHash) !== opts.receipt.scopeHash) return { ok: false, reason: "scopeHash mismatch" };
  if (bytesToHex(env.doorId) !== reverseHexBytes(opts.receipt.doorGenesisTxid)) return { ok: false, reason: "door genesis mismatch" };

  let paymentSats = 0;
  if (opts.scopeCanonical !== undefined) {
    let scope: Record<string, unknown>;
    try {
      scope = canonicalScope(opts.scopeCanonical);
    } catch {
      return { ok: false, reason: "scopeCanonical invalid" };
    }
    if (scopeHashHex(opts.scopeCanonical) !== opts.receipt.scopeHash)
      return { ok: false, reason: "scopeHash does not match scopeCanonical" };
    let payment: { amount_sats: number; script: string } | undefined;
    try {
      payment = scopePayment(scope);
    } catch {
      return { ok: false, reason: "scope payment terms malformed" };
    }
    if (payment) {
      const present = tx.outputs.some((o) => o.satoshis === payment!.amount_sats && o.lockingScript.toHex() === payment!.script);
      if (!present) return { ok: false, reason: "scope payment output missing from grant tx" };
      paymentSats = payment.amount_sats;
    }
  }
  return { ok: true, txid: tx.id("hex"), scopeHash: bytesToHex(env.scopeHash), doorGenesisTxid: opts.receipt.doorGenesisTxid, paymentSats };
}
