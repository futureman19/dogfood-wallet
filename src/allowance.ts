import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Certificate, KeyDeriver, LockingScript, MasterCertificate, P2PKH, PrivateKey, ProtoWallet, Transaction, UnlockingScript } from "@bsv/sdk";
import { evaluateAllowanceFund, evaluateSweep, estimateFee, MAX_SPLIT_OUTPUTS } from "./policy";
import { defaultBroadcast, defaultFetchTxHex, defaultFetchUtxos, selectUtxos, type Utxo } from "./send";
import { loadUsage, loadVault, vaultPaths } from "./vault";

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

export function deriveAllowanceKeys(ownerRoot: PrivateKey, agentIdentityPubHex: string, allowanceId: string) {
  const agentIdentity = compressedPub(agentIdentityPubHex);
  const deriver = new KeyDeriver(ownerRoot);
  const protocol = AGENT_ALLOWANCE_PROTOCOL_ID;
  const ownerPub = deriver.derivePublicKey(protocol, allowanceId, agentIdentity, true);
  const agentPub = deriver.derivePublicKey(protocol, allowanceId, agentIdentity, false);
  const ownerPriv = deriver.derivePrivateKey(protocol, allowanceId, agentIdentity);
  return {
    ownerPubHex: compressedPub(ownerPub.toString()),
    agentPubHex: compressedPub(agentPub.toString()),
    ownerPriv,
  };
}

export type AllowanceCertificate = {
  type: string;
  serialNumber: string;
  subject: string;
  certifier: string;
  revocationOutpoint: string;
  fields: Record<string, string>;
  signature: string;
};

function toCoreCertificate(cert: MasterCertificate): AllowanceCertificate {
  if (!cert.signature) throw new Error("unsigned");
  return {
    type: cert.type,
    serialNumber: cert.serialNumber,
    subject: cert.subject,
    certifier: cert.certifier,
    revocationOutpoint: cert.revocationOutpoint,
    fields: { ...cert.fields },
    signature: cert.signature,
  };
}

export async function issueAllowanceCertificate(opts: {
  ownerRoot: PrivateKey;
  agentIdentityPubHex: string;
  allowanceId: string;
  purpose: string;
  revocationOutpoint: string;
  expiresAt?: string;
}): Promise<
  | { ok: true; certificate: AllowanceCertificate; masterKeyring: Record<string, string> }
  | InspectFail
> {
  try {
    const subject = compressedPub(opts.agentIdentityPubHex);
    const fields: Record<string, string> = {
      allowanceId: opts.allowanceId,
      purpose: opts.purpose,
    };
    if (opts.expiresAt) fields.expiresAt = opts.expiresAt;
    const wallet = new ProtoWallet(opts.ownerRoot);
    const issued = await MasterCertificate.issueCertificateForSubject(
      wallet,
      subject,
      fields,
      certificateType(),
      async () => opts.revocationOutpoint,
    );
    return {
      ok: true,
      certificate: toCoreCertificate(issued),
      masterKeyring: { ...issued.masterKeyring },
    };
  } catch {
    return { ok: false, code: "BAD_CERT", message: "REJECTED: Could not issue BRC-52 allowance certificate." };
  }
}

export async function inspectCertificate(
  raw: AllowanceCertificate,
  expected: { ownerIdentityKey: string; agentIdentityKey: string; revocationOutpoint: string },
): Promise<{ ok: true } | InspectFail> {
  if (raw.type !== certificateType()) {
    return { ok: false, code: "BAD_CERT", message: "REJECTED: Certificate type is not agent allowance." };
  }
  if (raw.subject.toLowerCase() !== compressedPub(expected.agentIdentityKey)) {
    return { ok: false, code: "BAD_CERT", message: "REJECTED: Certificate subject is not the agent identity." };
  }
  if (raw.certifier.toLowerCase() !== compressedPub(expected.ownerIdentityKey)) {
    return { ok: false, code: "BAD_CERT", message: "REJECTED: Certificate certifier is not the owner identity." };
  }
  if (raw.revocationOutpoint !== expected.revocationOutpoint) {
    return { ok: false, code: "BAD_CERT", message: "REJECTED: Certificate revocationOutpoint does not match." };
  }
  try {
    const ok = await Certificate.fromObject(raw).verify();
    if (!ok) return { ok: false, code: "BAD_CERT", message: "REJECTED: Certificate signature is invalid." };
    return { ok: true };
  } catch {
    return { ok: false, code: "BAD_CERT", message: "REJECTED: Certificate signature is invalid." };
  }
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

function unlockChecksig(privateKey: PrivateKey, suffixAsm?: "OP_0" | "OP_1") {
  return {
    sign: async (tx: Transaction, inputIndex: number) => {
      const inner = await new P2PKH().unlock(privateKey).sign(tx, inputIndex);
      const sig = inner.toASM().split(/\s+/)[0];
      return UnlockingScript.fromASM(suffixAsm ? `${sig} ${suffixAsm}` : sig);
    },
    estimateLength: async () => (suffixAsm ? 75 : 74),
  };
}

export type FundResult =
  | {
      ok: true;
      txid: string;
      amount: number;
      fee: number;
      rawHex: string;
      descriptor: Record<string, unknown>;
    }
  | { ok: false; code: string; message: string };

export async function fundAllowance(opts: {
  root: string;
  agentPubHex: string;
  amount: number;
  pieces?: number;
  purpose?: string;
  fetchUtxos?: (address: string) => Promise<Utxo[]>;
  fetchTxHex?: (txid: string) => Promise<string>;
  broadcast?: (raw: string) => Promise<{ txid: string }>;
}): Promise<FundResult> {
  const vault = loadVault(opts.root);
  const decision = evaluateAllowanceFund(vault.policy, opts.amount, loadUsage(opts.root));
  if (!decision.ok) return decision;

  let agentIdentity: string;
  let ownerIdentity: string;
  try {
    agentIdentity = compressedPub(opts.agentPubHex);
    ownerIdentity = compressedPub(vault.key.toPublicKey().toString());
  } catch {
    return { ok: false, code: "BAD_KEYS", message: "REJECTED: Agent pubkey must be compressed secp256k1 hex." };
  }

  const pieces = opts.pieces ?? 1;
  if (!Number.isInteger(pieces) || pieces < 1 || pieces > MAX_SPLIT_OUTPUTS || opts.amount < pieces) {
    return {
      ok: false,
      code: "BAD_AMOUNT",
      message: `REJECTED: Pieces must be 1..${MAX_SPLIT_OUTPUTS} and each at least 1 sat.`,
    };
  }

  const allowanceId = generateAllowanceId();
  const keys = deriveAllowanceKeys(vault.key, agentIdentity, allowanceId);

  const utxos = await (opts.fetchUtxos ?? defaultFetchUtxos)(vault.address);
  const need = opts.amount + 1;
  const { chosen, fee, total } = selectUtxos(utxos, need);
  const outCount = pieces + 2;
  const actualFee = estimateFee(Math.max(chosen.length, 1), outCount);
  if (chosen.length === 0 || total < need + actualFee) {
    return {
      ok: false,
      code: "INSUFFICIENT",
      message: `REJECTED: Insufficient funds (${total} sats available, need ${need + actualFee}).`,
    };
  }

  const fetchTxHex = opts.fetchTxHex ?? defaultFetchTxHex;
  const tx = new Transaction();
  for (const u of chosen) {
    const hex = await fetchTxHex(u.tx_hash);
    const source = Transaction.fromHex(hex);
    tx.addInput({
      sourceTransaction: source,
      sourceTXID: u.tx_hash,
      sourceOutputIndex: u.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(vault.key),
    });
  }

  const lock = LockingScript.fromHex(lockingScriptHex(keys.agentPubHex, keys.ownerPubHex));
  const base = Math.floor(opts.amount / pieces);
  const rem = opts.amount - base * pieces;
  for (let i = 0; i < pieces; i++) {
    tx.addOutput({ satoshis: base + (i < rem ? 1 : 0), lockingScript: lock });
  }
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(revocationScriptHex(keys.ownerPubHex)) });
  const change = total - opts.amount - 1 - actualFee;
  if (change > 1) {
    tx.addOutput({ satoshis: change, lockingScript: new P2PKH().lock(vault.address) });
  }
  await tx.sign();
  const rawHex = tx.toHex();
  const txid = tx.id("hex") as string;
  const revocationOutpoint = `${txid}.${pieces}`;
  const issued = await issueAllowanceCertificate({
    ownerRoot: vault.key,
    agentIdentityPubHex: agentIdentity,
    allowanceId,
    purpose: opts.purpose ?? "dogfood allowance",
    revocationOutpoint,
  });
  if (!issued.ok) return issued;
  await (opts.broadcast ?? defaultBroadcast)(rawHex);

  const outputs = Array.from({ length: pieces }, (_, i) => ({
    outpoint: `${txid}.${i}`,
    satoshis: base + (i < rem ? 1 : 0),
  }));
  const descriptor = {
    version: "1.0",
    allowanceId,
    purpose: opts.purpose ?? "dogfood allowance",
    ownerIdentityKey: ownerIdentity,
    agentIdentityKey: agentIdentity,
    protocolID: [...AGENT_ALLOWANCE_PROTOCOL_ID],
    outputs,
    revocationOutpoint,
    certificate: issued.certificate,
    masterKeyring: issued.masterKeyring,
  };
  writeFileSync(join(opts.root, "allowance.json"), `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o644 });
  const paths = vaultPaths(opts.root);
  appendFileSync(
    paths.log,
    `${JSON.stringify({
      t: new Date().toISOString(),
      txid,
      amount: opts.amount,
      fee: actualFee,
      note: "allowance-fund",
      kind: "allowance-fund",
    })}\n`,
  );
  return { ok: true, txid, amount: opts.amount, fee: actualFee, rawHex, descriptor };
}

export async function sweepAllowance(opts: {
  root: string;
  to?: string;
  fetchTxHex?: (txid: string) => Promise<string>;
  broadcast?: (raw: string) => Promise<{ txid: string }>;
}): Promise<FundResult> {
  const vault = loadVault(opts.root);
  const to = opts.to ?? vault.address;
  const dest = evaluateSweep(vault.policy, to);
  if (!dest.ok) return dest;
  const path = join(opts.root, "allowance.json");
  if (!existsSync(path)) {
    return { ok: false, code: "NEED_ALLOWANCE", message: "REJECTED: No allowance.json. Fund one first." };
  }
  const descriptor = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const inspected = inspectDescriptor(descriptor);
  if (!inspected.ok) return inspected;

  const fetchTxHex = opts.fetchTxHex ?? defaultFetchTxHex;
  const rec = descriptor as {
    outputs: Array<{ outpoint: string; satoshis: number }>;
    revocationOutpoint: string;
  };
  const points = [
    ...rec.outputs.map((o) => ({ ...parseOutpoint(o.outpoint), satoshis: o.satoshis, kind: "allowance" as const })),
    { ...parseOutpoint(rec.revocationOutpoint), satoshis: 1, kind: "revocation" as const },
  ];
  const total = points.reduce((s, p) => s + p.satoshis, 0);
  const fee = estimateFee(points.length, 1);
  if (total <= fee) {
    return {
      ok: false,
      code: "INSUFFICIENT",
      message: `REJECTED: Insufficient funds to sweep allowance (${total} sats, fee ${fee}).`,
    };
  }

  const keys = deriveAllowanceKeys(vault.key, inspected.agentIdentityKey, inspected.allowanceId);
  const tx = new Transaction();
  const hexCache = new Map<string, string>();
  for (const p of points) {
    let hex = hexCache.get(p.txid);
    if (!hex) {
      hex = await fetchTxHex(p.txid);
      hexCache.set(p.txid, hex);
    }
    const source = Transaction.fromHex(hex);
    tx.addInput({
      sourceTransaction: source,
      sourceTXID: p.txid,
      sourceOutputIndex: p.vout,
      unlockingScriptTemplate:
        p.kind === "allowance" ? unlockChecksig(keys.ownerPriv, "OP_0") : unlockChecksig(keys.ownerPriv),
    });
  }
  tx.addOutput({ satoshis: total - fee, lockingScript: new P2PKH().lock(to) });
  await tx.sign();
  const rawHex = tx.toHex();
  const { txid } = await (opts.broadcast ?? defaultBroadcast)(rawHex);
  const paths = vaultPaths(opts.root);
  appendFileSync(
    paths.log,
    `${JSON.stringify({
      t: new Date().toISOString(),
      txid,
      to,
      amount: total - fee,
      fee,
      note: "allowance-sweep",
      kind: "allowance-sweep",
    })}\n`,
  );
  return { ok: true, txid, amount: total - fee, fee, rawHex, descriptor: rec };
}

function parseOutpoint(outpoint: string): { txid: string; vout: number } {
  const [txid, v] = outpoint.split(".");
  return { txid, vout: Number(v) };
}
