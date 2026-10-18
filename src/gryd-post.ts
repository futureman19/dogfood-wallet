import {closeSync,fsyncSync,mkdirSync,openSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {P2PKH} from '@bsv/sdk';
import {AGENT_WRITE_ACTIONS,canonicalSignedWriteMessage,signAgentRequest,type SignedAgentRequest,type SignedWriteAction} from './gryd-agent';
import {GRYD_FUND,propertyKey,sourceTransaction} from './gryd-buy';
import {loadVault,loadUsage,vaultPaths} from './vault';
import {evaluateSend,isValidAddress} from './policy';
import {gateAgentSend,loadPolicyEnvelope} from './brc181';
import {withPaymentGuard} from './payment-guard';
const HOST='https://the-grid-api.fly.dev',BASE='/api/v1/agents';
type Obj=Record<string,unknown>;
type Route={agentId?:string;targetId?:string;grantId?:string;scheduleId?:string;signer:'main'|'property'};
type Contract={suffix:string;fields:string;required?:string;method?:'PUT';global?:boolean;extra?:'targetId'|'grantId'|'scheduleId'};
// Read-only Gryd open-world 1619718 web api/{agent,agentMarket,
// agentWorldActions,client}.ts and backend router/controllers.
const CONTRACTS:Partial<Record<SignedWriteAction,Contract>>={
 'agent.create':{suffix:'',global:true,fields:'name type lat lng owner_address model skills greeting background spending_policy triggerRadiusM triggerWord',required:'name lat lng'},
 'agent.update':{suffix:'',method:'PUT',fields:'name owner_address triggerRadiusM triggerWord model skills greeting background status spending_policy'},
 'agent.fund':{suffix:'/fund',fields:'txid vout',required:'txid vout'},
 'agent.withdraw':{suffix:'/withdraw',fields:'amount owner_address',required:'amount'},
 'agent.authorize':{suffix:'/authorize',fields:'spending_policy owner_address',required:'spending_policy'},
 'agent.mine':{suffix:'/mine',global:true,fields:'owner_address'},
 'agent.transactions':{suffix:'/transactions',fields:'limit'},
 'agent.conversation':{suffix:'/conversation',fields:''},
 'agent.runs':{suffix:'/runs',fields:'limit'},
 'agent.invoke':{suffix:'/invoke',fields:'prompt conversation_id',required:'prompt'},
 'agent.approach':{suffix:'/approach',fields:'lat lng',required:'lat lng'},
 'agent.invoke_agent':{suffix:'/to/{targetId}/invoke',extra:'targetId',fields:'prompt',required:'prompt'},
 'agent.brain.read':{suffix:'/brain/full',fields:''},
 'agent.brain.update':{suffix:'/brain',method:'PUT',fields:'domain frameworks guidelines principles'},
 'agent.list':{suffix:'/list',fields:'price_sats listing_type outpoint list_txid',required:'price_sats listing_type outpoint list_txid'},
 'agent.cancel_listing':{suffix:'/listing/cancel',fields:'cancel_txid',required:'cancel_txid'},
 'agent.buy':{suffix:'/listing/close',fields:'close_txid',required:'close_txid'},
 'agent.capabilities.read':{suffix:'/capabilities/list',fields:''},
 'agent.capability.grant':{suffix:'/capabilities',fields:'capability scope limits expiresAt',required:'capability scope limits expiresAt'},
 'agent.capability.revoke':{suffix:'/capabilities/{grantId}/revoke',extra:'grantId',fields:''},
 'agent.action.dry_run':{suffix:'/actions/dry-run',fields:'requestId action target params',required:'requestId action target params'},
 'agent.action.execute':{suffix:'/actions',fields:'requestId action target params',required:'requestId action target params'},
 'agent.actions.read':{suffix:'/actions/list',fields:''},
 'agent.schedule.create':{suffix:'/schedules',fields:'capability target params cadence hourUtc',required:'capability target params cadence'},
 'agent.schedule.list':{suffix:'/schedules/list',fields:''},
 'agent.schedule.update':{suffix:'/schedules/{scheduleId}',extra:'scheduleId',fields:'enabled',required:'enabled'},
 'agent.schedule.delete':{suffix:'/schedules/{scheduleId}/delete',extra:'scheduleId',fields:''},
};
function object(value:unknown):Obj{if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('Expected plain JSON object');return value as Obj;}
function fields(value:Obj,allowed:string,required=''){const keys=allowed.split(' ').filter(Boolean);if(Object.keys(value).some(k=>!keys.includes(k)))throw Error('Unknown body or route metadata field');for(const key of required.split(' ').filter(Boolean))if(!Object.hasOwn(value,key))throw Error(`Missing ${key}`);}
function id(value:unknown):string{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(value))throw Error('Invalid route identifier');return value;}
function positive(value:unknown){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<=0)throw Error('Amount/limit must be positive safe integer');}
function txid(value:unknown){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error('Invalid lowercase transaction id');}
function validateBody(action:string,body:Obj){
 if(body.action!==undefined||body.capability!==undefined){
  const name=body.action??body.capability;
  if(!['world.read_area','world.read_history','area.summarize'].includes(String(name)))throw Error('Unsupported executor action: only bounded reads in agent-post');
  const area=(value:unknown)=>{const a=object(value);if(a.type!=='area')throw Error('Invalid area type');fields(a,'type lat lng radiusM','type lat lng radiusM');validateBody('area',{lat:a.lat,lng:a.lng});positive(a.radiusM);if((a.radiusM as number)>5000)throw Error('Invalid radius');};
  if(body.target!==undefined)area(body.target);
  if(body.scope!==undefined){const s=object(body.scope);fields(s,'type center radiusM','type center radiusM');if(s.type!=='radius')throw Error('Invalid scope');const center=object(s.center);fields(center,'lat lng','lat lng');area({type:'area',...center,radiusM:s.radiusM});const limits=object(body.limits);fields(limits,'maxPerHour maxPerDay','maxPerHour maxPerDay');for(const n of Object.values(limits)){positive(n);if((n as number)>10000)throw Error('Invalid quota');}if(typeof body.expiresAt!=='string'||!Number.isFinite(Date.parse(body.expiresAt)))throw Error('Invalid expiry');}
 }
 for(const key of ['amount','price_sats','limit','conversation_id'])if(body[key]!==undefined&&body[key]!==null)positive(body[key]);
 for(const key of ['txid','list_txid','cancel_txid','close_txid'])if(body[key]!==undefined)txid(body[key]);
 if(action==='agent.withdraw')positive(body.amount);
 if(body.vout!==undefined&&(!Number.isSafeInteger(body.vout)||(body.vout as number)<0||(body.vout as number)>0xffffffff))throw Error('Invalid vout');
 for(const [key,max] of [['lat',90],['lng',180]] as const)if(body[key]!==undefined&&(typeof body[key]!=='number'||!Number.isFinite(body[key])||Math.abs(body[key] as number)>max))throw Error('Invalid coordinates');
 for(const key of ['name','prompt','domain','model','greeting','background','triggerWord','type','status','requestId','expiresAt'])if(body[key]!==undefined&&(typeof body[key]!=='string'||!(body[key] as string).trim()))throw Error(`Invalid ${key}`);
 if(body.owner_address!==undefined&&(typeof body.owner_address!=='string'||!isValidAddress(body.owner_address)&&!/^(02|03)[a-f0-9]{64}$/.test(body.owner_address)))throw Error('Invalid owner_address');
 for(const key of ['spending_policy','params','target','scope','limits','guidelines'])if(body[key]!==undefined)object(body[key]);
 for(const key of ['skills','principles'])if(body[key]!==undefined&&(!Array.isArray(body[key])||!(body[key] as unknown[]).every(v=>typeof v==='string')))throw Error(`Invalid ${key}`);
 if(body.frameworks!==undefined&&!Array.isArray(body.frameworks))throw Error('Invalid frameworks');
 if(body.triggerRadiusM!==undefined&&(!Number.isSafeInteger(body.triggerRadiusM)||(body.triggerRadiusM as number)<1||(body.triggerRadiusM as number)>5000))throw Error('Invalid trigger radius');
 if(body.enabled!==undefined&&typeof body.enabled!=='boolean')throw Error('Invalid enabled');
 if(action==='agent.list'&&(body.listing_type!=='sale'||typeof body.outpoint!=='string'||!/^[a-f0-9]{64}_(0|[1-9][0-9]*)$/.test(body.outpoint)||body.outpoint!==body.list_txid+'_0'))throw Error('Only output-zero chain-backed sale listings supported');
 if(action==='agent.schedule.create'){
  if(!['hourly','daily'].includes(String(body.cadence)))throw Error('Invalid cadence');
  if(body.cadence==='daily'&&(!Number.isInteger(body.hourUtc)||(body.hourUtc as number)<0||(body.hourUtc as number)>23)||body.cadence==='hourly'&&body.hourUtc!==undefined)throw Error('Invalid hourUtc');
 }
}
export type PostPlan={action:SignedWriteAction;method:'POST'|'PUT'|'DELETE';path:string;signedPath:string;route:Route;body:Obj};
/** No keys or I/O. Metadata is never copied into the signed wire body. */
export function planAgentPost(action:string,input:unknown):PostPlan{
 if(!(AGENT_WRITE_ACTIONS as readonly string[]).includes(action)||!Object.hasOwn(CONTRACTS,action))throw Error('Unsupported action: lock/unlock need a verified economic contract; non-agent namespaces forbidden');
 const c=CONTRACTS[action as SignedWriteAction]!;
 const outer=object(input);fields(outer,'route body','route body');const metadata=object(outer.route),body=object(outer.body);
 canonicalSignedWriteMessage({mode:'signed_write',method:'POST',path:BASE,action:action as SignedWriteAction,body:outer,timestamp:0,nonce:'validation',network:'mainnet',audience:'the-grid-api.fly.dev'});
 fields(metadata,`signer ${c.global?'':'agentId'} ${c.extra??''}`,`${c.global?'':'agentId'} ${c.extra??''}`);fields(body,c.fields,c.required);validateBody(action,body);
 if(metadata.signer!==undefined&&!['main','property'].includes(String(metadata.signer)))throw Error('Invalid signer choice');
 const route:Route={...metadata,signer:(metadata.signer??'main') as Route['signer']};
 let path=BASE+(c.global?'':'/'+encodeURIComponent(id(metadata.agentId)))+c.suffix;
 if(c.extra)path=path.replace('{'+c.extra+'}',encodeURIComponent(id(metadata[c.extra])));
 return {action:action as SignedWriteAction,method:c.method??'POST',path,signedPath:decodeURIComponent(path),route,body:JSON.parse(JSON.stringify(body))};
}
function evidence(root:string,nonce:string,stage:string,value:unknown){
 const dir=join(root,'gryd-posts');mkdirSync(dir,{recursive:true,mode:0o700});const fd=openSync(join(dir,nonce+'.'+stage+'.json'),'wx',0o600);
 try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 if(process.platform!=='win32'){const fd=openSync(dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
}
export type PostResult={status:'verified'|'unverified'|'signed';nonce:string;reason?:string;envelope?:SignedAgentRequest;amount:number;held:boolean};
class RetainedResult extends Error{constructor(readonly result:PostResult){super('Outcome retained for human reconciliation');}}
function same(actual:unknown,expected:unknown,label:string){if(!isDeepStrictEqual(actual,expected))throw Error(`Response/readback ${label} mismatch`);}
function aliases(row:Obj,names:string[],expected:unknown){let seen=false;for(const name of names)if(Object.hasOwn(row,name)){seen=true;same(row[name],expected,name);}if(!seen)throw Error(`Response/readback missing ${names[0]}`);}
const profileFields:Record<string,string[]>={owner_address:['ownerAddress','owner_address'],spending_policy:['spendingPolicy','spending_policy'],triggerRadiusM:['triggerRadiusM','trigger_radius_m']};
function profile(row:unknown,agentId:string,address:string,body:Obj={}){const r=object(row);same(r.id,agentId,'agent id');aliases(r,profileFields.owner_address!,address);for(const [key,value] of Object.entries(body))aliases(r,profileFields[key]??[key],value);return r;}
function accepted(action:SignedWriteAction,data:Obj){
 if(data.error!==undefined||data.success===false)throw Error('Backend rejected request');
 const collections:Partial<Record<SignedWriteAction,string>>={'agent.mine':'agents','agent.transactions':'transactions','agent.runs':'runs','agent.capabilities.read':'grants','agent.actions.read':'records','agent.schedule.list':'schedules'};
 const key=collections[action];if(key){if(!Array.isArray(data[key]))throw Error('Malformed response collection');return;}
 if(action==='agent.create'||action==='agent.update'){object(data.agent);return;}
 if(action==='agent.brain.read'){if(!Object.hasOwn(data,'brain'))throw Error('Malformed brain response');return;}
 if(action==='agent.approach'){if(typeof data.triggered!=='boolean')throw Error('Malformed approach response');return;}
 if(action.startsWith('agent.schedule.')){object(data.schedule);return;}
 if(action.startsWith('agent.capability.')){object(data.grant);return;}
 if(action==='agent.conversation'){if(!Array.isArray(data.messages)||!Object.hasOwn(data,'conversation_id'))throw Error('Malformed conversation response');return;}
 if(action.startsWith('agent.action.')){if(!data.receipt&&!data.decision&&!data.allowed)throw Error('Malformed action decision');return;}
 if(data.success!==true)throw Error('Missing explicit success acknowledgement');
}
async function depositAmount(plan:PostPlan,fetchFn:typeof fetch){
 const tx=await sourceTransaction(plan.body.txid as string,fetchFn),output=tx.outputs[plan.body.vout as number];
 if(!output||output.lockingScript.toHex()!==new P2PKH().lock(GRYD_FUND).toHex())throw Error('Deposit destination mismatch');positive(output.satoshis);
 const bound=tx.outputs.some(o=>{try{const bytes=Buffer.from(o.lockingScript.toBinary());if(bytes[0]!==0||bytes[1]!==106)return false;const size=bytes[2]===76?bytes[3]!:bytes[2]!,start=bytes[2]===76?4:3;if(size<1||bytes[2]!==76&&size>75||bytes.length<start+size)return false;const data=JSON.parse(bytes.subarray(start,start+size).toString('utf8'));return data.type==='agent_fund'&&data.agent_id===plan.route.agentId;}catch{return false;}});
 if(!bound)throw Error('Deposit agent binding mismatch');return output.satoshis!;
}
/** Human-only. Never retries, overrides host, clears holds, or broadcasts. */
export async function postAgent(options:{root:string;action:string;input:unknown;noPost?:boolean;fetchFn?:typeof fetch}):Promise<PostResult>{
 const plan=planAgentPost(options.action,options.input);if(options.noPost!==undefined&&typeof options.noPost!=='boolean')throw Error('Invalid no-post option');
 const fetchFn=options.fetchFn??globalThis.fetch.bind(globalThis);
 try{return await withPaymentGuard(options.root,'agent-post',async guard=>{
  const amount=plan.action==='agent.fund'?await depositAmount(plan,fetchFn):plan.action==='agent.withdraw'?plan.body.amount as number:0;
  const vault=loadVault(options.root);if(vault.policy.killfileOn)throw Error('STOP_SPENDING is on');
  const key=plan.route.signer==='property'?propertyKey(vault.key):vault.key,address=key.toAddress(),identity=key.toPublicKey().toString();
  if(plan.body.owner_address!==undefined)same(plan.body.owner_address,identity,'owner/signer');
  const to=plan.action==='agent.fund'?GRYD_FUND:address;
  if(amount>0){
   const local=evaluateSend(vault.policy,amount,to,loadUsage(options.root));if(!local.ok)throw Error(local.message);
   const loaded=loadPolicyEnvelope(vaultPaths(options.root).brc181);if(!loaded.ok)throw Error(loaded.message);
   const gate=gateAgentSend({envelope:loaded.envelope,to,amount,fee:0,spentTotal:loadUsage(options.root,new Date(),'brc181-bsv').spentLifetime});if(!gate.ok)throw Error(gate.message);
  }
  const get=async(path:string,retain?:(data:unknown)=>void):Promise<Obj>=>{const r=await fetchFn(HOST+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000)});const text=await r.text();retain?.({status:r.status,text});if(!r.ok)throw Error('Public readback unavailable');return object(JSON.parse(text));};
  let baseline:number|undefined;
  if(amount>0&&!options.noPost){const before=profile((await get(BASE+'/'+encodeURIComponent(plan.route.agentId!))).agent,plan.route.agentId!,identity);if(!Number.isSafeInteger(before.balance)||(before.balance as number)<0)throw Error('Missing balance baseline');baseline=before.balance as number;if(plan.action==='agent.withdraw'&&baseline<amount)throw Error('Insufficient agent balance');}
  // All async prerequisites finish before the final kill check and signing.
  if(loadVault(options.root).policy.killfileOn)throw Error('STOP_SPENDING is on');guard.reserve({asset:'bsv',amount,to,fee:0});
  const envelope=signAgentRequest(plan.action,plan.body,{method:plan.method,path:plan.signedPath},key);
  const {payload,signature,pubkey}=envelope,wire={payload,signature,pubkey},nonce=payload.nonce;
  evidence(options.root,nonce,'intent',{version:1,paymentId:guard.id,route:plan.route,url:HOST+plan.path,envelope:wire,signerAddress:address,amount,to,baseline,mode:options.noPost?'no-post':'post'});
  if(options.noPost)throw new RetainedResult({status:'signed',nonce,envelope,amount,held:true,reason:'Usable authorization; hold retained, never blindly retry'});
  try{
   const response=await fetchFn(HOST+plan.path,{method:plan.method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json'},body:JSON.stringify(wire)});
   const text=await response.text();evidence(options.root,nonce,'response',{status:response.status,text});if(!response.ok)throw Error(`HTTP ${response.status}; hold retained`);
   const data=object(JSON.parse(text));accepted(plan.action,data);
   if(plan.action==='agent.schedule.update'){const schedule=object(data.schedule);same(schedule.id,plan.route.scheduleId,'schedule id');same(schedule.enabled,plan.body.enabled,'schedule enabled');}
   if(plan.action==='agent.schedule.create'){const schedule=object(data.schedule);for(const [k,v] of Object.entries(plan.body))same(schedule[k],v,'schedule '+k);}
   if(plan.action==='agent.schedule.delete')same(object(data.schedule).id,plan.route.scheduleId,'schedule id');
   const retain=(value:unknown)=>evidence(options.root,nonce,'readback',value);let verified=false;
   if(['agent.create','agent.update','agent.authorize'].includes(plan.action)){
    const agentId=plan.action==='agent.create'?id(object(data.agent).id):plan.route.agentId!;const expected={...plan.body};delete expected.owner_address;
    profile(data.agent,agentId,identity,expected);profile((await get(BASE+'/'+encodeURIComponent(agentId),retain)).agent,agentId,identity,expected);verified=true;
   }else if(amount>0){
    if(plan.action==='agent.fund')same(data.credited,amount,'credited amount');const expected=baseline!+(plan.action==='agent.fund'?amount:-amount);
    if(plan.action==='agent.fund')same(data.balance,expected,'credited balance');else{
     txid(data.payout_txid);const payout=await sourceTransaction(data.payout_txid as string,fetchFn);
     const received=payout.outputs.filter(o=>o.lockingScript.toHex()===new P2PKH().lock(address).toHex()).reduce((sum,o)=>sum+(o.satoshis??0),0);
     const bound=payout.outputs.some(o=>{try{const bytes=Buffer.from(o.lockingScript.toBinary());if(bytes[0]!==0||bytes[1]!==106)return false;const size=bytes[2]===76?bytes[3]!:bytes[2]===77?bytes.readUInt16LE(3):bytes[2]!,start=bytes[2]===76?4:bytes[2]===77?5:3;const r=JSON.parse(bytes.subarray(start,start+size).toString('utf8'));return r.p==='locus'&&r.v===3&&r.op==='agent_payout'&&r.agent_id===plan.route.agentId&&r.to===address&&r.amount===amount&&Number.isSafeInteger(r.ts)&&r.ts>=payload.timestamp;}catch{return false;}});
     if(!bound)throw Error('Chain payout binding missing or stale');
     same(received,amount,'chain payout amount');evidence(options.root,nonce,'payout',{txid:data.payout_txid,rawTx:payout.toHex(),amount,address});
    }
    const after=profile((await get(BASE+'/'+encodeURIComponent(plan.route.agentId!),retain)).agent,plan.route.agentId!,identity);same(after.balance,expected,'balance delta');verified=true;
   }else if(plan.action==='agent.brain.update'){
    const brain=object(data.brain);for(const [k,v] of Object.entries(plan.body))same(brain[k],v,k);
    const summary=object(data.summary);if(typeof summary.brainHash!=='string'||!Number.isSafeInteger(summary.version))throw Error('Malformed brain summary');
    const read=await get(BASE+'/'+encodeURIComponent(plan.route.agentId!)+'/brain',retain);same(read.agent_id,plan.route.agentId,'brain agent');same(read.brain,summary,'brain summary');verified=true;
   }else if(['agent.list','agent.cancel_listing','agent.buy'].includes(plan.action)){
    const listing=object(data.listing);same(listing.agentId,plan.route.agentId,'listing agent');
    if(plan.action==='agent.list'){same(listing.sellerAddress,identity,'listing signer');same(listing.priceSats,plan.body.price_sats,'price');same(listing.listingType,plan.body.listing_type,'listing type');same(listing.outpoint,plan.body.outpoint,'outpoint');same(listing.listTxid,plan.body.list_txid,'list txid');same(listing.status,'open','listing status');const read=await get(BASE+'/'+encodeURIComponent(plan.route.agentId!)+'/listing',retain);same(read.listing,listing,'open listing');verified=true;}
    else{same(listing.status,plan.action==='agent.buy'?'sold':'cancelled','listing status');const read=await get(BASE+'/'+encodeURIComponent(plan.route.agentId!)+'/listing',retain);same(read.listing,null,'open listing absent');/* Absence cannot prove which close/cancel tx won. Retain hold. */}
   }
   if(!verified){const result:PostResult={status:'unverified',nonce,amount,held:true,reason:'Accepted response; no public readback proving this action (owner-only signed reads are not public GETs)'};evidence(options.root,nonce,'unverified',result);throw new RetainedResult(result);}
   evidence(options.root,nonce,'verified',{version:1,action:plan.action,amount,scope:'Compared request fields and corresponding public state; not SPV or backend trustlessness'});
   guard.log({t:new Date().toISOString(),asset:'bsv',kind:'agent-post',action:plan.action,nonce,amount,fee:0,to});return {status:'verified',nonce,amount,held:false};
  }catch(error){if(error instanceof RetainedResult)throw error;evidence(options.root,nonce,'failure',{message:error instanceof Error?error.message:'Unknown failure',held:true});throw error;}
 });}catch(error){if(error instanceof RetainedResult)return error.result;throw error;}
}
