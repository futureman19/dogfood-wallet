import {Transaction} from '@scure/btc-signer';
import {treasuryEvidence} from './utxo-treasury';
import {dogeKey,dogeAddress,dogeDestination,canonicalDogeDest,p2pkhSize,DOGE_DOMAIN} from './doge-address';
import {loadVault,loadUsage,vaultPaths} from './vault';
import {evaluateDogeSend} from './policy';
import {loadPolicyEnvelope,gateAgentSend} from './brc181';
import {withPaymentGuard} from './payment-guard';
export {dogeKey,dogeAddress,dogeDestination,canonicalDogeDest,p2pkhSize} from './doge-address';
const API='https://api.blockcypher.com/v1/doge/main';
const HARD_DUST=100000,SOFT_DUST=1000000;
// Core v1.14.9 GetDogecoinDustFee: one soft limit per spendable output below it.
function dustFee(amount:number){return amount<SOFT_DUST?SOFT_DUST:0;}
type Coin={txid:string;vout:number;value:number;status:{confirmed:boolean}};
function koinu(n:number,positive=false):void {
 if(!Number.isSafeInteger(n)||n<(positive?1:0))throw Error('Invalid DOGE koinu');
}
export type DogeTiming={wait:(ms:number)=>Promise<void>;now?:()=>number};
function limiter(timing:DogeTiming){
 let tail=Promise.resolve(),last:number|undefined;const history:number[]=[];
 return ()=>{const turn=tail.then(async()=>{
   const now=timing.now??Date.now;let time=now();
   while(history.length&&history[0]!<=time-3600000)history.shift();
   if(history.length>=190)throw Error('DOGE local hourly request budget exhausted; no automatic retry');
   if(last!==undefined){await timing.wait(Math.max(0,350-(time-last)));time=now();}
   last=time;history.push(time);
 });tail=turn.catch(()=>{});return turn;};
}
// Shared process-wide keyless budget. Other processes/IP consumers are outside this budget.
const defaultLimit=limiter({wait:ms=>new Promise(resolve=>setTimeout(resolve,ms))});
function client(fetchFn:typeof fetch,timing?:DogeTiming){
 const limit=timing?limiter(timing):defaultLimit;
 async function request(path:string,body?:string,beforePost?:()=>void):Promise<any>{
   if(!(body===undefined?/^(?:\/|\/addrs\/[a-zA-Z0-9]+\?unspentOnly=true&limit=200|\/txs\/[a-f0-9]{64}\?includeHex=true)$/:/^\/txs\/push$/).test(path))throw Error('Invalid DOGE API route');
   await limit();beforePost?.();
   const signal=AbortSignal.timeout(30000);
   const response=await fetchFn(API+path,{method:body===undefined?'GET':'POST',redirect:'error',signal,headers:{'User-Agent':'Dogfood-Wallet/0.1 (owner-operated DOGE treasury)','Accept':'application/json',...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body}:{})});
   if(!response.ok||response.redirected||(response.url&&response.url!==API+path))throw Error('DOGE API refused or redirected: HTTP '+response.status);
   const reader=response.body?.getReader();if(!reader)throw Error('Empty DOGE API response');
   const chunks:Uint8Array[]=[];let length=0;
   const aborted=new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>{void reader.cancel();reject(Error('DOGE API timeout'));},{once:true}));
   try{while(true){signal.throwIfAborted();const row=await Promise.race([reader.read(),aborted]);if(row.done)break;length+=row.value.length;if(length>8000000)throw Error('DOGE API response too large');chunks.push(row.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{await reader.cancel();}
 }
 const sources=new Map<string,Promise<string>>();
 return {request,source(txid:string){
   // Immutable raw sources only; address/UTXO reads are NEVER cached.
   if(!sources.has(txid))sources.set(txid,request('/txs/'+txid+'?includeHex=true').then(r=>{
     if(r?.hash!==txid||typeof r.hex!=='string')throw Error('DOGE source response mismatch');return r.hex;
   }));return sources.get(txid)!;
 }};
}
async function utxos(address:string,api:ReturnType<typeof client>):Promise<Coin[]> {
 const body=await api.request('/addrs/'+address+'?unspentOnly=true&limit=200');
 if(!body||body.address!==address||(body.hasMore!==undefined&&body.hasMore!==false))throw Error('Incomplete DOGE address response');
 koinu(body.final_balance);
 for(const name of ['txrefs','unconfirmed_txrefs'])if(body[name]!==undefined&&!Array.isArray(body[name]))throw Error('Invalid DOGE refs');
 const confirmed=body.txrefs??[],unconfirmed=body.unconfirmed_txrefs??[];
 // Refuse boundary-sized pages even if the provider omits hasMore; never guess pagination.
 if(confirmed.length+unconfirmed.length>=200)throw Error('Truncated DOGE refs');
 const seen=new Set<string>(),rows:Coin[]=[];let total=0;
 for(const [refs,isConfirmed] of [[confirmed,true],[unconfirmed,false]] as const)for(const r of refs){
   if(!r||typeof r.tx_hash!=='string'||! /^[a-f0-9]{64}$/.test(r.tx_hash)||r.tx_input_n!==-1||!Number.isSafeInteger(r.tx_output_n)||r.tx_output_n<0||r.tx_output_n>0xffffffff||r.spent!==false||r.double_spend!==false||!Number.isSafeInteger(r.confirmations)||(isConfirmed?r.confirmations<=0:r.confirmations!==0))throw Error('Invalid DOGE UTXO');
   koinu(r.value);const id=r.tx_hash+':'+r.tx_output_n;if(seen.has(id))throw Error('Duplicate DOGE UTXO');seen.add(id);
   total+=r.value;koinu(total);rows.push({txid:r.tx_hash,vout:r.tx_output_n,value:r.value,status:{confirmed:isConfirmed}});
 }
 // final_balance includes the unconfirmed delta (which may itself be negative).
 // Sum only unspent outputs, rather than confusing n_tx with a UTXO count.
 if(total!==body.final_balance)throw Error('Incomplete DOGE UTXO balance');
 return rows;
}
export async function dogeBalance(address:string,fetchFn:typeof fetch=globalThis.fetch.bind(globalThis),timing?:DogeTiming){
 const rows=await utxos(dogeDestination(address).address,client(fetchFn,timing));let confirmed=0,unconfirmed=0;
 for(const r of rows){if(r.status.confirmed)confirmed+=r.value;else unconfirmed+=r.value;koinu(confirmed+unconfirmed);}
 return {confirmed,unconfirmed};
}
export type DogeSendOptions={root:string;to:string;koinu:number;fetchFn?:typeof fetch;timing?:DogeTiming};
/** Human-only. Signed exposure is always reserved and persisted; never retries. */
export async function sendDoge(options:DogeSendOptions):Promise<{txid:string;amount:number;fee:number}> {
  koinu(options.koinu,true);if(options.koinu<100000)throw Error('DOGE destination amount below dust threshold (100000 koinu)');const destination=dogeDestination(options.to);
  const api=client(options.fetchFn??globalThis.fetch.bind(globalThis),options.timing);
  return withPaymentGuard(options.root,'doge-send',async guard=>{
    const vault=loadVault(options.root),key=dogeKey(vault.key),address=dogeAddress(vault.key),script=dogeDestination(address).script;
    const gate=(fee:number)=>{
      const policy=loadVault(options.root).policy;
      const local=evaluateDogeSend(policy.doge,policy.killfileOn,options.koinu,destination.address,loadUsage(options.root,new Date(),'doge'));
      if(!local.ok)throw Error(local.message);
      if(fee>policy.doge!.maxFeeKoinu)throw Error('REJECTED: DOGE fee exceeds maxFeeKoinu');
      const loaded=loadPolicyEnvelope(vaultPaths(options.root).brc181);if(!loaded.ok)throw Error(loaded.message);
      const signed=gateAgentSend({envelope:loaded.envelope,dest:canonicalDogeDest(destination.address),amount:options.koinu,fee,spentTotal:loadUsage(options.root,new Date(),'brc181-doge').spentLifetime});
      if(!signed.ok)throw Error(signed.message);
    };
    gate(0);
    const candidates=(await utxos(address,api)).filter(r=>r.value>0).sort((a,b)=>a.value-b.value||a.txid.localeCompare(b.txid)||a.vout-b.vout);
    const estimates=await api.request('/');const estimate=estimates?.medium_fee_per_kb;
    koinu(estimate);const rate=Math.max(1000000,estimate)/1000;
    const tx=new Transaction({version:1,lockTime:0});const selected:Coin[]=[];let total=0,fee=0,change=0,funded=false;
    for(const coin of candidates){
      const hex=await api.source(coin.txid);
      if(!/^(?:[a-fA-F0-9]{2})+$/.test(hex))throw Error('Invalid DOGE source hex');
      // Source can have arbitrary other outputs; only the selected exact lock is authorized.
      const previous=Transaction.fromRaw(Buffer.from(hex,'hex'),{allowUnknownInputs:true,allowUnknownOutputs:true});
      if(previous.hasWitnesses||previous.id!==coin.txid||coin.vout>=previous.outputsLength)throw Error('DOGE source txid/vout mismatch');
      // Mining outputs are unsupported even if the provider claims maturity.
      for(let i=0;i<previous.inputsLength;i++){
        const input=previous.getInput(i);
        if(input.index===0xffffffff&&input.txid?.every(b=>b===0))throw Error('DOGE coinbase funding unsupported');
      }
      const output=previous.getOutput(coin.vout);
      if(output.amount!==BigInt(coin.value)||!output.script||!Buffer.from(output.script).equals(script))throw Error('DOGE source value/lock mismatch');
      total+=coin.value;koinu(total);selected.push(coin);
      tx.addInput({txid:coin.txid,index:coin.vout,sequence:0xffffffff,nonWitnessUtxo:Buffer.from(hex,'hex'),sighashType:1});
      const withChange=Math.ceil(rate*p2pkhSize(selected.length,[destination.script.length,script.length]))+dustFee(options.koinu);
      const noChange=Math.ceil(rate*p2pkhSize(selected.length,[destination.script.length]))+dustFee(options.koinu);
      koinu(withChange);koinu(noChange);
      const surplus=total-options.koinu;
      // Evaluate complete output sets, never classify change before subtracting its
      // surcharge and then drop that surcharge when the classification flips.
      const normalChange=surplus-withChange;
      if(normalChange>=SOFT_DUST){fee=withChange;change=normalChange;funded=true;break;}
      // A soft-change candidate would be normalChange - SOFT_DUST. If
      // normalChange < SOFT_DUST this is negative; otherwise the cheaper
      // non-soft candidate above wins. Never fold this fee-discontinuity gap.
      // Only the no-change transaction's sub-hard-dust remainder can be folded.
      // In the soft-dust fee discontinuity collect another input or fail closed.
      if(surplus>=noChange&&surplus-noChange<HARD_DUST){fee=surplus;change=0;funded=true;break;}
    }
    if(!funded)throw Error('Insufficient DOGE for amount and miner fee');
    tx.addOutput({script:destination.script,amount:BigInt(options.koinu)});
    if(change)tx.addOutput({script,amount:BigInt(change)});
    const fresh=async()=>{
      const rows=await utxos(address,api);
      for(const c of selected)if(!rows.some(r=>r.txid===c.txid&&r.vout===c.vout&&r.value===c.value))throw Error('DOGE funding spent or changed');
      gate(fee); // Includes fresh killfile + policy + BRC-181, immediately pre-sign / pre-broadcast.
    };
    await fresh();
    guard.reserve({asset:'doge',amount:options.koinu,to:destination.address,fee});
    const secret=Uint8Array.from(key.toArray('be',32));
    try{if(tx.sign(secret)!==selected.length)throw Error('DOGE signing incomplete');}finally{secret.fill(0);}
    tx.finalize();
    let signedDustFee=0;
    for(let i=0;i<tx.outputsLength;i++){
      const amount=Number(tx.getOutput(i).amount);koinu(amount);
      if(amount<HARD_DUST)throw Error('DOGE signed output below hard dust; hold retained');
      signedDustFee+=dustFee(amount);
    }
    if(tx.hasWitnesses||tx.fee!==BigInt(fee)||fee<Math.ceil(rate*tx.toBytes(true,false).length)+signedDustFee)throw Error('DOGE signed fee/size mismatch; hold retained');
    const rawTx=tx.hex,txid=tx.id;
    treasuryEvidence(options.root,'doge',guard.id,{version:1,operation:'doge-send',asset:'doge',paymentId:guard.id,derivation:DOGE_DOMAIN,address,to:destination.address,amount:options.koinu,fee,rateKoinuPerKB:rate*1000,bytes:tx.toBytes(true,false).length,inputs:selected,change,txid,rawTx});
    await fresh();
    const ack=await api.request('/txs/push',JSON.stringify({tx:rawTx}),()=>gate(fee));
    if(ack?.hash!==txid||ack.double_spend===true||ack.error||ack.errors)throw Error('Ambiguous DOGE broadcast acknowledgement; HOLD retained, never retry');
    guard.log({t:new Date().toISOString(),asset:'doge',kind:'doge-send',to:destination.address,amount:options.koinu,fee,txid});
    return {txid,amount:options.koinu,fee};
  });
}
