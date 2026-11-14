// osp.ts — Open and Shut Protocol door ownership inside the Dogfood vault.
// The vault's derived dogfood/osp/v1 subkey is the door OWNER: door tips lock
// to it, grants/revokes are signed with it, and funding + change ride the
// main vault address (never the tip script — OSP-0001 ambiguity rule).
//
// Discipline mirrors btc.ts/gryd-mint: policy gate BEFORE signing, payment
// guard reservation BEFORE key exposure, fsynced evidence BEFORE broadcast,
// ambiguous broadcast acknowledgement = HOLD, never retry. The envelope/scope
// bytes are byte-pinned to the audited upstream vectors (testdata/osp-vectors.json).

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { P2PKH, PrivateKey, Script, Transaction } from "@bsv/sdk";
import { loadUsage, loadVault, vaultPaths } from "./vault";
import { estimateFee, evaluateOspTransition } from "./policy";
import { loadPolicyEnvelope, gateAgentSend } from "./brc181";
import { withPaymentGuard } from "./payment-guard";
import { treasuryEvidence } from "./utxo-treasury";
import { defaultBroadcast, defaultFetchTxHex, defaultFetchUtxos, type Utxo } from "./send";
import { buildEnvelopeScript, bytesToHex, encodeGrant, encodeRevoke, hexToBytes, reverseHexBytes, validatePub } from "./osp-envelope";
import { canonicalScope, jcs, scopeHashHex, scopePayment } from "./osp-scope";
import { ospAddress, ospKey, ospTipScriptHex } from "./osp-address";

export const OSP_DEFAULT_EXPIRY = 1_000_000;
export const OSP_DEFAULT_EGRESS = 65_536;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export type OspDoor = {
  version: 1;
  name: string;
  genesisDisplayTxid: string;
  tipScriptHex: string;
  ownerAddress: string;
  tip: { txid: string; vout: number } | null;
  status: "open" | "closed";
  seen: string[]; // consumed transition txids (display order), genesis first
  createdAt: string;
};

function doorsDir(root: string): string {
  return vaultPaths(root).ospDoors;
}
function doorPath(root: string, name: string): string {
  if (!NAME_RE.test(name)) throw new Error("Invalid door name: 1-32 chars of [a-z0-9-], starting alphanumeric");
  return join(doorsDir(root), `${name}.json`);
}
function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
export function loadOspDoor(root: string, name: string): OspDoor {
  const path = doorPath(root, name);
  if (!existsSync(path)) throw new Error("Unknown OSP door: " + name);
  const d = JSON.parse(readFileSync(path, "utf8")) as OspDoor;
  if (d.version !== 1 || d.name !== name || !/^[0-9a-f]{64}$/.test(d.genesisDisplayTxid)) {
    throw new Error("Corrupt OSP door file: " + name);
  }
  return d;
}
export function listOspDoors(root: string): OspDoor[] {
  const dir = doorsDir(root);
  if (!existsSync(dir)) return [];
  const out: OspDoor[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(loadOspDoor(root, f.replace(/\.json$/, "")));
    } catch {
      /* torn/foreign files never block the list */
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Smallest-first funding from the main vault, each source tx verified (send.ts doctrine). */
async function fundFromVault(
  root: string,
  vaultAddress: string,
  vaultScriptHex: string,
  needSats: number,
  fetchFn: typeof fetch,
): Promise<{ inputs: Utxo[]; sources: Transaction[]; total: number }> {
  const rows = await defaultFetchUtxos(vaultAddress, fetchFn);
  const outpoints = new Set<string>();
  const valid: Utxo[] = [];
  for (const u of rows) {
    const id = `${u.tx_hash}.${u.tx_pos}`;
    if (!/^[0-9a-f]{64}$/.test(u.tx_hash) || !Number.isSafeInteger(u.tx_pos) || u.tx_pos < 0
      || !Number.isSafeInteger(u.value) || u.value <= 0 || outpoints.has(id)) {
      throw new Error("Invalid OSP funding source metadata");
    }
    outpoints.add(id);
    valid.push(u);
  }
  valid.sort((a, b) => a.value - b.value);
  const inputs: Utxo[] = [];
  const sources: Transaction[] = [];
  let total = 0;
  for (const u of valid) {
    const hex = await defaultFetchTxHex(u.tx_hash, fetchFn);
    const source = Transaction.fromHex(hex);
    const output = source.outputs[u.tx_pos];
    if (source.id("hex") !== u.tx_hash || !output || output.satoshis !== u.value
      || output.lockingScript.toHex() !== vaultScriptHex) {
      throw new Error("Invalid OSP funding source transaction");
    }
    inputs.push(u);
    sources.push(source);
    total += u.value;
    if (total >= needSats + estimateFee(inputs.length + 1, 4)) break;
  }
  if (total < needSats + estimateFee(inputs.length + 1, 2)) {
    throw new Error(`REJECTED: Insufficient vault funds for OSP transition (${total} sats available).`);
  }
  return { inputs, sources, total };
}

async function tipLive(ownerAddress: string, tip: { txid: string; vout: number }, fetchFn: typeof fetch): Promise<boolean> {
  const rows = await defaultFetchUtxos(ownerAddress, fetchFn);
  return rows.some((u) => u.tx_hash === tip.txid && u.tx_pos === tip.vout);
}

/** Human-only: create a new door — genesis tip (1 sat) at the OSP subkey address. */
export async function doorInit(opts: {
  root: string;
  name: string;
  fetchFn?: typeof fetch;
}): Promise<{ txid: string; doorIdInternalHex: string; registration: { genesisDisplayTxid: string; tipLockingScriptHex: string } }> {
  const { root, name } = opts;
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  doorPath(root, name); // validates the name
  if (existsSync(doorPath(root, name))) throw new Error("OSP door already exists: " + name);
  return withPaymentGuard(root, "osp-door-init", async (guard) => {
    const vault = loadVault(root);
    // Fail fast BEFORE any network access: DISABLED / KILL never reach the chain.
    const pre = evaluateOspTransition(vault.policy.osp, vault.policy.killfileOn, 0, loadUsage(root, new Date(), "osp"));
    if (!pre.ok) throw new Error(pre.message);
    const owner = ospAddress(vault.key);
    const tipScriptHex = ospTipScriptHex(vault.key);
    const vaultScriptHex = new P2PKH().lock(vault.address).toHex();

    const need = 1; // the tip itself; fee added by the selector
    const funded = await fundFromVault(root, vault.address, vaultScriptHex, need, fetchFn);
    const fee = estimateFee(funded.inputs.length, 2);
    const change = funded.total - need - fee;
    if (change < 0) throw new Error("REJECTED: Insufficient vault funds for OSP door genesis.");

    const gate = evaluateOspTransition(vault.policy.osp, vault.policy.killfileOn, fee, loadUsage(root, new Date(), "osp"));
    if (!gate.ok) throw new Error(gate.message);

    const tx = new Transaction();
    for (let i = 0; i < funded.inputs.length; i++) {
      tx.addInput({
        sourceTransaction: funded.sources[i]!,
        sourceTXID: funded.inputs[i]!.tx_hash,
        sourceOutputIndex: funded.inputs[i]!.tx_pos,
        unlockingScriptTemplate: new P2PKH().unlock(vault.key),
      });
    }
    tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex(tipScriptHex) });
    if (change > 1) tx.addOutput({ satoshis: change, lockingScript: Script.fromHex(vaultScriptHex) });

    // Fresh funding liveness immediately pre-sign.
    const fresh = await defaultFetchUtxos(vault.address, fetchFn);
    for (const u of funded.inputs) {
      if (!fresh.some((r) => r.tx_hash === u.tx_hash && r.tx_pos === u.tx_pos && r.value === u.value)) {
        throw new Error("OSP funding spent or changed");
      }
    }
    guard.reserve({ asset: "bsv", amount: 0, to: tipScriptHex, fee });
    await tx.sign();
    const rawTx = tx.toHex();
    const txid = tx.id("hex");
    treasuryEvidence(root, "osp", guard.id, {
      version: 1, operation: "osp-door-init", paymentId: guard.id, name, ownerAddress: owner,
      tipScriptHex, fee, inputs: funded.inputs, change, txid, rawTx,
    });
    const { txid: ack } = await defaultBroadcast(rawTx, fetchFn);
    if (ack !== txid) throw new Error("Ambiguous broadcast acknowledgement; HOLD retained, never retry");

    const door: OspDoor = {
      version: 1, name, genesisDisplayTxid: txid, tipScriptHex, ownerAddress: owner,
      tip: { txid, vout: 0 }, status: "open", seen: [txid], createdAt: new Date().toISOString(),
    };
    mkdirSync(doorsDir(root), { recursive: true, mode: 0o700 });
    writeJsonAtomic(doorPath(root, name), door);
    guard.log({ t: new Date().toISOString(), asset: "bsv", kind: "osp-door-init", to: tipScriptHex, amount: 0, fee, txid, door: name });
    return {
      txid,
      doorIdInternalHex: reverseHexBytes(txid),
      registration: { genesisDisplayTxid: txid, tipLockingScriptHex: tipScriptHex },
    };
  });
}

/** Human-only (direct or via an approved request): sign + broadcast a door grant. */
export async function signOspGrant(opts: {
  root: string;
  door: string;
  scopeCanonical: string;
  expiryHeight?: number;
  maxEgressBytes?: number;
  sessionPubHex?: string;
  fetchFn?: typeof fetch;
}): Promise<{ txid: string; paymentSats: number; fee: number; sessionPubHex: string }> {
  const { root } = opts;
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const expiryHeight = opts.expiryHeight ?? OSP_DEFAULT_EXPIRY;
  const maxEgressBytes = opts.maxEgressBytes ?? OSP_DEFAULT_EGRESS;
  if (!Number.isSafeInteger(expiryHeight) || expiryHeight < 1 || expiryHeight > 0xffffffff) {
    throw new Error("Invalid expiryHeight");
  }
  if (!Number.isSafeInteger(maxEgressBytes) || maxEgressBytes < 1) throw new Error("Invalid maxEgressBytes");

  // Scope validation happens BEFORE any key or chain access — the bytes are the ask.
  const scopeObj = canonicalScope(opts.scopeCanonical);
  const payment = scopePayment(scopeObj);

  return withPaymentGuard(root, "osp-grant", async (guard) => {
    const vault = loadVault(root);
    const pre = evaluateOspTransition(vault.policy.osp, vault.policy.killfileOn, 0, loadUsage(root, new Date(), "osp"));
    if (!pre.ok) throw new Error(pre.message);
    const owner = ospAddress(vault.key);
    const door = loadOspDoor(root, opts.door);
    if (door.status !== "open" || !door.tip) throw new Error("OSP door is permanently closed: " + opts.door);
    if (door.ownerAddress !== owner) throw new Error("OSP door belongs to a different vault key");
    const tipScript = Script.fromHex(door.tipScriptHex);
    const vaultScriptHex = new P2PKH().lock(vault.address).toHex();
    if (payment && (payment.script === door.tipScriptHex || payment.script === vaultScriptHex)) {
      throw new Error("REJECTED: OSP-0005 payment must not target the tip or change script (output-count ambiguity).");
    }

    // Session key: the requester's pubkey, or an ephemeral one for direct grants.
    let sessionPub: Uint8Array;
    let sessionPubHex: string;
    if (opts.sessionPubHex !== undefined) {
      sessionPub = hexToBytes(opts.sessionPubHex);
      validatePub(sessionPub);
      sessionPubHex = bytesToHex(sessionPub);
    } else {
      sessionPub = Uint8Array.from(PrivateKey.fromRandom().toPublicKey().encode(true) as number[]);
      sessionPubHex = bytesToHex(sessionPub);
    }

    const paymentSats = payment ? payment.amount_sats : 0;
    const need = paymentSats;
    const funded = await fundFromVault(root, vault.address, vaultScriptHex, need, fetchFn);

    const envelope = encodeGrant({
      doorId: hexToBytes(reverseHexBytes(door.genesisDisplayTxid)),
      expiryHeight,
      maxEgress: maxEgressBytes,
      scopeHash: hexToBytes(scopeHashHex(opts.scopeCanonical)),
      sessionPub,
    });
    const envScript = Script.fromHex(bytesToHex(buildEnvelopeScript(envelope)));

    const outCount = 1 + (payment ? 1 : 0) + 1 + 1; // continuation + payment? + envelope + change
    const inCount = 1 + funded.inputs.length;
    // send.ts doctrine: fee assumes the change output; ≤1 sat change folds in.
    let fee = estimateFee(inCount, outCount);
    let change = funded.total - paymentSats - fee;
    if (change < 0) throw new Error("REJECTED: Insufficient vault funds for OSP grant.");
    if (change <= 1) {
      fee += change;
      change = 0;
    }

    const gate = evaluateOspTransition(vault.policy.osp, vault.policy.killfileOn, paymentSats + fee, loadUsage(root, new Date(), "osp"));
    if (!gate.ok) throw new Error(gate.message);
    if (payment) {
      const loaded = loadPolicyEnvelope(vaultPaths(root).brc181);
      if (!loaded.ok) throw new Error(loaded.message);
      const d = gateAgentSend({
        envelope: loaded.envelope,
        lockingScriptHex: payment.script,
        amount: paymentSats,
        fee,
        spentTotal: loadUsage(root, new Date(), "brc181-bsv").spentLifetime,
      });
      if (!d.ok) throw new Error(d.message);
    }

    // Chain truth: the tracked tip must still be an unspent output at the owner address.
    if (!(await tipLive(owner, door.tip, fetchFn))) {
      throw new Error("OSP tip was spent externally (or never confirmed) — reconcile the door file manually; refusing to sign");
    }

    // Source-verify the tip's parent tx exactly like vault coins (send.ts
    // doctrine) — id, value and locking script must match the door file.
    const tipSourceHex = await defaultFetchTxHex(door.tip.txid, fetchFn);
    const tipSource = Transaction.fromHex(tipSourceHex);
    const tipOut = tipSource.outputs[door.tip.vout];
    if (tipSource.id("hex") !== door.tip.txid || !tipOut || tipOut.satoshis !== 1
      || tipOut.lockingScript.toHex() !== door.tipScriptHex) {
      throw new Error("Invalid OSP tip source transaction");
    }

    const tx = new Transaction();
    // input[0] MUST be the tip spend by the door-owner key (OSP-0001 §5 predicate).
    tx.addInput({
      sourceTransaction: tipSource,
      sourceTXID: door.tip.txid,
      sourceOutputIndex: door.tip.vout,
      unlockingScriptTemplate: new P2PKH().unlock(ospKey(vault.key)),
    });
    for (let i = 0; i < funded.inputs.length; i++) {
      tx.addInput({
        sourceTransaction: funded.sources[i]!,
        sourceTXID: funded.inputs[i]!.tx_hash,
        sourceOutputIndex: funded.inputs[i]!.tx_pos,
        unlockingScriptTemplate: new P2PKH().unlock(vault.key),
      });
    }
    tx.addOutput({ satoshis: 1, lockingScript: tipScript });
    if (payment) tx.addOutput({ satoshis: paymentSats, lockingScript: Script.fromHex(payment.script) });
    tx.addOutput({ satoshis: 0, lockingScript: envScript });
    if (change > 0) tx.addOutput({ satoshis: change, lockingScript: Script.fromHex(vaultScriptHex) });

    guard.reserve({ asset: "bsv", amount: paymentSats, to: door.tipScriptHex, fee });
    await tx.sign();
    const rawTx = tx.toHex();
    const txid = tx.id("hex");
    treasuryEvidence(root, "osp", guard.id, {
      version: 1, operation: "osp-grant", paymentId: guard.id, door: opts.door,
      scopeCanonical: opts.scopeCanonical, expiryHeight, maxEgressBytes,
      paymentSats, fee, inputs: [{ tip: door.tip }, ...funded.inputs], change, txid, rawTx,
    });
    // Post-signature, pre-broadcast liveness (cheap; fail-closed).
    if (!(await tipLive(owner, door.tip, fetchFn))) {
      throw new Error("OSP tip changed after signing; evidence retained, not broadcasting");
    }
    const { txid: ack } = await defaultBroadcast(rawTx, fetchFn);
    if (ack !== txid) throw new Error("Ambiguous broadcast acknowledgement; HOLD retained, never retry");

    const updated: OspDoor = { ...door, tip: { txid, vout: 0 }, seen: [...door.seen, txid] };
    writeJsonAtomic(doorPath(root, opts.door), updated);
    guard.log({ t: new Date().toISOString(), asset: "bsv", kind: "osp-grant", to: door.tipScriptHex, amount: paymentSats, fee, txid, door: opts.door });
    return { txid, paymentSats, fee, sessionPubHex };
  });
}

/** Human-only: revoke-close — permanently close the door on-chain. */
export async function revokeOspDoor(opts: {
  root: string;
  door: string;
  fetchFn?: typeof fetch;
}): Promise<{ txid: string; fee: number }> {
  const { root } = opts;
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  return withPaymentGuard(root, "osp-revoke", async (guard) => {
    const vault = loadVault(root);
    const pre = evaluateOspTransition(vault.policy.osp, vault.policy.killfileOn, 0, loadUsage(root, new Date(), "osp"));
    if (!pre.ok) throw new Error(pre.message);
    const owner = ospAddress(vault.key);
    const door = loadOspDoor(root, opts.door);
    if (door.status !== "open" || !door.tip) throw new Error("OSP door is already closed: " + opts.door);
    if (door.ownerAddress !== owner) throw new Error("OSP door belongs to a different vault key");
    const vaultScriptHex = new P2PKH().lock(vault.address).toHex();

    const funded = await fundFromVault(root, vault.address, vaultScriptHex, 0, fetchFn);
    const inCount = 1 + funded.inputs.length;
    let fee = estimateFee(inCount, 2); // envelope + change
    let change = funded.total - fee;
    if (change < 0) throw new Error("REJECTED: Insufficient vault funds for OSP revoke.");
    if (change <= 1) {
      fee += change;
      change = 0;
    }

    const gate = evaluateOspTransition(vault.policy.osp, vault.policy.killfileOn, fee, loadUsage(root, new Date(), "osp"));
    if (!gate.ok) throw new Error(gate.message);

    if (!(await tipLive(owner, door.tip, fetchFn))) {
      throw new Error("OSP tip was spent externally — reconcile the door file manually; refusing to sign");
    }

    const tipSourceHex = await defaultFetchTxHex(door.tip.txid, fetchFn);
    const tipSource = Transaction.fromHex(tipSourceHex);
    const tipOut = tipSource.outputs[door.tip.vout];
    if (tipSource.id("hex") !== door.tip.txid || !tipOut || tipOut.satoshis !== 1
      || tipOut.lockingScript.toHex() !== door.tipScriptHex) {
      throw new Error("Invalid OSP tip source transaction");
    }

    const envelope = encodeRevoke({ doorId: hexToBytes(reverseHexBytes(door.genesisDisplayTxid)), flag: 0 });
    const envScript = Script.fromHex(bytesToHex(buildEnvelopeScript(envelope)));

    const tx = new Transaction();
    tx.addInput({
      sourceTransaction: tipSource,
      sourceTXID: door.tip.txid,
      sourceOutputIndex: door.tip.vout,
      unlockingScriptTemplate: new P2PKH().unlock(ospKey(vault.key)),
    });
    for (let i = 0; i < funded.inputs.length; i++) {
      tx.addInput({
        sourceTransaction: funded.sources[i]!,
        sourceTXID: funded.inputs[i]!.tx_hash,
        sourceOutputIndex: funded.inputs[i]!.tx_pos,
        unlockingScriptTemplate: new P2PKH().unlock(vault.key),
      });
    }
    tx.addOutput({ satoshis: 0, lockingScript: envScript });
    if (change > 0) tx.addOutput({ satoshis: change, lockingScript: Script.fromHex(vaultScriptHex) });

    guard.reserve({ asset: "bsv", amount: 0, to: door.tipScriptHex, fee });
    await tx.sign();
    const rawTx = tx.toHex();
    const txid = tx.id("hex");
    treasuryEvidence(root, "osp", guard.id, {
      version: 1, operation: "osp-revoke", paymentId: guard.id, door: opts.door,
      fee, inputs: [{ tip: door.tip }, ...funded.inputs], change, txid, rawTx,
    });
    const { txid: ack } = await defaultBroadcast(rawTx, fetchFn);
    if (ack !== txid) throw new Error("Ambiguous broadcast acknowledgement; HOLD retained, never retry");

    const updated: OspDoor = { ...door, tip: null, status: "closed", seen: [...door.seen, txid] };
    writeJsonAtomic(doorPath(root, opts.door), updated);
    guard.log({ t: new Date().toISOString(), asset: "bsv", kind: "osp-revoke", to: door.tipScriptHex, amount: 0, fee, txid, door: opts.door });
    return { txid, fee };
  });
}

/** Re-canonicalize a scope object for CLI flag merges (the bytes are the ask). */
export function scopeCanonicalFrom(obj: Record<string, unknown>): string {
  return jcs(obj);
}
