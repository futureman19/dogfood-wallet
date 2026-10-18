import { Hash, P2PKH, Script, Spend, Transaction, Utils, SatoshisPerKilobyte } from '@bsv/sdk';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeListing, normalizeListingOutpoint, propertyKey, sourceTransaction, unspent } from './gryd-buy';
import { ORD_LOCK_PREFIX, ORD_LOCK_SUFFIX } from './gryd-ordlock-constants';
import { loadVault } from './vault';
import { withPaymentGuard } from './payment-guard';
import { defaultBroadcast } from './send';
import { signAgentRequest, type SignedAgentRequest } from './gryd-agent';
import { p2pkhAddressFromLock } from './x402';
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const API = 'https://the-grid-api.fly.dev/api/v1';
const DERIVATION = 'dogfood/gryd/property/v1';
function priceCheck(price: number) {
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error('price-sats must be a positive safe integer');
}
/** Exact pinned legacy OrdLock, not V2 or an inscription wrapper. */
export function listingScript(cancelAddress: string, payAddress: string, price: number): Script {
  priceCheck(price);
  const payout = new Utils.Writer().writeUInt64LE(price).writeVarIntNum(25).write(new P2PKH().lock(payAddress).toBinary()).toArray();
  return new Script().writeScript(Script.fromHex(ORD_LOCK_PREFIX)).writeBin(Utils.fromBase58Check(cancelAddress).data as number[])
    .writeBin(payout).writeScript(Script.fromHex(ORD_LOCK_SUFFIX));
}
type Common = { root: string; noBroadcast?: boolean; fetchFn?: typeof fetch; broadcast?: (raw: string) => Promise<{txid: string}> };
export type ListOptions = Common & { ordinalOutpoint: string; priceSats: number };
export type CancelOptions = Common & { listingOutpoint: string };
type Preview = {
  operation: 'agent-list' | 'agent-cancel-listing'; sourceOutpoint: string; agentId: string;
  propertyAddress: string; payAddress: string; price: number; minerFee: number;
  backendCompatible: false;
  inputs: {outpoint: string; satoshis: number; role: string}[];
  outputs: {index: number; satoshis: number; address: string | null; role: string}[];
};
export type ListingResult = Preview & ({mode: 'preview'} | {mode: 'broadcast'; txid: string; envelope: SignedAgentRequest});
/** Read-only local provenance selects a route, never authorizes a chain spend.
 * Only output0 from a Dogfood purchase/list/cancel is resolvable. Unknown/imported
 * ordinals fail closed: /agents/mine requires POST authorization, and the public
 * nearby index cannot discover arbitrary unlisted holdings without coordinates.
 */
async function resolveIdentity(root: string, point: string, cancel: boolean, fetchFn: typeof fetch): Promise<string> {
  const [txid, vout] = point.split('_');
  if (vout !== '0') throw new Error('Unresolved agent identity: local provenance requires output zero');
  const directories = cancel ? ['gryd-listings'] : ['gryd-purchases', 'gryd-listings'];
  const ids: string[] = [];
  for (const dir of directories) {
    let text: string;
    try { text = readFileSync(join(root, dir, `${txid}.json`), 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    const record = JSON.parse(text);
    if (record.version !== 1 || record.txid !== txid || typeof record.rawTx !== 'string'
      || Transaction.fromHex(record.rawTx).id('hex') !== txid || typeof record.agentId !== 'string'
      || !record.agentId || record.agentId.length > 256
      || (dir === 'gryd-listings' && record.operation !== (cancel ? 'agent-list' : 'agent-cancel-listing'))) throw new Error('Invalid local agent identity evidence');
    ids.push(record.agentId);
  }
  if (ids.length !== 1) throw new Error('Unresolved or ambiguous agent identity; local purchase/listing evidence required');
  const id = ids[0]!;
  const response = await fetchFn(`${API}/agents/${encodeURIComponent(id)}`, {method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error('Agent identity lookup unavailable');
  const data = await response.json();
  if (data?.agent?.id !== id || data.agent.source !== 'object') throw new Error('Agent identity lookup mismatch');
  return id;
}
export async function listAgent(options: ListOptions): Promise<ListingResult> {
  const point = normalizeListingOutpoint(options.ordinalOutpoint);
  priceCheck(options.priceSats);
  return transact(options, point, options.priceSats, false);
}
export async function cancelAgentListing(options: CancelOptions): Promise<ListingResult> {
  const point = normalizeListingOutpoint(options.listingOutpoint);
  return transact(options, point, 0, true);
}
async function transact(options: Common, point: string, price: number, cancel: boolean): Promise<ListingResult> {
  if (options.noBroadcast !== undefined && typeof options.noBroadcast !== 'boolean') throw new Error('Invalid preview option');
  const operation = cancel ? 'agent-cancel-listing' : 'agent-list';
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  return withPaymentGuard(options.root, operation, async guard => {
    const vault = loadVault(options.root);
    if (vault.policy.killfileOn) throw new Error('STOP_SPENDING is on');
    const property = propertyKey(vault.key), propertyAddress = property.toAddress();
    if (propertyAddress === vault.address) throw new Error('Property/payment key collision');
    const [txid, indexText] = point.split('_'), index = Number(indexText);
    const source = await sourceTransaction(txid!, fetchFn), ordinal = source.outputs[index];
    if (!ordinal || ordinal.satoshis !== 1) throw new Error('Source must be a one-satoshi ordinal');
    const propertyLock = new P2PKH().lock(propertyAddress), mainLock = new P2PKH().lock(vault.address);
    if (cancel) {
      const decoded = decodeListing(ordinal.lockingScript.toHex());
      price = decoded.price;
      // Full-byte equality proves both cancellation hash and main-vault payout.
      if (ordinal.lockingScript.toHex() !== listingScript(propertyAddress, vault.address, price).toHex()) throw new Error('Listing cancellation ownership or payout mismatch');
    } else if (ordinal.lockingScript.toHex() !== propertyLock.toHex()) throw new Error('Ordinal is not owned by the isolated property address');
    const scriptHash = Utils.toHex(Hash.sha256(ordinal.lockingScript.toBinary()).reverse());
    const checkOrdinal = async () => {
      if (!(await unspent(`${WOC}/script/${scriptHash}/unspent`, fetchFn)).some(u => u.tx_hash === txid && u.tx_pos === index && u.value === 1)) throw new Error('Ordinal spent or chain triple mismatch');
    };
    await checkOrdinal();
    const agentId = await resolveIdentity(options.root, point, cancel, fetchFn);
    const fundingUrl = `${WOC}/address/${vault.address}/unspent`;
    const coins = (await unspent(fundingUrl, fetchFn)).filter(u => u.value > 1).sort((a,b) => a.value-b.value || a.tx_hash.localeCompare(b.tx_hash) || a.tx_pos-b.tx_pos);
    const tx = new Transaction();
    const p2pkh = new P2PKH().unlock(property);
    tx.addInput({sourceTXID:txid!,sourceOutputIndex:index,sourceTransaction:source,unlockingScriptTemplate: cancel ? {
      sign: async(t,i) => (await p2pkh.sign(t,i)).writeOpCode(0x51),
      estimateLength: async() => 109,
    } : p2pkh});
    tx.addOutput({satoshis:1,lockingScript:cancel?propertyLock:listingScript(propertyAddress,vault.address,price)});
    tx.addOutput({satoshis:0,lockingScript:mainLock,change:true});
    let total = 0, funded = false;
    for (const coin of coins) {
      const previous = await sourceTransaction(coin.tx_hash,fetchFn), output = previous.outputs[coin.tx_pos];
      if (!output || output.satoshis !== coin.value || output.lockingScript.toHex() !== mainLock.toHex() || `${coin.tx_hash}_${coin.tx_pos}` === point) throw new Error('Funding chain triple/script mismatch');
      total += coin.value;
      if (!Number.isSafeInteger(total)) throw new Error('Unsafe funding total');
      tx.addInput({sourceTXID:coin.tx_hash,sourceOutputIndex:coin.tx_pos,sourceTransaction:previous,unlockingScriptTemplate:new P2PKH().unlock(vault.key)});
      const fee = await new SatoshisPerKilobyte(1000).computeFee(tx);
      if (total > fee) { tx.outputs[1]!.satoshis = total-fee; tx.outputs[1]!.change = false; funded = true; break; }
    }
    if (!funded) throw new Error('Insufficient main payment coins for miner fee and change');
    const minerFee = total-tx.outputs[1]!.satoshis!;
    const preview: Preview = {operation,sourceOutpoint:point,agentId,propertyAddress,payAddress:vault.address,price,minerFee,backendCompatible:false,
      inputs:tx.inputs.map((input,i)=>({outpoint:`${input.sourceTXID}_${input.sourceOutputIndex}`,satoshis:input.sourceTransaction!.outputs[input.sourceOutputIndex]!.satoshis!,role:i===0?'property ordinal':'payment coin'})),
      outputs:tx.outputs.map((o,i)=>({index:i,satoshis:o.satoshis!,address:p2pkhAddressFromLock(o.lockingScript.toHex()),role:i===0?(cancel?'property (isolated)':'legacy OrdLock (property cancel / main payout)'):'payment change'}))};
    if (options.noBroadcast) return {...preview,mode:'preview'};
    await checkOrdinal();
    const refreshed = await unspent(fundingUrl,fetchFn);
    for (const input of tx.inputs.slice(1)) if (!refreshed.some(u=>u.tx_hash===input.sourceTXID && u.tx_pos===input.sourceOutputIndex && u.value===input.sourceTransaction!.outputs[input.sourceOutputIndex]!.satoshis)) throw new Error('Funding spent or chain triple mismatch');
    if (loadVault(options.root).policy.killfileOn) throw new Error('STOP_SPENDING is on');
    guard.reserve({asset:'bsv',amount:0,to:propertyAddress,fee:minerFee});
    await tx.sign();
    for (let i=0;i<tx.inputs.length;i++) {
      const input=tx.inputs[i]!, previous=input.sourceTransaction!.outputs[input.sourceOutputIndex]!;
      if (!new Spend({sourceTXID:input.sourceTXID!,sourceOutputIndex:input.sourceOutputIndex,sourceSatoshis:previous.satoshis!,lockingScript:previous.lockingScript,transactionVersion:tx.version,otherInputs:tx.inputs.filter((_,j)=>j!==i),inputIndex:i,unlockingScript:input.unlockingScript!,inputSequence:input.sequence??0xffffffff,outputs:tx.outputs,lockTime:tx.lockTime}).validate()) throw new Error('Input validation failed; hold retained');
    }
    const rawTx=tx.toHex(), id=tx.id('hex');
    const envelope=signAgentRequest(cancel?'agent.cancel_listing':'agent.list',cancel?{}:{price_sats:price,listing_type:'sale',outpoint:`${id}_0`,list_txid:id}, {method:'POST',path:`/api/v1/agents/${encodeURIComponent(agentId)}/${cancel?'listing/cancel':'list'}`},property);
    const directory=join(options.root,'gryd-listings'); mkdirSync(directory,{recursive:true,mode:0o700});
    const fd=openSync(join(directory,`${id}.json`),'wx',0o600);
    try {writeFileSync(fd,JSON.stringify({version:1,paymentId:guard.id,...preview,txid:id,rawTx,propertyPubkey:property.toPublicKey().toString(),derivation:DERIVATION})+'\n');fsyncSync(fd);} finally {closeSync(fd);}
    const ack=await (options.broadcast??(raw=>defaultBroadcast(raw,fetchFn)))(rawTx);
    if(ack.txid!==id)throw new Error('Ambiguous broadcast acknowledgement; hold retained');
    guard.log({t:new Date().toISOString(),asset:'bsv',kind:operation,txid:id,amount:0,fee:minerFee,to:propertyAddress,sourceOutpoint:point});
    return {...preview,mode:'broadcast',txid:id,envelope};
  });
}
