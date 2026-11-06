import {P2PKH, Spend, Transaction} from '@bsv/sdk';
import {closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sourceTransaction, unspent} from './gryd-buy';
import {withPaymentGuard} from './payment-guard';
import {defaultVaultDir, loadUsage, loadVault, parseStoredPolicy, vaultPaths} from './vault';

export type PopnlocksSignOptions = {txhex: string; inputIndex: number; root?: string; fetchFn?: typeof fetch};
function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
function checkKill(root: string) {
  if (present(vaultPaths(root).kill)) throw Error('STOP_SPENDING is on');
}
function gate(root: string, amount: number) {
  checkKill(root);
  const path = vaultPaths(root).policy;
  const policy = present(path) ? parseStoredPolicy(readFileSync(path, 'utf8'), false).popnlocks : undefined;
  if (!policy) throw Error('popnlocks signing disabled: policy block required');
  if (amount > policy.maxPerTxSats) throw Error('Exceeds popnlocks.maxPerTxSats');
  if (loadUsage(root, new Date(), 'popnlocks').spentToday > policy.maxPerDaySats - amount) throw Error('Exceeds popnlocks.maxPerDaySats');
}
function evidence(root: string, id: string, record: unknown) {
  const dir = join(root, 'popnlocks-signs');
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const fd = openSync(join(dir, id + '.jsonl'), 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  if (process.platform !== 'win32') {
    for (const path of [dir, root]) {
      const d = openSync(path, 'r'); try { fsyncSync(d); } finally { closeSync(d); }
    }
  }
}
/** CLI-only capped authorization, not settlement. Never broadcasts or retries.
 * Output 0 is the maker-verified covenant; this primitive does not verify its
 * economics/bytecode. Every returned signature charges the FULL input value.
 */
export async function popnlocksSign(options: PopnlocksSignOptions): Promise<string> {
  let tx: Transaction;
  try {
    if (typeof options.txhex !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(options.txhex)) throw Error();
    tx = Transaction.fromHex(options.txhex);
    if (tx.toHex() !== options.txhex.toLowerCase() || tx.inputs.length !== 2 || tx.outputs.length === 0) throw Error();
    if (new Set(tx.inputs.map(i => `${i.sourceTXID}_${i.sourceOutputIndex}`)).size !== tx.inputs.length) throw Error();
    if (!tx.outputs.every(o => Number.isSafeInteger(o.satoshis) && o.satoshis! >= 0) || tx.outputs[0]!.satoshis! <= 0) throw Error();
  } catch { throw Error('Invalid transaction: canonical two-input deploy transaction required'); }
  const index = options.inputIndex;
  if (!Number.isSafeInteger(index) || index < 0 || index >= tx.inputs.length) throw Error('Invalid inputIndex');
  const input = tx.inputs[index]!;
  if (input.unlockingScript?.toHex()) throw Error('Selected input must be unsigned');
  const root = options.root ?? defaultVaultDir();
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  return withPaymentGuard(root, 'popnlocks-sign', async guard => {
    gate(root, 0); // Absence/kill rejection without key or network access.
    const address = readFileSync(vaultPaths(root).address, 'utf8').trim();
    const lock = new P2PKH().lock(address);
    const previous = await sourceTransaction(input.sourceTXID!, fetchFn);
    const output = previous.outputs[input.sourceOutputIndex];
    if (!output || output.lockingScript.toHex() !== lock.toHex()) throw Error('Selected input is not ours (main-vault P2PKH required)');
    const amount = output.satoshis!;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw Error('Invalid source input value');
    const rows = await unspent(`https://api.whatsonchain.com/v1/bsv/main/address/${address}/unspent`, fetchFn);
    if (!rows.some(r => r.tx_hash === input.sourceTXID && r.tx_pos === input.sourceOutputIndex && r.value === amount)) throw Error('Source unspent triple mismatch');
    gate(root, amount); // Chain evidence and policy BEFORE decrypting any key.
    const vault = loadVault(root);
    if (vault.address !== address) throw Error('Vault address changed during validation');
    input.sourceTransaction = previous;
    // Durable reservation precedes signing; errors from here retain the hold.
    guard.reserve({asset: 'bsv', amount, to: address, fee: 0});
    const signer = new P2PKH().unlock(vault.key, 'all', false, amount, output.lockingScript);
    checkKill(root); // Immediately before signing, with no intervening await.
    input.unlockingScript = await signer.sign(tx, index);
    if (!new Spend({sourceTXID: input.sourceTXID!, sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: amount, lockingScript: output.lockingScript, transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, j) => j !== index), inputIndex: index,
      unlockingScript: input.unlockingScript, inputSequence: input.sequence ?? 0xffffffff,
      outputs: tx.outputs, lockTime: tx.lockTime}).validate()) throw Error('Input signature validation failed');
    const rawTx = tx.toHex(), txid = tx.id('hex'), timestamp = new Date().toISOString();
    evidence(root, guard.id, {version: 1, paymentId: guard.id, txid, inputIndex: index,
      sourceTxid: input.sourceTXID, sourceOutputIndex: input.sourceOutputIndex,
      inputValue: amount, covenantOutputValue: tx.outputs[0]!.satoshis, timestamp, rawTx});
    checkKill(root);
    guard.log({t: timestamp, asset: 'popnlocks', kind: 'popnlocks-sign', txid,
      amount, inputIndex: index, to: address, status: 'signed-not-broadcast'});
    return rawTx;
  });
}
