import { BigNumber, BSM, P2PKH, PrivateKey, PublicKey, SatoshisPerKilobyte, Signature, Spend, Transaction, Utils } from '@bsv/sdk';
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './gryd-agent';
import { propertyKey, sourceTransaction, unspent } from './gryd-buy';
import { inscriptionScript } from './gryd-mint';
import { withPaymentGuard } from './payment-guard';
import { loadVault } from './vault';
import { defaultBroadcast } from './send';

/** Application domain, NOT Locus signed-write authorization. See pinned spec. */
export const ATTESTATION_PREFIX = 'Dogfood Attestation v1\n';
export const MAX_OBSERVATION_BYTES = 32768;
const MAX_RESPONSE_BYTES = 2097152;
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
export interface Observation {
  type: string; lat: number; lng: number; observedAt: string;
  source: {kind:'api'|'sensor'|'human'; ref:string};
  payload: Record<string,unknown>;
  agent: {id:string; ownerAddress:string};
}
export interface Attestation {observation:Observation; pubkey:string; signature:string}
function invalid(message:string):never {throw new Error('Invalid attestation: '+message);}
function text(v:unknown,max:number):v is string {
  return typeof v==='string' && v.length>0 && Buffer.byteLength(v,'utf8')<=max && Buffer.from(v).toString('utf8')===v && !/[\x00-\x1f\x7f]/.test(v);
}
/** Bound traversal before serialization. Never invoke accessors or toJSON. */
function safeJson(value:unknown,wrapper=false) {
  const maxBytes=MAX_OBSERVATION_BYTES+(wrapper?1024:0);
  let nodes=0,bytes=0;const parents=new Set<object>();
  function visit(v:unknown,depth:number):void {
    if(++nodes>4096+(wrapper?3:0)||depth>16+(wrapper?1:0))invalid('JSON complexity');
    if(typeof v==='string'){bytes+=Buffer.byteLength(v,'utf8');if(Buffer.from(v).toString('utf8')!==v)invalid('UTF-8');}
    else if(typeof v==='number'){if(!Number.isFinite(v))invalid('finite JSON number');}
    else if(v===null||typeof v==='boolean'){}
    else if(typeof v==='object'){
      if(parents.has(v))invalid('cycle');parents.add(v);
      const array=Array.isArray(v),proto=Object.getPrototypeOf(v);
      if(!array&&proto!==Object.prototype&&proto!==null)invalid('plain JSON only');
      const keys=Reflect.ownKeys(v);
      if(keys.length>4096)invalid('JSON complexity');
      if(array&&keys.length!==v.length+1)invalid('dense array without custom keys');
      for(const k of keys){
        if(array&&k==='length')continue;
        if(typeof k!=='string'||['__proto__','constructor','prototype'].includes(k))invalid('unsafe JSON key');
        if(array&&!/^(0|[1-9][0-9]*)$/.test(k))invalid('array key');
        bytes+=Buffer.byteLength(k,'utf8');if(Buffer.from(k).toString('utf8')!==k)invalid('UTF-8 key');
        const d=Object.getOwnPropertyDescriptor(v,k)!;
        if(!d.enumerable||!('value'in d))invalid('JSON descriptor');
        visit(d.value,depth+1);
      }
      parents.delete(v);
    }else invalid('JSON values only');
    if(bytes>maxBytes)invalid('JSON size');
  }
  visit(value,0);
}
function object(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
function exact(v:unknown,keys:string[]):asserts v is Record<string,unknown> {
  if(!object(v)||Object.keys(v).sort().join(',')!==keys.sort().join(','))invalid('exact fields required');
}
export function validateObservation(value:unknown):Observation {
  safeJson(value);
  exact(value,['type','lat','lng','observedAt','source','payload','agent']);
  if(!text(value.type,96)||! /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(value.type))invalid('type namespace');
  if(typeof value.lat!=='number'||!Number.isFinite(value.lat)||Math.abs(value.lat)>90||typeof value.lng!=='number'||!Number.isFinite(value.lng)||Math.abs(value.lng)>180)invalid('lat/lng');
  if(typeof value.observedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAt)||!Number.isFinite(Date.parse(value.observedAt))||new Date(value.observedAt).toISOString()!==value.observedAt)invalid('UTC timestamp YYYY-MM-DDTHH:mm:ss.sssZ');
  exact(value.source,['kind','ref']);
  if(!['api','sensor','human'].includes(value.source.kind as string)||!text(value.source.ref,1024))invalid('source');
  exact(value.agent,['id','ownerAddress']);
  if(!text(value.agent.id,200)||!text(value.agent.ownerAddress,35))invalid('agent');
  try {new P2PKH().lock(value.agent.ownerAddress);}catch{invalid('ownerAddress');}
  // Mainnet P2PKH only; SDK lock also accepts other base58 versions.
  const decoded=Utils.fromBase58Check(value.agent.ownerAddress);
  if(decoded.prefix.length!==1||decoded.prefix[0]!==0||decoded.data.length!==20)invalid('mainnet ownerAddress');
  if(!object(value.payload))invalid('payload object');
  const json=canonicalJson(value);if(Buffer.byteLength(json)>MAX_OBSERVATION_BYTES)invalid('observation size');
  return JSON.parse(json) as Observation;
}
export function canonicalAttestationMessage(value:unknown):string {return ATTESTATION_PREFIX+canonicalJson(validateObservation(value));}
export function signObservation(value:unknown,key:PrivateKey):Attestation {
  const observation=validateObservation(value);
  if(observation.agent.ownerAddress!==key.toAddress())invalid('ownerAddress must be the signing property address');
  return {observation,pubkey:key.toPublicKey().toString(),signature:BSM.sign(Utils.toArray(canonicalAttestationMessage(observation),'utf8'),key,'base64') as string};
}
export function verifyAttestation(value:unknown):Observation {
  safeJson(value,true);exact(value,['observation','pubkey','signature']);
  const observation=validateObservation(value.observation);
  if(typeof value.pubkey!=='string'||!/^(02|03)[a-f0-9]{64}$/.test(value.pubkey)||typeof value.signature!=='string'||!/^[A-Za-z0-9+/]{87}=$/.test(value.signature))invalid('public key/signature encoding');
  const pubkey=PublicKey.fromString(value.pubkey);
  const bytes=Buffer.from(value.signature,'base64');
  if(bytes.length!==65||bytes.toString('base64')!==value.signature||bytes[0]!<31||bytes[0]!>34)invalid('compact compressed BSM');
  if(pubkey.toAddress()!==observation.agent.ownerAddress)invalid('signer ownerAddress binding');
  const message=Utils.toArray(canonicalAttestationMessage(observation),'utf8');
  const signature=Signature.fromCompact(value.signature,'base64');
  if(!BSM.verify(message,signature,pubkey))invalid('signature');
  // SDK BSM.verify checks r/s only, not the compact recovery header.
  if(!signature.RecoverPublicKey(bytes[0]!-31,new BigNumber(BSM.magicHash(message))).eq(pubkey))invalid('signature recovery header');
  return observation;
}
/** Stream-size limit plus one 30s deadline covering fetch AND body consumption. */
function boundedFetch(fetchFn:typeof fetch):typeof fetch {
  return (async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const signal=AbortSignal.timeout(30000);
    const work=(async()=>{
      const response=await fetchFn(input,{...init,redirect:'error',signal});
      if(response.status>=300&&response.status<400)throw Error('Redirect refused');
      if(Number(response.headers.get('content-length'))>MAX_RESPONSE_BYTES)throw Error('Response too large');
      const reader=response.body?.getReader();const parts:Uint8Array[]=[];let size=0;
      if(reader)try {while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>MAX_RESPONSE_BYTES)throw Error('Response too large');parts.push(r.value);}}finally{await reader.cancel();}
      return new Response(Buffer.concat(parts),{status:response.status,headers:response.headers});
    })();
    let listener:()=>void=()=>{};
    const timeout=new Promise<never>((_,reject)=>{listener=()=>reject(Error('Network deadline exceeded'));signal.addEventListener('abort',listener,{once:true});});
    try{return await Promise.race([work,timeout]);}finally{signal.removeEventListener('abort',listener);}
  }) as typeof fetch;
}
export async function verifyAttestationTx(txid:string,fetchFn:typeof fetch=globalThis.fetch.bind(globalThis)) {
  if(typeof txid!=='string'||!/^[a-f0-9]{64}$/.test(txid))invalid('txid lowercase 64 hex');
  const tx=await sourceTransaction(txid,boundedFetch(fetchFn)),output=tx.outputs[0];
  if(!output||output.satoshis!==1)invalid('output zero must be one satoshi');
  const script=output.lockingScript;
  if(script.toBinary().length>MAX_OBSERVATION_BYTES+1024||script.chunks.length!==13||!script.chunks[6]?.data)invalid('unsupported inscription script');
  const data=Buffer.from(script.chunks[6].data),json=data.toString('utf8');if(!data.equals(Buffer.from(json)))invalid('inscription UTF-8');
  const signed:unknown=JSON.parse(json),observation=verifyAttestation(signed),propertyAddress=observation.agent.ownerAddress;
  const s=signed as Attestation;
  // Exact format: JSON.stringify of the ordered wrapper, canonicalized observation.
  const expected=JSON.stringify({observation,pubkey:s.pubkey,signature:s.signature});
  if(json!==expected||script.toHex()!==inscriptionScript(propertyAddress,'application/json',expected).toHex())invalid('exact inscription/property locking address');
  return {authentic:true as const,txid,outpoint:txid+'_0',observation,propertyAddress,pubkey:s.pubkey,truthVerified:false as const,unspentChecked:false as const,confirmationChecked:false as const};
}
export type AttestOptions={root:string;observation:unknown;noBroadcast?:boolean;fetchFn?:typeof fetch;broadcast?:(raw:string)=>Promise<{txid:string}>};
export async function attestAgent(options:AttestOptions) {
  const observation=validateObservation(options.observation);
  if(options.noBroadcast!==undefined&&typeof options.noBroadcast!=='boolean')invalid('preview option');
  const fetchFn=boundedFetch(options.fetchFn??globalThis.fetch.bind(globalThis));
  return withPaymentGuard(options.root,'agent-attest',async guard=>{
    const vault=loadVault(options.root);if(vault.policy.killfileOn)throw Error('STOP_SPENDING is on');
    const property=propertyKey(vault.key),propertyAddress=property.toAddress(),mainLock=new P2PKH().lock(vault.address);
    if(propertyAddress===vault.address||observation.agent.ownerAddress!==propertyAddress)invalid('ownerAddress must be vault property address');
    // Fixed-size placeholder is NEVER signed or returned; permits unsigned fee preview.
    const placeholder:Attestation={observation,pubkey:property.toPublicKey().toString(),signature:'A'.repeat(87)+'='};
    const tx=new Transaction();tx.addOutput({satoshis:1,lockingScript:inscriptionScript(propertyAddress,'application/json',JSON.stringify(placeholder))});tx.addOutput({satoshis:0,lockingScript:mainLock,change:true});
    const fundingUrl=`${WOC}/address/${vault.address}/unspent`;
    const coins=(await unspent(fundingUrl,fetchFn)).filter(u=>u.value>1).sort((a,b)=>a.value-b.value||a.tx_hash.localeCompare(b.tx_hash)||a.tx_pos-b.tx_pos);
    let total=0,funded=false;
    for(const coin of coins){
      const previous=await sourceTransaction(coin.tx_hash,fetchFn),o=previous.outputs[coin.tx_pos];
      if(!o||o.satoshis!==coin.value||o.lockingScript.toHex()!==mainLock.toHex())throw Error('Funding chain triple/script mismatch');
      total+=coin.value;if(!Number.isSafeInteger(total))throw Error('Unsafe funding total');
      tx.addInput({sourceTXID:coin.tx_hash,sourceOutputIndex:coin.tx_pos,sourceTransaction:previous,unlockingScriptTemplate:new P2PKH().unlock(vault.key)});
      const fee=await new SatoshisPerKilobyte(1000).computeFee(tx);
      if(total>fee+1){tx.outputs[1]!.satoshis=total-fee-1;tx.outputs[1]!.change=false;funded=true;break;}
    }
    if(!funded)throw Error('Insufficient main payment coins for attestation, miner fee and change');
    const minerFee=total-1-tx.outputs[1]!.satoshis!;
    const preview={operation:'agent-attest' as const,observation,propertyAddress,minerFee,
      inputs:tx.inputs.map(i=>({outpoint:`${i.sourceTXID}_${i.sourceOutputIndex}`,satoshis:i.sourceTransaction!.outputs[i.sourceOutputIndex]!.satoshis!,role:'payment coin'})),
      outputs:tx.outputs.map((o,i)=>({index:i,satoshis:o.satoshis!,address:i===0?propertyAddress:vault.address,role:i===0?'property attestation (isolated)':'payment change'}))};
    if(options.noBroadcast)return {...preview,mode:'preview' as const};
    const fresh=await unspent(fundingUrl,fetchFn);
    for(const i of tx.inputs)if(!fresh.some(u=>u.tx_hash===i.sourceTXID&&u.tx_pos===i.sourceOutputIndex&&u.value===i.sourceTransaction!.outputs[i.sourceOutputIndex]!.satoshis))throw Error('Funding spent or chain triple mismatch');
    if(loadVault(options.root).policy.killfileOn)throw Error('STOP_SPENDING is on');
    guard.reserve({asset:'bsv',amount:0,to:propertyAddress,fee:minerFee});
    const signed=signObservation(observation,property);
    tx.outputs[0]!.lockingScript=inscriptionScript(propertyAddress,'application/json',JSON.stringify(signed));
    await tx.sign();
    for(let i=0;i<tx.inputs.length;i++){
      const input=tx.inputs[i]!,prev=input.sourceTransaction!.outputs[input.sourceOutputIndex]!;
      if(!new Spend({sourceTXID:input.sourceTXID!,sourceOutputIndex:input.sourceOutputIndex,sourceSatoshis:prev.satoshis!,lockingScript:prev.lockingScript,transactionVersion:tx.version,otherInputs:tx.inputs.filter((_,j)=>j!==i),inputIndex:i,unlockingScript:input.unlockingScript!,inputSequence:input.sequence??0xffffffff,outputs:tx.outputs,lockTime:tx.lockTime}).validate())throw Error('Input validation failed; hold retained');
    }
    const txid=tx.id('hex'),rawTx=tx.toHex(),dir=join(options.root,'gryd-attestations');
    mkdirSync(dir,{recursive:true,mode:0o700});const fd=openSync(join(dir,txid+'.json'),'wx',0o600);
    try{writeFileSync(fd,JSON.stringify({version:1,paymentId:guard.id,...preview,txid,rawTx,signed,derivation:'dogfood/gryd/property/v1'})+'\n');fsyncSync(fd);}finally{closeSync(fd);}
    if(process.platform!=='win32'){const d=openSync(dir,'r');try{fsyncSync(d);}finally{closeSync(d);}}
    const ack=await(options.broadcast??(raw=>defaultBroadcast(raw,fetchFn)))(rawTx);
    if(ack.txid!==txid)throw Error('Ambiguous broadcast acknowledgement; hold retained');
    guard.log({t:new Date().toISOString(),asset:'bsv',kind:'agent-attest',txid,amount:0,fee:minerFee,to:propertyAddress});
    return {...preview,mode:'broadcast' as const,txid};
  });
}
