import { Hash, P2PKH, SatoshisPerKilobyte, Script, Spend, Transaction, Utils } from '@bsv/sdk';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeListingOutpoint, propertyKey, sourceTransaction, unspent } from './gryd-buy';
import { signObjectMintRequest, type SignedAgentRequest } from './gryd-agent';
import { withPaymentGuard } from './payment-guard';
import { loadVault } from './vault';
import { defaultBroadcast } from './send';
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const API = 'https://the-grid-api.fly.dev/api/v1';
const DERIVATION = 'dogfood/gryd/property/v1';
/** Dogfood application JSON, not an asserted canonical Gryd/indexer schema. */
export function agentMetadata(name: string, lat: number, lng: number) {
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || Buffer.byteLength(name,'utf8') > 200 || /[\x00-\x1f\x7f]/.test(name) || Buffer.from(name).toString('utf8') !== name) throw new Error('Invalid name: trimmed UTF-8 text, 1..200 bytes');
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 || typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) throw new Error('Invalid lat/lng coordinates');
  return {name, class:'AGENT' as const, rarity:'common' as const, lat, lng};
}
export function inscriptionScript(address: string, contentType: string, payload: string): Script {
  return new Script().writeOpCode(0).writeOpCode(0x63).writeBin(Utils.toArray('ord','utf8')).writeOpCode(0x51)
    .writeBin(Utils.toArray(contentType,'utf8')).writeOpCode(0).writeBin(Utils.toArray(payload,'utf8')).writeOpCode(0x68)
    .writeScript(new P2PKH().lock(address));
}
/** Only our exact JSON ord envelope + exact property P2PKH. Never suffix-strip. */
export function propertyInscription(script: Script, address: string): ReturnType<typeof agentMetadata> {
  const chunks = script.chunks;
  if (chunks.length !== 13 || !chunks[6]?.data) throw new Error('Unsupported property inscription');
  const text = Buffer.from(chunks[6].data).toString('utf8');
  let metadata: ReturnType<typeof agentMetadata>;
  try { const m = JSON.parse(text); metadata = agentMetadata(m.name,m.lat,m.lng); }
  catch { throw new Error('Invalid property inscription JSON'); }
  if (text !== JSON.stringify(metadata) || script.toHex() !== inscriptionScript(address,'application/json',text).toHex()) throw new Error('Property inscription ownership/format mismatch');
  return metadata;
}
function present(path: string): boolean {
  try { lstatSync(path); return true; } catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
function evidence(root: string, directory: string, filename: string, value: unknown) {
  const dir = join(root,directory); mkdirSync(dir,{recursive:true,mode:0o700});
  const fd = openSync(join(dir,filename),'wx',0o600);
  try { writeFileSync(fd,JSON.stringify(value)+'\n'); fsyncSync(fd); } finally { closeSync(fd); }
  if (process.platform !== 'win32') { const d=openSync(dir,'r'); try { fsyncSync(d); } finally { closeSync(d); } }
}
function checkBoolean(value: unknown) { if(value !== undefined && typeof value !== 'boolean') throw new Error('Invalid preview option'); }
type Common = {root:string; name:string; lat:number; lng:number; fetchFn?:typeof fetch};
export type MintOptions = Common & {noBroadcast?:boolean; broadcast?:(raw:string)=>Promise<{txid:string}>};
type Preview = {operation:'agent-mint'; propertyAddress:string; metadata:ReturnType<typeof agentMetadata>; minerFee:number; inputs:{outpoint:string;satoshis:number;role:string}[]; outputs:{index:number;satoshis:number;address:string;role:string}[]};
export type MintResult = Preview & ({mode:'preview'}|{mode:'broadcast';txid:string});
export async function mintAgent(options: MintOptions): Promise<MintResult> {
  const metadata = agentMetadata(options.name,options.lat,options.lng); checkBoolean(options.noBroadcast);
  const fetchFn=options.fetchFn??globalThis.fetch.bind(globalThis);
  return withPaymentGuard(options.root,'agent-mint',async guard=>{
    const vault=loadVault(options.root); if(vault.policy.killfileOn)throw new Error('STOP_SPENDING is on');
    const property=propertyKey(vault.key), propertyAddress=property.toAddress(), mainLock=new P2PKH().lock(vault.address);
    if(propertyAddress===vault.address)throw new Error('Property/payment key collision');
    const fundingUrl=`${WOC}/address/${vault.address}/unspent`;
    const coins=(await unspent(fundingUrl,fetchFn)).filter(u=>u.value>1).sort((a,b)=>a.value-b.value||a.tx_hash.localeCompare(b.tx_hash)||a.tx_pos-b.tx_pos);
    const tx=new Transaction();
    tx.addOutput({satoshis:1,lockingScript:inscriptionScript(propertyAddress,'application/json',JSON.stringify(metadata))});
    tx.addOutput({satoshis:0,lockingScript:mainLock,change:true});
    let total=0,funded=false;
    for(const coin of coins){
      const previous=await sourceTransaction(coin.tx_hash,fetchFn),o=previous.outputs[coin.tx_pos];
      if(!o||o.satoshis!==coin.value||o.lockingScript.toHex()!==mainLock.toHex())throw new Error('Funding chain triple/script mismatch');
      total+=coin.value;if(!Number.isSafeInteger(total))throw new Error('Unsafe funding total');
      tx.addInput({sourceTXID:coin.tx_hash,sourceOutputIndex:coin.tx_pos,sourceTransaction:previous,unlockingScriptTemplate:new P2PKH().unlock(vault.key)});
      const fee=await new SatoshisPerKilobyte(1000).computeFee(tx);
      if(total>fee+1){tx.outputs[1]!.satoshis=total-fee-1;tx.outputs[1]!.change=false;funded=true;break;}
    }
    if(!funded)throw new Error('Insufficient main payment coins for inscription, miner fee and change');
    const minerFee=total-1-tx.outputs[1]!.satoshis!;
    const preview:Preview={operation:'agent-mint',propertyAddress,metadata,minerFee,
      inputs:tx.inputs.map(i=>({outpoint:`${i.sourceTXID}_${i.sourceOutputIndex}`,satoshis:i.sourceTransaction!.outputs[i.sourceOutputIndex]!.satoshis!,role:'payment coin'})),
      outputs:tx.outputs.map((o,i)=>({index:i,satoshis:o.satoshis!,address:i===0?propertyAddress:vault.address,role:i===0?'property inscription (isolated)':'payment change'}))};
    if(options.noBroadcast)return {...preview,mode:'preview'};
    const fresh=await unspent(fundingUrl,fetchFn);
    for(const i of tx.inputs)if(!fresh.some(u=>u.tx_hash===i.sourceTXID&&u.tx_pos===i.sourceOutputIndex&&u.value===i.sourceTransaction!.outputs[i.sourceOutputIndex]!.satoshis))throw new Error('Funding spent or chain triple mismatch');
    if(loadVault(options.root).policy.killfileOn)throw new Error('STOP_SPENDING is on');
    guard.reserve({asset:'bsv',amount:0,to:propertyAddress,fee:minerFee});
    await tx.sign();
    for(let i=0;i<tx.inputs.length;i++){
      const input=tx.inputs[i]!,prev=input.sourceTransaction!.outputs[input.sourceOutputIndex]!;
      if(!new Spend({sourceTXID:input.sourceTXID!,sourceOutputIndex:input.sourceOutputIndex,sourceSatoshis:prev.satoshis!,lockingScript:prev.lockingScript,transactionVersion:tx.version,otherInputs:tx.inputs.filter((_,j)=>j!==i),inputIndex:i,unlockingScript:input.unlockingScript!,inputSequence:input.sequence??0xffffffff,outputs:tx.outputs,lockTime:tx.lockTime}).validate())throw new Error('Input validation failed; hold retained');
    }
    const txid=tx.id('hex'),rawTx=tx.toHex();
    evidence(options.root,'gryd-mints',txid+'.json',{version:1,paymentId:guard.id,...preview,txid,rawTx,derivation:DERIVATION,propertyPubkey:property.toPublicKey().toString()});
    const ack=await(options.broadcast??(raw=>defaultBroadcast(raw,fetchFn)))(rawTx);
    if(ack.txid!==txid)throw new Error('Ambiguous broadcast acknowledgement; hold retained');
    guard.log({t:new Date().toISOString(),asset:'bsv',kind:'agent-mint',txid,amount:0,fee:minerFee,to:propertyAddress});
    return {...preview,mode:'broadcast',txid};
  });
}
/** Check every advertised alias, including conflicting duplicate spellings. */
function congruent(row: unknown, body: Record<string,unknown>, requireOwnership: boolean) {
  if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('Registration result mismatch');
  const r=row as Record<string,unknown>;
  const aliases:Record<string,string[]>={txid:['txid'],vout:['vout'],name:['name'],class:['class','classType'],rarity:['rarity','rarityKey'],lat:['lat'],lng:['lng'],owner_address:['owner_address','ownerAddress'],ordinal_outpoint:['ordinal_outpoint','ordinalOutpoint'],contentType:['contentType','content_type'],contentUri:['contentUri','content_uri'],metadata:['metadata']};
  for(const [field,names] of Object.entries(aliases)){
    let seen=false;
    for(const name of names)if(Object.hasOwn(r,name)){
      seen=true;const actual=r[name],expected=body[field];
      if(field==='ordinal_outpoint') {if(typeof actual!=='string'||normalizeListingOutpoint(actual)!==expected)throw new Error('Registration outpoint mismatch');}
      else if(field==='metadata') {if(JSON.stringify(sortJson(actual))!==JSON.stringify(sortJson(expected)))throw new Error('Registration metadata mismatch');}
      else if(actual!==expected)throw new Error(`Registration ${name} mismatch`);
    }
    if(requireOwnership&&(field==='owner_address'||field==='ordinal_outpoint')&&!seen)throw new Error('Registration owner/outpoint missing');
  }
}
function sortJson(value:unknown):unknown {if(Array.isArray(value))return value.map(sortJson);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,sortJson(v)]));return value;}
export async function verifyRegistrationProfile(id:string,body:Record<string,unknown>,fetchFn:typeof fetch, retain?: (value:unknown)=>void){
  const response=await fetchFn(`${API}/agents/${encodeURIComponent(id)}`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000)});
  const text=await response.text();
  let data; try { data=JSON.parse(text); } catch { data=null; }
  retain?.({status:response.status,text,data});
  if(!response.ok)throw new Error('Registration profile lookup unavailable');
  if(data?.agent?.id!==id||data.agent.source!=='object')throw new Error('Registration profile source/id mismatch');
  congruent(data.agent,body,true); return data.agent;
}
export type RegisterOptions = Common & {mintTxid:string;noPost?:boolean};
export type RegisterResult = {mode:'signed';envelope:SignedAgentRequest<'object.mint'>;agentId?:never}|{mode:'registered';agentId:string;txid:string;checkedExisting:boolean};
export async function registerAgent(options:RegisterOptions):Promise<RegisterResult>{
  const metadata=agentMetadata(options.name,options.lat,options.lng);checkBoolean(options.noPost);
  if(typeof options.mintTxid!=='string'||!/^[a-f0-9]{64}$/.test(options.mintTxid))throw new Error('Invalid mint txid: lowercase 64 hex characters required');
  const txid=options.mintTxid,fetchFn=options.fetchFn??globalThis.fetch.bind(globalThis);
  return withPaymentGuard(options.root,'agent-register',async guard=>{
    const vault=loadVault(options.root);if(vault.policy.killfileOn)throw new Error('STOP_SPENDING is on');
    const property=propertyKey(vault.key),address=property.toAddress();
    const mint=await sourceTransaction(txid,fetchFn),output=mint.outputs[0];
    if(!output||output.satoshis!==1)throw new Error('Mint output zero must be one satoshi');
    const actual=propertyInscription(output.lockingScript,address);
    if(JSON.stringify(actual)!==JSON.stringify(metadata))throw new Error('Mint inscription supplied details mismatch');
    const hash=Utils.toHex(Hash.sha256(output.lockingScript.toBinary()).reverse());
    const checkUnspent=async()=>{if(!(await unspent(`${WOC}/script/${hash}/unspent`,fetchFn)).some(u=>u.tx_hash===txid&&u.tx_pos===0&&u.value===1))throw new Error('Mint output spent or chain triple mismatch');};
    await checkUnspent();
    const body={txid,vout:0,...metadata,owner_address:address,ordinal_outpoint:txid+'_0',contentType:'application/json',contentUri:`https://ordinals.gorillapool.io/content/${txid}_0`,metadata};
    const dir=join(options.root,'gryd-registrations'),complete=join(dir,txid+'.json');
    if(present(complete)){
      const record=JSON.parse(readFileSync(complete,'utf8'));
      if(record.version!==1||record.txid!==txid||record.rawTx!==mint.toHex()||!/^object:[0-9]+$/.test(record.agentId)||JSON.stringify(record.body)!==JSON.stringify(body))throw new Error('Invalid registration completion evidence');
      await verifyRegistrationProfile(record.agentId,body,fetchFn);
      return {mode:'registered',agentId:record.agentId,txid,checkedExisting:true};
    }
    if(present(join(dir,txid+'.intent.json')))throw new Error('Existing registration intent: reconcile manually; never blindly retry');
    await checkUnspent();
    if(loadVault(options.root).policy.killfileOn)throw new Error('STOP_SPENDING is on');
    // No-post also saves a single-use authorization intent: external submission is possible.
    if(!options.noPost)guard.reserve({asset:'bsv',amount:0,to:address,fee:0});
    const envelope=signObjectMintRequest(body,property);
    const {payload,signature,pubkey}=envelope;
    evidence(options.root,'gryd-registrations',txid+'.intent.json',{version:1,txid,rawTx:mint.toHex(),body,envelope:{payload,signature,pubkey},mode:options.noPost?'no-post':'post',paymentId:guard.id});
    if(options.noPost)return {mode:'signed',envelope};
    let responseText:string;
    try{
      const response=await fetchFn(`${API}/objects/mint`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json'},body:JSON.stringify({payload,signature,pubkey})});
      responseText=await response.text();
      evidence(options.root,'gryd-registrations',txid+'.response.json',{version:1,txid,status:response.status,text:responseText});
      if(!response.ok)throw new Error(`Registration HTTP ${response.status}; hold retained`);
    }catch(error){evidence(options.root,'gryd-registrations',txid+'.failure.json',{version:1,txid,stage:'request-or-response',message:error instanceof Error?error.message:'Unknown failure'});throw error;}
    const data=JSON.parse(responseText);
    if(data?.success!==true||!data.object||!(Number.isSafeInteger(data.object.id)&&data.object.id>0))throw new Error('Registration response object id mismatch');
    congruent(data.object,body,true);
    const agentId=`object:${data.object.id}`;
    const agent=await verifyRegistrationProfile(agentId,body,fetchFn,value=>evidence(options.root,'gryd-registrations',txid+'.profile.json',{version:1,txid,...value as Record<string,unknown>}));
    evidence(options.root,'gryd-registrations',txid+'.json',{version:1,txid,rawTx:mint.toHex(),agentId,body,agent,propertyPubkey:property.toPublicKey().toString(),derivation:DERIVATION});
    guard.log({t:new Date().toISOString(),asset:'bsv',kind:'agent-register',txid,amount:0,fee:0,to:address,agentId});
    return {mode:'registered',agentId,txid,checkedExisting:false};
  });
}
