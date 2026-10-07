import { createHash, randomBytes } from "node:crypto";
import { LockingScript } from "@bsv/sdk";

export const AGENT_ALLOWANCE_PROTOCOL_ID = [2, "agent allowance"] as const;

export type InspectOk = {
  ok: true;
  allowanceId: string;
  purpose: string | null;
  ownerIdentityKey: string;
  agentIdentityKey: string;
  totalSats: number;
  outputCount: number;
  revocationOutpoint: string;
};

export type InspectFail = { ok: false; code: string; message: string };

const COMPRESSED = /^(02|03)[0-9a-f]{64}$/i;
const OUTPOINT = /^[0-9a-f]{64}\.\d+$/i;

export function certificateType(): string {
  return createHash("sha256").update("agent allowance").digest("base64");
}

export function generateAllowanceId(): string {
  return randomBytes(16).toString("base64");
}

function compressedPub(hex: string): string {
  const h = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!COMPRESSED.test(h)) throw new Error("BAD_PUBKEY");
  return h;
}

export function lockingScriptHex(agentPubHex: string, ownerPubHex: string): string {
  const agent = compressedPub(agentPubHex);
  const owner = compressedPub(ownerPubHex);
  return LockingScript.fromASM(`OP_IF ${agent} OP_CHECKSIG OP_ELSE ${owner} OP_CHECKSIG OP_ENDIF`).toHex();
}

export function revocationScriptHex(ownerPubHex: string): string {
  const owner = compressedPub(ownerPubHex);
  return LockingScript.fromASM(`${owner} OP_CHECKSIG`).toHex();
}

export function unlockingAsm(branch: "agent" | "owner", signatureHex: string): string {
  return `${signatureHex} ${branch === "agent" ? "OP_1" : "OP_0"}`;
}

export function parseAllowanceLock(
  hex: string,
): { ok: true; agentPubHex: string; ownerPubHex: string } | InspectFail {
  try {
    const parts = LockingScript.fromHex(hex).toASM().trim().split(/\s+/);
    if (
      parts.length !== 7 ||
      parts[0] !== "OP_IF" ||
      parts[2] !== "OP_CHECKSIG" ||
      parts[3] !== "OP_ELSE" ||
      parts[5] !== "OP_CHECKSIG" ||
      parts[6] !== "OP_ENDIF"
    ) {
      return { ok: false, code: "BAD_SCRIPT", message: "REJECTED: Not a BRC-0204 allowance lock." };
    }
    return { ok: true, agentPubHex: compressedPub(parts[1]), ownerPubHex: compressedPub(parts[4]) };
  } catch {
    return { ok: false, code: "BAD_SCRIPT", message: "REJECTED: Not a BRC-0204 allowance lock." };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function decodeAllowanceId(id: unknown): string | null {
  if (typeof id !== "string" || id.length === 0) return null;
  const bytes = Buffer.from(id, "base64");
  return bytes.length >= 16 ? id : null;
}

export function inspectDescriptor(raw: unknown): InspectOk | InspectFail {
  const d = asRecord(raw);
  if (!d) return { ok: false, code: "BAD_DESCRIPTOR", message: "REJECTED: Descriptor is not an object." };
  if (d.version !== "1.0") {
    return { ok: false, code: "BAD_VERSION", message: "REJECTED: Descriptor version must be 1.0." };
  }
  const allowanceId = decodeAllowanceId(d.allowanceId);
  if (!allowanceId) {
    return { ok: false, code: "BAD_ID", message: "REJECTED: allowanceId must be ≥16 random bytes, base64." };
  }
  const protocol = d.protocolID;
  if (
    !Array.isArray(protocol) ||
    protocol.length !== 2 ||
    protocol[0] !== 2 ||
    protocol[1] !== "agent allowance"
  ) {
    return { ok: false, code: "BAD_PROTOCOL", message: "REJECTED: protocolID must be [2, \"agent allowance\"]." };
  }
  let ownerIdentityKey: string;
  let agentIdentityKey: string;
  try {
    ownerIdentityKey = compressedPub(String(d.ownerIdentityKey ?? ""));
    agentIdentityKey = compressedPub(String(d.agentIdentityKey ?? ""));
  } catch {
    return { ok: false, code: "BAD_KEYS", message: "REJECTED: Identity keys must be compressed secp256k1 pubkeys." };
  }
  if (typeof d.revocationOutpoint !== "string" || !OUTPOINT.test(d.revocationOutpoint)) {
    return { ok: false, code: "BAD_REVOCATION", message: "REJECTED: revocationOutpoint is missing or not txid.vout." };
  }
  if (!Array.isArray(d.outputs) || d.outputs.length === 0) {
    return { ok: false, code: "BAD_OUTPUTS", message: "REJECTED: Descriptor needs at least one allowance output." };
  }
  let totalSats = 0;
  for (const item of d.outputs) {
    const o = asRecord(item);
    if (!o || typeof o.outpoint !== "string" || !OUTPOINT.test(o.outpoint)) {
      return { ok: false, code: "BAD_OUTPUTS", message: "REJECTED: Each output needs outpoint txid.vout." };
    }
    if (!Number.isInteger(o.satoshis) || (o.satoshis as number) < 1) {
      return { ok: false, code: "BAD_OUTPUTS", message: "REJECTED: Each output satoshis must be a positive integer." };
    }
    totalSats += o.satoshis as number;
  }
  return {
    ok: true,
    allowanceId,
    purpose: typeof d.purpose === "string" ? d.purpose : null,
    ownerIdentityKey,
    agentIdentityKey,
    totalSats,
    outputCount: d.outputs.length,
    revocationOutpoint: d.revocationOutpoint,
  };
}
