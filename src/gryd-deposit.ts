import {P2PKH, SatoshisPerKilobyte, Script, Spend, Transaction} from '@bsv/sdk';
import {closeSync, fsyncSync, mkdirSync, openSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {GRYD_FUND, sourceTransaction, unspent} from './gryd-buy';
import {loadUsage, loadVault, vaultPaths} from './vault';
import {evaluateSend} from './policy';
import {gateAgentSend, loadPolicyEnvelope} from './brc181';
import {withPaymentGuard} from './payment-guard';
import {arcBroadcast} from './send';

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
function checkAgentId(id: string) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(id)) throw Error('Invalid agent-id: 1..200 ASCII alnum :_- characters, first alnum');
}
function checkSats(sats: number) {
  if (!Number.isSafeInteger(sats) || sats <= 0) throw Error('Invalid sats: positive safe integer required');
}
/** Exact deposit_verifier.ex profile: OP_FALSE OP_RETURN, one direct/PUSHDATA1 push. */
export function depositBinding(agentId: string): Script {
  checkAgentId(agentId);
  const payload = Buffer.from(JSON.stringify({type:'agent_fund', agent_id:agentId}), 'utf8');
  if (payload.length > 255) throw Error('Deposit binding exceeds 255 bytes');
  const push = payload.length <= 75 ? Buffer.from([payload.length]) : Buffer.from([76, payload.length]);
  return Script.fromHex(Buffer.concat([Buffer.from([0,106]), push, payload]).toString('hex'));
}
/** Closed transaction shape, not a permissive OP_RETURN JSON search. */
export function validateDeposit(tx: Transaction, agentId: string, sats: number, mainAddress: string): void {
  checkSats(sats);
  const [fund, binding, change] = tx.outputs;
  if (tx.outputs.length !== 3 || fund?.satoshis !== sats || fund.lockingScript.toHex() !== new P2PKH().lock(GRYD_FUND).toHex()) throw Error('Deposit Fund destination/value mismatch');
  if (binding?.satoshis !== 0 || binding.lockingScript.toHex() !== depositBinding(agentId).toHex()) throw Error('Deposit binding mismatch');
  if (!change || !Number.isSafeInteger(change.satoshis) || change.satoshis! <= 0 || change.lockingScript.toHex() !== new P2PKH().lock(mainAddress).toHex()) throw Error('Deposit change mismatch');
}
export type DepositOptions = {root:string; agentId:string; sats:number; noBroadcast?:boolean; fetchFn?:typeof fetch; broadcast?:(raw:string)=>Promise<{txid:string}>};
export type DepositResult = {
  mode:'broadcast'|'signed'; held:boolean; amount:number; minerFee:number;
  claim:{txid:string; vout:0}; agentPost:{route:{agentId:string}; body:{txid:string; vout:0}};
  rawTx?:string;
};
// Same control-flow pattern as gryd-post: throw THROUGH the guard, catch outside.
// A normal return with a reserved, unlogged payment must never release the hold.
class RetainedResult extends Error {
  constructor(readonly result:DepositResult) { super('Signed payment retained for human reconciliation'); }
}
function persistEvidence(root:string, id:string, value:unknown) {
  const dir = join(root,'gryd-deposits');
  mkdirSync(dir,{recursive:true,mode:0o700});
  const fd = openSync(join(dir,id+'.json'),'wx',0o600);
  try { writeFileSync(fd,JSON.stringify(value)+'\n'); fsyncSync(fd); } finally { closeSync(fd); }
  if (process.platform !== 'win32') { const d=openSync(dir,'r'); try { fsyncSync(d); } finally { closeSync(d); } }
}
/** Human-only main-vault deposit; never submits agent.fund or retries a failed broadcast. */
export async function depositAgent(options:DepositOptions):Promise<DepositResult> {
  checkAgentId(options.agentId); checkSats(options.sats);
  if (options.noBroadcast !== undefined && typeof options.noBroadcast !== 'boolean') throw Error('Invalid no-broadcast option');
  const fetchFn=options.fetchFn??globalThis.fetch.bind(globalThis);
  try { return await withPaymentGuard(options.root,'agent-deposit',async guard=>{
    const vault=loadVault(options.root), mainLock=new P2PKH().lock(vault.address);
    const gate=(fee:number)=>{
      const policy=loadVault(options.root).policy;
      const local=evaluateSend(policy,options.sats,GRYD_FUND,loadUsage(options.root));
      if(!local.ok) throw Error(local.message);
      const loaded=loadPolicyEnvelope(vaultPaths(options.root).brc181);
      if(!loaded.ok) throw Error(loaded.message);
      const signed=gateAgentSend({envelope:loaded.envelope,to:GRYD_FUND,amount:options.sats,fee,spentTotal:loadUsage(options.root,new Date(),'brc181-bsv').spentLifetime});
      if(!signed.ok) throw Error(signed.message);
    };
    gate(0);
    const fundingUrl=`${WOC}/address/${vault.address}/unspent`;
    const coins=(await unspent(fundingUrl,fetchFn)).filter(u=>u.value>1).sort((a,b)=>a.value-b.value||a.tx_hash.localeCompare(b.tx_hash)||a.tx_pos-b.tx_pos);
    const tx=new Transaction();
    tx.addOutput({satoshis:options.sats,lockingScript:new P2PKH().lock(GRYD_FUND)});
    tx.addOutput({satoshis:0,lockingScript:depositBinding(options.agentId)});
    tx.addOutput({satoshis:0,lockingScript:mainLock,change:true});
    let total=0,funded=false;
    for(const coin of coins){
      const previous=await sourceTransaction(coin.tx_hash,fetchFn), output=previous.outputs[coin.tx_pos];
      if(!output||output.satoshis!==coin.value||output.lockingScript.toHex()!==mainLock.toHex()) throw Error('Funding chain triple/script mismatch');
      total+=coin.value; if(!Number.isSafeInteger(total)) throw Error('Unsafe funding total');
      tx.addInput({sourceTXID:coin.tx_hash,sourceOutputIndex:coin.tx_pos,sourceTransaction:previous,unlockingScriptTemplate:new P2PKH().unlock(vault.key)});
      const fee=await new SatoshisPerKilobyte(1000).computeFee(tx);
      if(total-options.sats>fee){tx.outputs[2]!.satoshis=total-options.sats-fee;tx.outputs[2]!.change=false;funded=true;break;}
    }
    if(!funded) throw Error('Insufficient main payment coins for deposit, fee and change');
    const minerFee=total-tx.outputs.reduce((sum,o)=>sum+o.satoshis!,0);
    validateDeposit(tx,options.agentId,options.sats,vault.address);
    const fresh=async()=>{
      const rows=await unspent(fundingUrl,fetchFn);
      for(const i of tx.inputs) if(!rows.some(u=>u.tx_hash===i.sourceTXID&&u.tx_pos===i.sourceOutputIndex&&u.value===i.sourceTransaction!.outputs[i.sourceOutputIndex]!.satoshis)) throw Error('Funding spent or chain triple mismatch');
      if(loadVault(options.root).policy.killfileOn) throw Error('STOP_SPENDING is on');
    };
    await fresh();
    gate(minerFee); // actual input-minus-output fee, BEFORE reserve/sign
    guard.reserve({asset:'bsv',amount:options.sats,to:GRYD_FUND,fee:minerFee});
    await tx.sign();
    validateDeposit(tx,options.agentId,options.sats,vault.address);
    for(let i=0;i<tx.inputs.length;i++){
      const input=tx.inputs[i]!,prev=input.sourceTransaction!.outputs[input.sourceOutputIndex]!;
      if(!new Spend({sourceTXID:input.sourceTXID!,sourceOutputIndex:input.sourceOutputIndex,sourceSatoshis:prev.satoshis!,lockingScript:prev.lockingScript,transactionVersion:tx.version,otherInputs:tx.inputs.filter((_,j)=>j!==i),inputIndex:i,unlockingScript:input.unlockingScript!,inputSequence:input.sequence??0xffffffff,outputs:tx.outputs,lockTime:tx.lockTime}).validate()) throw Error('Input validation failed; hold retained');
    }
    const txid=tx.id('hex'),rawTx=tx.toHex(),claim={txid,vout:0 as const};
    const agentPost={route:{agentId:options.agentId},body:{...claim}};
    persistEvidence(options.root,guard.id,{version:1,paymentId:guard.id,operation:'agent-deposit',agentId:options.agentId,amount:options.sats,to:GRYD_FUND,minerFee,txid,rawTx,claim,agentPost,
      inputs:tx.inputs.map(i=>({txid:i.sourceTXID,vout:i.sourceOutputIndex,satoshis:i.sourceTransaction!.outputs[i.sourceOutputIndex]!.satoshis,script:mainLock.toHex()})),mode:options.noBroadcast?'signed':'broadcast'});
    const result:DepositResult={mode:options.noBroadcast?'signed':'broadcast',held:!!options.noBroadcast,amount:options.sats,minerFee,claim,agentPost};
    if(options.noBroadcast) throw new RetainedResult({...result,rawTx});
    // Signing/evidence I/O is complete. Recheck chain and killfile immediately before sending.
    await fresh();
    const ack=await(options.broadcast??(raw=>arcBroadcast(raw,fetchFn)))(rawTx);
    if(ack.txid!==txid) throw Error('Ambiguous broadcast acknowledgement; hold retained');
    guard.log({t:new Date().toISOString(),asset:'bsv',kind:'agent-deposit',txid,amount:options.sats,fee:minerFee,to:GRYD_FUND,agentId:options.agentId});
    return result;
  }); } catch(error) { if(error instanceof RetainedResult) return error.result; throw error; }
}
