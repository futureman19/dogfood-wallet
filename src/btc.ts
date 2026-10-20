import {Transaction} from '@scure/btc-signer';
import {treasuryEvidence} from './utxo-treasury';
import {btcKey,btcAddress,btcDestination,canonicalBtcDest,p2wpkhVsize,BTC_DOMAIN} from './btc-address';
import {loadVault,loadUsage,vaultPaths} from './vault';
import {evaluateBtcSend} from './policy';
import {loadPolicyEnvelope,gateAgentSend} from './brc181';
import {withPaymentGuard} from './payment-guard';
export {btcKey,btcAddress,btcDestination,canonicalBtcDest,p2wpkhVsize} from './btc-address';
const API='https://mempool.space/api';
const MAX_MONEY=2_100_000_000_000_000;
type Coin={txid:string;vout:number;value:number;status:{confirmed:boolean}};
function sats(n:number,positive=false):void {
  if(!Number.isSafeInteger(n)||n<(positive?1:0)||n>MAX_MONEY)throw Error('Invalid BTC sats');
}
/** Single attempt, fixed host/routes, no redirect following, bounded body and deadline. */
async function request(path:string,fetchFn:typeof fetch,body?:string):Promise<string> {
  if(!(body===undefined?/^\/(?:address\/[a-zA-Z0-9]+\/utxo|tx\/[a-f0-9]{64}\/hex|fee-estimates)$/:/^\/tx$/).test(path))throw Error('Invalid BTC API route');
  const signal=AbortSignal.timeout(30000);
  const response=await fetchFn(API+path,{method:body===undefined?'GET':'POST',redirect:'error',signal,headers:{'User-Agent':'Dogfood-Wallet/0.1 (owner-operated BTC treasury)','Accept':'text/plain, application/json',...(body!==undefined?{'Content-Type':'text/plain'}:{})},...(body!==undefined?{body}:{})});
  if(!response.ok||response.redirected||(response.url&&response.url!==API+path))throw Error('BTC API refused or redirected: HTTP '+response.status);
  const reader=response.body?.getReader();if(!reader)throw Error('Empty BTC API response');
  const chunks:Uint8Array[]=[];let length=0;
  const aborted=new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>{void reader.cancel();reject(Error('BTC API timeout'));},{once:true}));
  try{while(true){signal.throwIfAborted();const row=await Promise.race([reader.read(),aborted]);if(row.done)break;length+=row.value.length;if(length>8_000_000)throw Error('BTC API response too large');chunks.push(row.value);}return Buffer.concat(chunks).toString('utf8');}finally{await reader.cancel();}
}
async function utxos(address:string,fetchFn:typeof fetch):Promise<Coin[]> {
  const rows:unknown=JSON.parse(await request('/address/'+address+'/utxo',fetchFn));
  if(!Array.isArray(rows))throw Error('Invalid BTC UTXO response');
  const seen=new Set<string>();
  for(const r of rows){
    if(!r||typeof r.txid!=='string'||! /^[a-f0-9]{64}$/.test(r.txid)||!Number.isSafeInteger(r.vout)||r.vout<0||r.vout>0xffffffff||typeof r.status?.confirmed!=='boolean')throw Error('Invalid BTC UTXO');
    sats(r.value);const id=r.txid+':'+r.vout;if(seen.has(id))throw Error('Duplicate BTC UTXO');seen.add(id);
  }
  return rows;
}
export async function btcBalance(address:string,fetchFn:typeof fetch=globalThis.fetch.bind(globalThis)) {
  const rows=await utxos(btcDestination(address).address,fetchFn);let confirmed=0,unconfirmed=0;
  for(const r of rows){if(r.status.confirmed)confirmed+=r.value;else unconfirmed+=r.value;sats(confirmed+unconfirmed);}
  return {confirmed,unconfirmed};
}
export type BtcSendOptions={root:string;to:string;sats:number;fetchFn?:typeof fetch};
/** Human-only. Signed exposure is always reserved and persisted; never retries. */
export async function sendBtc(options:BtcSendOptions):Promise<{txid:string;amount:number;fee:number}> {
  sats(options.sats,true);const destination=btcDestination(options.to);
  const fetchFn=options.fetchFn??globalThis.fetch.bind(globalThis);
  return withPaymentGuard(options.root,'btc-send',async guard=>{
    const vault=loadVault(options.root),key=btcKey(vault.key),address=btcAddress(vault.key),script=btcDestination(address).script;
    const gate=(fee:number)=>{
      const policy=loadVault(options.root).policy;
      const local=evaluateBtcSend(policy.btc,policy.killfileOn,options.sats,destination.address,loadUsage(options.root,new Date(),'btc'));
      if(!local.ok)throw Error(local.message);
      if(fee>policy.btc!.maxFeeSats)throw Error('REJECTED: BTC fee exceeds maxFeeSats');
      const loaded=loadPolicyEnvelope(vaultPaths(options.root).brc181);if(!loaded.ok)throw Error(loaded.message);
      const signed=gateAgentSend({envelope:loaded.envelope,dest:canonicalBtcDest(destination.address),amount:options.sats,fee,spentTotal:loadUsage(options.root,new Date(),'brc181-btc').spentLifetime});
      if(!signed.ok)throw Error(signed.message);
    };
    gate(0);
    const candidates=(await utxos(address,fetchFn)).filter(r=>r.value>0).sort((a,b)=>a.value-b.value||a.txid.localeCompare(b.txid)||a.vout-b.vout);
    const estimates=JSON.parse(await request('/fee-estimates',fetchFn));const rate=estimates?.['6'];
    if(typeof rate!=='number'||!Number.isFinite(rate)||rate<=0)throw Error('Invalid BTC fee estimate (6-block sat/vB)');
    const tx=new Transaction({version:2,lockTime:0});const selected:Coin[]=[];let total=0,fee=0,change=0,funded=false;
    for(const coin of candidates){
      const hex=(await request('/tx/'+coin.txid+'/hex',fetchFn)).trim();
      if(!/^(?:[a-fA-F0-9]{2})+$/.test(hex))throw Error('Invalid BTC source hex');
      // Source can have arbitrary other outputs; only the selected exact lock is authorized.
      const previous=Transaction.fromRaw(Buffer.from(hex,'hex'),{allowUnknownInputs:true,allowUnknownOutputs:true});
      if(previous.id!==coin.txid||coin.vout>=previous.outputsLength)throw Error('BTC source txid/vout mismatch');
      const output=previous.getOutput(coin.vout);
      if(output.amount!==BigInt(coin.value)||!output.script||!Buffer.from(output.script).equals(script))throw Error('BTC source value/lock mismatch');
      total+=coin.value;sats(total);selected.push(coin);
      tx.addInput({txid:coin.txid,index:coin.vout,sequence:0xffffffff,witnessUtxo:{amount:BigInt(coin.value),script}});
      const withChange=Math.ceil(rate*p2wpkhVsize(selected.length,[destination.script.length,script.length]));
      const noChange=Math.ceil(rate*p2wpkhVsize(selected.length,[destination.script.length]));
      sats(withChange);sats(noChange);
      if(total-options.sats>=withChange+546){fee=withChange;change=total-options.sats-fee;funded=true;break;}
      if(total-options.sats>=noChange){fee=total-options.sats;change=0;funded=true;break;}
    }
    if(!funded)throw Error('Insufficient BTC for amount and miner fee');
    tx.addOutput({script:destination.script,amount:BigInt(options.sats)});
    if(change)tx.addOutput({script,amount:BigInt(change)});
    const fresh=async()=>{
      const rows=await utxos(address,fetchFn);
      for(const c of selected)if(!rows.some(r=>r.txid===c.txid&&r.vout===c.vout&&r.value===c.value))throw Error('BTC funding spent or changed');
      gate(fee); // Includes fresh killfile + policy + BRC-181, immediately pre-sign / pre-broadcast.
    };
    await fresh();
    guard.reserve({asset:'btc',amount:options.sats,to:destination.address,fee});
    const secret=Uint8Array.from(key.toArray('be',32));
    try{if(tx.sign(secret)!==selected.length)throw Error('BTC signing incomplete');}finally{secret.fill(0);}
    tx.finalize();
    if(tx.fee!==BigInt(fee)||fee<Math.ceil(rate*tx.vsize))throw Error('BTC signed fee/weight mismatch; hold retained');
    const rawTx=tx.hex,txid=tx.id;
    treasuryEvidence(options.root,'btc',guard.id,{version:1,operation:'btc-send',asset:'btc',paymentId:guard.id,derivation:BTC_DOMAIN,address,to:destination.address,amount:options.sats,fee,rateSatPerVbyte:rate,vsize:tx.vsize,inputs:selected,change,txid,rawTx});
    await fresh();
    const ack=(await request('/tx',fetchFn,rawTx)).trim();
    if(ack!==txid)throw Error('Ambiguous BTC broadcast acknowledgement; HOLD retained, never retry');
    guard.log({t:new Date().toISOString(),asset:'btc',kind:'btc-send',to:destination.address,amount:options.sats,fee,txid});
    return {txid,amount:options.sats,fee};
  });
}
