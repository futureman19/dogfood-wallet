import { P2PKH, Spend, Transaction } from "@bsv/sdk";
import { settleX402, type CompletedTransaction, type SettleX402Result } from "./delegator";
import { loadPolicyEnvelope } from "./brc181";
import { inspectPaymentHold, withPaymentGuard } from "./payment-guard";
import { defaultFetchTxHex } from "./send";
import { loadUsage, loadVault, vaultPaths } from "./vault";
import { p2pkhAddressFromLock, type X402Challenge } from "./x402";

/** Agent boundary: callers cannot inject policy, funding, accounting or guard hooks. */
export async function delegateX402(root: string, opts: {
  challenge: X402Challenge; method?: string; path?: string; broadcast?: boolean; vaultFund?: boolean;
}): Promise<SettleX402Result> {
  try {
    return await withPaymentGuard(root, "x402-delegate", async guard => {
      const vault = loadVault(root);
      const loaded = loadPolicyEnvelope(vaultPaths(root).brc181);
      if (!loaded.ok) return { ok: false, broadcast: false, code: loaded.code, message: loaded.message };
      const ch = opts.challenge;
      return settleX402({
        challenge: ch, method: opts.method, path: opts.path, broadcast: opts.broadcast,
        policy: vault.policy, usage: loadUsage(root, new Date(), "bsv"), envelope: loaded.envelope,
        fund: opts.vaultFund ? { key: vault.key, address: vault.address } : undefined,
        guarded: true,
        beforeSign: () => guard.reserve({ asset: "bsv", amount: ch.amount_sats,
          to: p2pkhAddressFromLock(ch.payee_locking_script_hex)!, fee: 0 }),
        onSpend: row => guard.log({ ...row, asset: "bsv" }),
        beforeDelegate: async partial => {
          if (opts.vaultFund) return;
          // A caller-supplied template is not proof of sponsorship. Check every
          // source before forwarding any pre-signed bytes to a remote party.
          const ownLock = new P2PKH().lock(vault.address).toHex();
          for (const input of Transaction.fromHex(partial).inputs) {
            const source = Transaction.fromHex(await defaultFetchTxHex(input.sourceTXID!));
            const output = source.outputs[input.sourceOutputIndex];
            if (source.id("hex") !== input.sourceTXID || !output || output.lockingScript.toHex() === ownLock) {
              throw new Error("Sponsored template contains unverified or local funding");
            }
          }
        },
        validateCompleted: (completed, partial) => validateCompleted(completed, partial, ch, vault.address, !!opts.vaultFund),
      });
    });
  } catch {
    // Never echo remote response bodies or script-engine diagnostics to agents.
    const held = inspectPaymentHold(root).blocked;
    return { ok: false, broadcast: false, code: held ? "PAYMENT_HELD" : "DELEGATOR",
      message: held ? "Payment exposure unresolved; hold retained. Do not retry or clear; see docs/payment-recovery.md."
        : "Delegation validation failed; no local payment completed." };
  }
}

/** Validate bytes and source scripts, not a delegator's assertion of completion.
 * No chain-confirmation claim: accepted broadcast remains zero-conf.
 */
async function validateCompleted(completed: CompletedTransaction, partialHex: string, ch: X402Challenge, address: string, funded: boolean) {
  const reject = () => { throw new Error("Invalid completed delegation"); };
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(completed.rawtxHex)) reject();
  const tx = Transaction.fromHex(completed.rawtxHex);
  const partial = Transaction.fromHex(partialHex);
  const ownLock = new P2PKH().lock(address).toHex();
  if (tx.toHex() !== completed.rawtxHex.toLowerCase() || tx.id("hex") !== completed.txid
    || tx.version !== partial.version || tx.lockTime !== partial.lockTime
    || tx.inputs.length < partial.inputs.length || tx.outputs.length < partial.outputs.length
    || (funded && tx.outputs.length !== partial.outputs.length)
    || tx.outputs[0]?.satoshis !== ch.amount_sats
    || tx.outputs[0]?.lockingScript.toHex() !== ch.payee_locking_script_hex
    || tx.inputs[0]?.sourceTXID !== ch.nonce_utxo?.txid
    || tx.inputs[0]?.sourceOutputIndex !== ch.nonce_utxo?.vout) reject();
  for (let i = 0; i < partial.outputs.length; i++) {
    if (tx.outputs[i].satoshis !== partial.outputs[i].satoshis
      || tx.outputs[i].lockingScript.toHex() !== partial.outputs[i].lockingScript.toHex()) reject();
  }
  let inputs = 0;
  let ownInputs = 0;
  const seen = new Set<string>();
  for (let i = 0; i < tx.inputs.length; i++) {
    const input = tx.inputs[i];
    const prior = partial.inputs[i];
    const outpoint = `${input.sourceTXID}:${input.sourceOutputIndex}`;
    if (seen.has(outpoint)) reject();
    seen.add(outpoint);
    if (prior && (input.sourceTXID !== prior.sourceTXID || input.sourceOutputIndex !== prior.sourceOutputIndex
      || input.sequence !== prior.sequence || (funded && i === 1 && input.unlockingScript?.toHex() !== prior.unlockingScript?.toHex()))) reject();
    const source = Transaction.fromHex(await defaultFetchTxHex(input.sourceTXID!));
    const output = source.outputs[input.sourceOutputIndex];
    if (source.id("hex") !== input.sourceTXID || !output || !Number.isSafeInteger(output.satoshis) || output.satoshis! < 0) reject();
    const isOwn = output.lockingScript.toHex() === ownLock;
    if (isOwn !== (funded && i === 1)) reject(); // no extra local inputs, including sponsored/nonce inputs
    if (isOwn) ownInputs += output.satoshis!;
    inputs += output.satoshis!;
    if (!Number.isSafeInteger(inputs)) reject();
    if (!input.unlockingScript || !new Spend({ sourceTXID: input.sourceTXID!, sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: output.satoshis!, lockingScript: output.lockingScript, transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, n) => n !== i), outputs: tx.outputs, inputIndex: i,
      unlockingScript: input.unlockingScript, inputSequence: input.sequence!, lockTime: tx.lockTime }).validate()) reject();
  }
  let outputs = 0;
  let ownOutputs = 0;
  for (const output of tx.outputs) {
    if (!Number.isSafeInteger(output.satoshis) || output.satoshis! < 0) reject();
    outputs += output.satoshis!;
    if (output.lockingScript.toHex() === ownLock) ownOutputs += output.satoshis!;
  }
  if (!Number.isSafeInteger(outputs) || outputs > inputs || (funded && ownInputs - ownOutputs !== ch.amount_sats)) reject();
}
