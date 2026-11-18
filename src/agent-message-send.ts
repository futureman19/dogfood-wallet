// Guarded agent-message send (agent messaging S2).
//
// Wires the S1 codec (agent-message.ts) into the SAME payment guard, policy
// engine, BRC-181 gate, and source-verification machinery as every other
// spend. A message is a BSV transaction: 1-sat inbox tip to the recipient,
// one OP_RETURN carrying the BitCom B|MAP|AIP envelope, optional change.
//
// Safety properties (all inherited from the shared rails):
// - policy.messages absent = DISABLED (fail-closed); killfile wins.
// - Daily message count cap + body byte cap + optional recipient allowlist.
// - BRC-181 fee-inclusive spend gate, pre (fee 0) and post (planned fee).
// - Previously paid inbox-tip outpoints are excluded from coin selection.
// - Shared guard lock + intent reservation; fsynced evidence BEFORE broadcast.
// - Killfile re-checked after signing, before the single broadcast attempt.
// - Ambiguous broadcast outcome = PAYMENT_HELD; never an automatic retry.
//
// Transport is injectable for tests; defaults are the live WoC/ARC paths.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { P2PKH, Script, Transaction } from "@bsv/sdk";
import { buildMessageScript, randomNonce, signEnvelope, type Envelope } from "./agent-message";
import { gateAgentSend, loadPolicyEnvelope } from "./brc181";
import { excludeInboxTips, loadInboxTips, markInboxTip } from "./inbox-tips";
import { inspectPaymentHold, PaymentHeldError, withPaymentGuard } from "./payment-guard";
import { evaluateMessageSend, messageCountFromLog } from "./policy";
import { defaultBroadcast, defaultFetchTxHex, defaultFetchUtxos, type Utxo } from "./send";
import { loadUsage, loadVault, vaultPaths } from "./vault";

const TIP_SATS = 1;

export type AgentMessageSendResult =
  | { ok: true; txid: string; to: string; tip: 1; fee: number; nonce: string; guardId: string; evidence: string }
  | { ok: false; code: string; message: string };

export type AgentMessageSendOptions = {
  root: string;
  to: string;
  body: string;
  /** S2 ships only type "message"; anything else is rejected. */
  type?: string;
  /** 32 lowercase hex chars; random when omitted. */
  nonce?: string;
  /** Unix seconds; derived from now() when omitted. */
  ts?: number;
  /** Injectable clock (ms) for deterministic tests. */
  now?: () => number;
  fetchUtxos?: (address: string) => Promise<Utxo[]>;
  fetchTxHex?: (txid: string) => Promise<string>;
  broadcast?: (rawTx: string) => Promise<{ txid: string }>;
};

function readLogLines(root: string): string[] {
  const path = vaultPaths(root).log;
  return existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
}

function writeEvidence(path: string, record: unknown): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(record, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export async function sendAgentMessage(opts: AgentMessageSendOptions): Promise<AgentMessageSendResult> {
  const { root, body } = opts;
  const now = opts.now ?? Date.now;
  const fetchUtxos = opts.fetchUtxos ?? defaultFetchUtxos;
  const fetchTxHex = opts.fetchTxHex ?? defaultFetchTxHex;
  const broadcast = opts.broadcast ?? defaultBroadcast;
  const held = inspectPaymentHold(root);
  if (held.blocked) return { ok: false, code: "PAYMENT_HELD", message: `An earlier payment is held (${held.pending}); reconcile it before sending.` };

  try {
  return await withPaymentGuard(root, "agent-message", async (guard): Promise<AgentMessageSendResult> => {
    const vault = loadVault(root);
    const type = opts.type ?? "message";
    if (type !== "message") return { ok: false, code: "BAD_TYPE", message: "S2 sends only type 'message'." };

    const today = new Date(now());
    const decision = evaluateMessageSend(
      vault.policy.messages,
      existsSync(vaultPaths(root).kill),
      opts.to,
      Buffer.byteLength(body, "utf8"),
      messageCountFromLog(readLogLines(root), today),
    );
    if (!decision.ok) return decision;

    // BRC-181 pre-gate: fail closed on a corrupt signed policy before any fetch.
    const loaded = loadPolicyEnvelope(vaultPaths(root).brc181);
    if (!loaded.ok) return loaded;
    const spentTotal = loadUsage(root, today, "brc181-bsv").spentLifetime;
    const pre = gateAgentSend({ envelope: loaded.envelope, to: opts.to, amount: TIP_SATS, fee: 0, spentTotal });
    if (!pre.ok) return pre;

    // Build the envelope + OP_RETURN script BEFORE any fetch/selection so the
    // fee model uses the real script size and malformed bodies reject without
    // network access. signEnvelope/buildMessageScript are deterministic.
    const nonce = opts.nonce ?? randomNonce();
    const ts = opts.ts ?? Math.floor(now() / 1000);
    const unsigned = { v: 1, app: "dogfood", type, from: vault.address, to: opts.to, nonce, ts, body };
    let signed: Envelope;
    let scriptHex: string;
    try {
      signed = signEnvelope(vault.key, unsigned);
      scriptHex = buildMessageScript(vault.key, unsigned);
    } catch (error) {
      return { ok: false, code: "BAD_ENVELOPE", message: error instanceof Error ? error.message : String(error) };
    }
    const scriptBytes = scriptHex.length / 2;

    // Inbox-tip exclusions: never re-select a tip this vault already paid.
    // Load the store BEFORE any fetch so a corrupt store fails closed offline.
    let utxos: Utxo[];
    try {
      const tips = loadInboxTips(root);
      utxos = excludeInboxTips(await fetchUtxos(vault.address), tips);
    } catch (error) {
      return { ok: false, code: "INBOX_TIPS", message: error instanceof Error ? error.message : String(error) };
    }
    // Same fail-closed source-metadata validation as send.ts.
    const outpoints = new Set<string>();
    for (const u of utxos) {
      const outpoint = `${u.tx_hash}.${u.tx_pos}`;
      if (!/^[0-9a-f]{64}$/.test(u.tx_hash) || !Number.isSafeInteger(u.tx_pos) || u.tx_pos < 0
        || !Number.isSafeInteger(u.value) || u.value <= 0 || outpoints.has(outpoint)) {
        throw new Error("Invalid send source metadata");
      }
      outpoints.add(outpoint);
    }

    // Coin selection with the message fee model: outputs are tip (34 bytes),
    // OP_RETURN (scriptBytes + CompactSize length + 8), and optional change
    // (34). Dust change <= 1 sat folds into the fee; change that cannot afford
    // its own output also folds (same convention as send.ts).
    const scriptLenBytes = scriptBytes < 253 ? 1 : scriptBytes <= 0xffff ? 3 : 5;
    const opReturnOutBytes = 8 + scriptLenBytes + scriptBytes;
    const sorted = [...utxos].sort((a, b) => a.value - b.value);
    const chosen: Utxo[] = [];
    let total = 0;
    let plannedFee = 0;
    let change = 0;
    for (const utxo of sorted) {
      chosen.push(utxo);
      total += utxo.value;
      const feeWithChange = 10 + 148 * chosen.length + 34 + opReturnOutBytes + 34;
      if (total >= TIP_SATS + feeWithChange) {
        const rest = total - TIP_SATS - feeWithChange;
        if (rest > 1) {
          plannedFee = feeWithChange;
          change = rest;
        } else {
          plannedFee = total - TIP_SATS;
          change = 0;
        }
        break;
      }
      const feeNoChange = feeWithChange - 34;
      if (total >= TIP_SATS + feeNoChange) {
        plannedFee = total - TIP_SATS;
        change = 0;
        break;
      }
    }
    if (plannedFee === 0) {
      const need = TIP_SATS + 10 + 148 * Math.max(sorted.length, 1) + 34 + opReturnOutBytes;
      return { ok: false, code: "INSUFFICIENT", message: `Insufficient funds: need ${need} sats, available ${total}` };
    }

    // BRC-181 post-gate with the real planned fee (fee-inclusive accounting).
    const post = gateAgentSend({ envelope: loaded.envelope, to: opts.to, amount: TIP_SATS, fee: plannedFee, spentTotal });
    if (!post.ok) return post;

    // Source verification: every selected input must be a real, own-address
    // output with the claimed value (same binding as send.ts).
    const sourceCache = new Map<string, Transaction>();
    for (const utxo of chosen) {
      let source = sourceCache.get(utxo.tx_hash);
      if (!source) {
        source = Transaction.fromHex(await fetchTxHex(utxo.tx_hash));
        if (source.id("hex") !== utxo.tx_hash) throw new Error(`Invalid source transaction id: ${utxo.tx_hash}`);
        sourceCache.set(utxo.tx_hash, source);
      }
      const sourceOutput = source.outputs[utxo.tx_pos];
      const ownScript = new P2PKH().lock(vault.address).toHex();
      if (!sourceOutput || sourceOutput.satoshis !== utxo.value || sourceOutput.lockingScript.toHex() !== ownScript) {
        throw new Error(`Invalid source output: ${utxo.tx_hash}:${utxo.tx_pos}`);
      }
    }

    const tx = new Transaction();
    for (const utxo of chosen) {
      tx.addInput({
        sourceTransaction: sourceCache.get(utxo.tx_hash)!,
        sourceTXID: utxo.tx_hash,
        sourceOutputIndex: utxo.tx_pos,
        unlockingScriptTemplate: new P2PKH().unlock(vault.key),
      });
    }
    tx.addOutput({ satoshis: TIP_SATS, lockingScript: new P2PKH().lock(opts.to) });
    tx.addOutput({ satoshis: 0, lockingScript: Script.fromHex(scriptHex) });
    if (change > 1) tx.addOutput({ satoshis: change, lockingScript: new P2PKH().lock(vault.address) });

    // Authorize the actual transaction debit, including any omitted change.
    const fee = tx.inputs.reduce((sum, input) => sum + input.sourceTransaction!.outputs[input.sourceOutputIndex]!.satoshis!, 0)
      - tx.outputs.reduce((sum, output) => sum + output.satoshis!, 0);
    if (fee !== plannedFee) throw new Error("Invalid message source fee");

    guard.reserve({ asset: "bsv", amount: TIP_SATS, to: opts.to, fee: plannedFee });
    await tx.sign();
    const rawTx = tx.toHex();
    const expectedTxid = tx.id("hex");

    // Fsynced evidence BEFORE broadcast: signed tx + envelope survive a crash.
    const messagesDir = vaultPaths(root).messages;
    mkdirSync(messagesDir, { recursive: true });
    const evidencePath = join(messagesDir, `${guard.id}.json`);
    const evidence = {
      version: 1,
      guardId: guard.id,
      operation: "agent-message",
      status: "signed",
      started: new Date(now()).toISOString(),
      to: opts.to,
      tip: TIP_SATS,
      fee: plannedFee,
      nonce,
      ts,
      envelope: signed,
      rawTx,
    };
    writeEvidence(evidencePath, evidence);

    // Killfile may have flipped while we fetched/signed: re-check before the
    // single broadcast attempt. A throw here leaves the guard HOLD intact.
    if (existsSync(vaultPaths(root).kill)) throw new Error("REJECTED: killfile enabled before broadcast.");

    const result = await broadcast(rawTx);
    if (result.txid !== expectedTxid) throw new Error(`Broadcast txid mismatch: expected ${expectedTxid}, got ${result.txid}; payment held.`);

    guard.log({ kind: "agent-message", t: new Date(now()).toISOString(), txid: result.txid, to: opts.to, amount: TIP_SATS, fee: plannedFee, nonce, note: "" });
    writeEvidence(evidencePath, { ...evidence, status: "broadcast", txid: result.txid });
    // The 1-sat tip outpoint is now excluded from this vault's future coin
    // selection (it belongs to the recipient's inbox semantics).
    markInboxTip(root, `${result.txid}.0`);

    return { ok: true, txid: result.txid, to: opts.to, tip: TIP_SATS, fee: plannedFee, nonce, guardId: guard.id, evidence: evidencePath };
  });
  } catch (e) {
    if (e instanceof PaymentHeldError) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
}