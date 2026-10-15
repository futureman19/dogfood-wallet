import {closeSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {P2PKH,Transaction,Spend} from '@bsv/sdk';
import {bestQuote,BridgeError,loadBridgeConfig,planRebalance,type BridgeOrder,type BridgeProvider} from './bridge';
import {BASE_USDC,bindCreate,validateOrder,bad} from './bridge-contract';
import {withPaymentGuard,withBridgeReconciliation} from './payment-guard';
import {loadVault,vaultPaths} from './vault';
import {evaluateBridgeSwap,usageFromLog} from './policy';
import {gateAgentSend,loadPolicyEnvelope} from './brc181';
import {defaultFetchUtxos,defaultFetchTxHex,selectUtxos} from './send';
import {deriveEvmAddress,BASE_RPC} from './evm';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const TRANSFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const WOC='https://api.whatsonchain.com/v1/bsv/main';
function fail():never{throw new BridgeError('BRIDGE_HELD','Bridge evidence unresolved or inconsistent. No automatic deposit retry or hold clearing.');}
function present(p:string){try{const s=lstatSync(p);if(s.isSymbolicLink())fail();return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
function sync(dir:string){if(process.platform==='win32')return;const fd=openSync(dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function save(dir:string,name:string,row:any){const fd=openSync(join(dir,name),'wx',0o600);try{writeFileSync(fd,JSON.stringify(row)+'\n');fsyncSync(fd);}finally{closeSync(fd);}sync(dir);}
function read(dir:string,name:string):any{const p=join(dir,name);if(!present(p)||!lstatSync(p).isFile())fail();const v=JSON.parse(readFileSync(p,'utf8'));if(!v||typeof v!=='object'||Array.isArray(v))fail();return v;}
function same(a:any,b:any){return JSON.stringify(a)===JSON.stringify(b);}
function rows(root:string):any[]{const p=join(root,'spends.jsonl');if(!present(p))fail();return readFileSync(p,'utf8').split(/\r?\n/).filter(Boolean).map(s=>{const r=JSON.parse(s);if(!r||typeof r!=='object'||Array.isArray(r)||!Number.isSafeInteger(r.amount)||r.amount<0||typeof r.t!=='string'||!Number.isFinite(Date.parse(r.t)))fail();return r;});}
function append(root:string,row:any){const all=rows(root),hits=all.filter(r=>r.bridgeIntentId===row.bridgeIntentId&&r.kind===row.kind);if(hits.length){if(hits.length!==1||!same(hits[0],row))fail();return;}
 const p=join(root,'spends.jsonl'),text=readFileSync(p,'utf8');const fd=openSync(p,'a',0o600);try{writeFileSync(fd,(text&&!text.endsWith('\n')?'\n':'')+JSON.stringify(row)+'\n');fsyncSync(fd);}finally{closeSync(fd);}sync(root);
}
function directory(root:string){return join(root,'bridge-records');}
function record(root:string,id:string){if(!UUID.test(id))fail();return join(directory(root),id);}
function records(root:string){const dir=directory(root);if(!present(dir))return [];return readdirSync(dir).map(id=>{if(!UUID.test(id)||!lstatSync(record(root,id)).isDirectory())fail();const i=read(record(root,id),'intent.json');if(i.version!==1||i.intentId!==id||typeof i.provider!=='string'||!Number.isSafeInteger(i.amount)||i.amount<=0||!/^0x[0-9a-fA-F]{40}$/.test(i.pocket))fail();return i;});}
function checkHistory(root:string,active?:string){const all=rows(root),list=records(root);const ids=new Set(list.map(i=>i.intentId));
 for(const r of all){if(String(r.kind).startsWith('bridge-')||String(r.asset).startsWith('bridge-')){if(!ids.has(r.bridgeIntentId)||!['bridge-out','bridge-in'].includes(r.kind))fail();}}
 const txs=new Set<string>(),payouts=new Set<string>(),orders=new Set<string>();
 for(const i of list){const dir=record(root,i.intentId);validateBoundary(i.baseBoundary);
  if(present(join(dir,'order.json'))){const o=read(dir,'order.json'),key=i.provider+':'+o.id;if(orders.has(key))fail();orders.add(key);}
  if(present(join(dir,'signed.json'))){const s=read(dir,'signed.json');if(!HASH.test(s.txid)||Transaction.fromHex(s.raw).id('hex')!==s.txid||txs.has(s.txid))fail();validateSigned(i,validateOrder(read(dir,'order.json')),s);txs.add(s.txid);}
  if(i.intentId!==active&&!present(join(dir,'complete.json')))fail();
  for(const kind of ['out','in']){const path=join(dir,kind+'.json');if(present(path)){const expected=read(dir,kind+'.json');const hits=all.filter(r=>r.bridgeIntentId===i.intentId&&r.kind==='bridge-'+kind);if(hits.length!==1||!same(hits[0],expected))fail();}}
  if(present(join(dir,'complete.json'))){
   const c=read(dir,'complete.json'),incoming=read(dir,'in.json'),outgoing=read(dir,'out.json'),signed=read(dir,'signed.json');
   if(c.version!==1||c.state!=='complete'||c.intentId!==i.intentId||c.depositTxid!==signed.txid||!/^0x[0-9a-fA-F]{64}$/.test(c.payoutHash)||payouts.has(c.payoutHash.toLowerCase())||!Number.isSafeInteger(c.actualUsdc)||c.actualUsdc<=0||!/^0x[0-9a-fA-F]{64}$/.test(c.blockHash)||!same(outgoing,outRow(i,signed))||!same(incoming,{t:i.started,kind:'bridge-in',asset:'bridge-usdc-base',bridgeIntentId:i.intentId,paymentId:i.intentId,txid:c.payoutHash,to:i.pocket,amount:c.actualUsdc}))fail();
   if(quantity(c.blockNumber)<=quantity(i.baseBoundary.number))fail();payouts.add(c.payoutHash.toLowerCase());
  }
 }
 return list;
}
function initialize(root:string){if(present(join(root,'bridge.intent.json'))||present(join(root,'bridge.order.json')))fail();const dir=directory(root);if(!present(dir)){if(present(join(root,'spends.jsonl')))rows(root);else {const fd=openSync(join(root,'spends.jsonl'),'wx',0o600);try{fsyncSync(fd);}finally{closeSync(fd);}sync(root);}mkdirSync(dir);sync(root);}checkHistory(root);}
function decision(d:{ok:boolean;code?:string;message?:string}){if(!d.ok)throw new BridgeError(d.code??'BRIDGE_HELD',d.message??'Bridge refused');}
function validateSigned(i:any,o:BridgeOrder,s:any) {
 const tx=Transaction.fromHex(s.raw);if(tx.id('hex')!==s.txid||s.to!==o.depositAddress||!Number.isSafeInteger(s.fee)||s.fee<0||!Array.isArray(s.sources)||s.sources.length!==tx.inputs.length||!tx.inputs.length||tx.outputs.length<1||tx.outputs.length>2)fail();
 let total=0;const seen=new Set<string>();
 for(let index=0;index<tx.inputs.length;index++){
  const input=tx.inputs[index],source=Transaction.fromHex(s.sources[index]),output=source.outputs[input.sourceOutputIndex],id=source.id('hex'),op=id+':'+input.sourceOutputIndex;
  if(id!==input.sourceTXID||seen.has(op)||!output||!Number.isSafeInteger(output.satoshis)||output.satoshis!<=0||output.lockingScript.toHex()!==new P2PKH().lock(i.owner).toHex())fail();seen.add(op);total+=output.satoshis!;
  if(!new Spend({sourceTXID:id,sourceOutputIndex:input.sourceOutputIndex,sourceSatoshis:output.satoshis!,lockingScript:output.lockingScript,transactionVersion:tx.version,otherInputs:tx.inputs.filter((_,n)=>n!==index),outputs:tx.outputs,inputIndex:index,unlockingScript:input.unlockingScript!,inputSequence:input.sequence!,lockTime:tx.lockTime}).validate())fail();
 }
 if(tx.outputs[0].satoshis!==i.amount||tx.outputs[0].lockingScript.toHex()!==new P2PKH().lock(o.depositAddress).toHex()||tx.outputs.slice(1).some(v=>v.lockingScript.toHex()!==new P2PKH().lock(i.owner).toHex()||!Number.isSafeInteger(v.satoshis)||v.satoshis!<=0)||!Number.isSafeInteger(total)||total-tx.outputs.reduce((sum,v)=>sum+v.satoshis!,0)!==s.fee)fail();
 return tx;
}
function outRow(i:any,s:any){return {t:i.started,kind:'bridge-out',asset:'bridge-bsv',bridgeIntentId:i.intentId,paymentId:i.intentId,txid:s.txid,to:s.to,amount:i.amount,fee:s.fee};}
async function rpc(fetchFn:typeof fetch,method:string,params:any[]=[]){const res=await fetchFn(BASE_RPC,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(!res.ok)fail();const b=await res.json();if(b.jsonrpc!=='2.0'||b.id!==1||b.error||!Object.hasOwn(b,'result'))fail();return b.result;}
function quantity(v:any):bigint{if(typeof v!=='string'||!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v))fail();return BigInt(v);}
type BaseBoundary={chainId:string;number:string;hash:string};
function validateBoundary(b:any):BaseBoundary{
 if(!b||b.chainId!=='0x2105'||typeof b.hash!=='string'||!/^0x[0-9a-f]{64}$/.test(b.hash))fail();
 quantity(b.number);return b;
}
async function canonicalBoundary(fetchFn:typeof fetch,b:BaseBoundary){
 validateBoundary(b);
 if(quantity(await rpc(fetchFn,'eth_chainId'))!==8453n)fail();
 const block=await rpc(fetchFn,'eth_getBlockByNumber',[b.number,false]);
 if(!block||quantity(block.number)!==quantity(b.number)||block.hash?.toLowerCase()!==b.hash)fail();
}
async function captureBoundary(fetchFn:typeof fetch):Promise<BaseBoundary>{
 if(quantity(await rpc(fetchFn,'eth_chainId'))!==8453n)fail();
 // Latest, not finalized: even an existing unfinalized payout must be excluded.
 const block=await rpc(fetchFn,'eth_getBlockByNumber',['latest',false]);
 const b=validateBoundary({chainId:'0x2105',number:block?.number,hash:block?.hash?.toLowerCase()});
 await canonicalBoundary(fetchFn,b);return b;
}
async function usdcBalance(fetchFn:typeof fetch,pocket:string){if(quantity(await rpc(fetchFn,'eth_chainId'))!==8453n)fail();const r=await rpc(fetchFn,'eth_call',[{to:BASE_USDC,data:'0x70a08231'+pocket.slice(2).toLowerCase().padStart(64,'0')},'latest']);if(typeof r!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(r)||BigInt(r)>BigInt(Number.MAX_SAFE_INTEGER))fail();return Number(BigInt(r));}
export async function fundBridge(opts:{root:string;providers:BridgeProvider[];fromAmountSats?:number;fetchFn?:typeof fetch}){
 const fetchFn=opts.fetchFn??fetch;
 return withPaymentGuard(opts.root,'bridge-funded',async guard=>{
  initialize(opts.root);const vault=loadVault(opts.root),pocket=deriveEvmAddress(vault.key);
  const usage=usageFromLog(rows(opts.root).map(r=>JSON.stringify(r.asset==='bridge-bsv'?{...r,amount:r.amount+(r.fee??0)}:r)),new Date(),'bridge-bsv');
  let amount=opts.fromAmountSats;
  if(amount===undefined){decision(evaluateBridgeSwap(vault.policy.bridge,vault.policy.killfileOn,1,usage));const balance=await usdcBalance(fetchFn,pocket);const utxos=await defaultFetchUtxos(vault.address,fetchFn);const plan=planRebalance({usdcBalance:balance,bsvBalanceSats:utxos.reduce((a,u)=>a+u.value,0),thresholds:loadBridgeConfig(vaultPaths(opts.root).bridge).thresholds});if(!plan)return {state:'not-needed' as const,intentId:''};amount=plan.fromAmountSats;}
  decision(evaluateBridgeSwap(vault.policy.bridge,vault.policy.killfileOn,amount,usage));
  const quote=await bestQuote(opts.providers,{fromAmountSats:amount});const provider=opts.providers.find(p=>p.name===quote.provider)!;
  const baseBoundary=await captureBoundary(fetchFn);
  const i={version:1,intentId:guard.id,provider:provider.name,amount,pocket,owner:vault.address,started:new Date().toISOString(),baseBoundary};
  guard.reserve({asset:'bsv',amount,to:pocket});
  const dir=record(opts.root,guard.id);
  try{
   mkdirSync(dir);sync(directory(opts.root));save(dir,'intent.json',i);
   let order:BridgeOrder;
   try{order=bindCreate(validateOrder(await provider.create({quote,payoutAddress:pocket})),quote,pocket);}catch(e){const id=(e as any)?.candidateOrderId;if(typeof id==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(id))save(dir,'candidate.json',{orderId:id});throw e;}
   save(dir,'order.json',order);checkHistory(opts.root,guard.id);
   const utxos=await defaultFetchUtxos(vault.address,fetchFn);const seen=new Set<string>();for(const u of utxos){const op=u.tx_hash+':'+u.tx_pos;if(!HASH.test(u.tx_hash)||!Number.isSafeInteger(u.tx_pos)||u.tx_pos<0||!Number.isSafeInteger(u.value)||u.value<=0||seen.has(op))fail();seen.add(op);}
   const {chosen,fee,total}=selectUtxos(utxos,amount);if(!Number.isSafeInteger(total)||!chosen.length||total<amount+fee)fail();
   const change=total-amount-fee,actualFee=fee+(change>1?0:change);
   decision(evaluateBridgeSwap(vault.policy.bridge,vault.policy.killfileOn,amount+actualFee,usage));
   const policy=loadPolicyEnvelope(vaultPaths(opts.root).brc181);if(!policy.ok)decision(policy);
   if(policy.ok)decision(gateAgentSend({envelope:policy.envelope,to:order.depositAddress,amount,fee:actualFee,spentTotal:usageFromLog(rows(opts.root).map(r=>JSON.stringify(r)),new Date(),"brc181-bsv").spentLifetime}));
   const tx=new Transaction(),sources:string[]=[];
   for(const u of chosen){const raw=await defaultFetchTxHex(u.tx_hash,fetchFn),source=Transaction.fromHex(raw),o=source.outputs[u.tx_pos];if(source.id('hex')!==u.tx_hash||!o||o.satoshis!==u.value||o.lockingScript.toHex()!==new P2PKH().lock(vault.address).toHex())fail();sources.push(raw);tx.addInput({sourceTransaction:source,sourceTXID:u.tx_hash,sourceOutputIndex:u.tx_pos,unlockingScriptTemplate:new P2PKH().unlock(vault.key)});}
   tx.addOutput({satoshis:amount,lockingScript:new P2PKH().lock(order.depositAddress)});if(change>1)tx.addOutput({satoshis:change,lockingScript:new P2PKH().lock(vault.address)});
   if(present(vaultPaths(opts.root).kill))fail();
   await tx.sign();const s={txid:tx.id('hex'),raw:tx.toHex(),sources,to:order.depositAddress,fee:actualFee};save(dir,'signed.json',s);checkHistory(opts.root,guard.id);
   // Single broadcast only: deliberately do not use defaultBroadcast's fee fallback.
   const res=await fetchFn('https://arc.gorillapool.io/v1/tx',{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({rawTx:s.raw})});
   const ack=await res.json();if(!res.ok||ack.txid!==s.txid||['REJECTED','DOUBLE_SPEND_ATTEMPTED'].includes(ack.txStatus)||(ack.status!==undefined&&ack.status>=400))fail();
   save(dir,'ack.json',{txid:s.txid});const row=outRow(i,s);save(dir,'out.json',row);append(opts.root,row);save(dir,'out-committed.json',{txid:s.txid});
   guard.park();return {state:'awaiting-reconciliation' as const,intentId:guard.id,orderId:order.id,depositTxid:s.txid};
  }catch{guard.park();throw new BridgeError('BRIDGE_HELD','Bridge exposure quarantined; use bridge-status and owner reconciliation. Never automatically retry.');}
 });
}
async function verifyReceipt(fetchFn:typeof fetch,o:BridgeOrder,b:BaseBoundary){
 await canonicalBoundary(fetchFn,b);
 if(!o.payoutHash||quantity(await rpc(fetchFn,'eth_chainId'))!==8453n)fail();const r=await rpc(fetchFn,'eth_getTransactionReceipt',[o.payoutHash]);
 if(!r||r.status!=='0x1'||r.transactionHash?.toLowerCase()!==o.payoutHash.toLowerCase()||!/^0x[0-9a-fA-F]{64}$/.test(r.blockHash)||!Array.isArray(r.logs))fail();
 const height=quantity(r.blockNumber),head=quantity(await rpc(fetchFn,'eth_blockNumber')),finalized=await rpc(fetchFn,'eth_getBlockByNumber',['finalized',false]),block=await rpc(fetchFn,'eth_getBlockByNumber',[r.blockNumber,false]);
 if(height<=quantity(b.number)||head<height+11n||quantity(finalized?.number)<height||!/^0x[0-9a-fA-F]{64}$/.test(finalized?.hash)||block?.hash?.toLowerCase()!==r.blockHash.toLowerCase()||quantity(block.number)!==height)fail();
 let actual=0n;const indexes=new Set<string>();
 for(const l of r.logs){if(l.address?.toLowerCase()!==BASE_USDC||l.topics?.[0]!==TRANSFER)continue;
  if(l.removed!==false||l.transactionHash?.toLowerCase()!==o.payoutHash.toLowerCase()||l.blockHash?.toLowerCase()!==r.blockHash.toLowerCase()||l.blockNumber!==r.blockNumber||l.topics.length!==3||!/^0x[0-9a-fA-F]{64}$/.test(l.topics[1])||!/^0x[0-9a-fA-F]{64}$/.test(l.topics[2])||!/^0x[0-9a-fA-F]{64}$/.test(l.data))fail();
  quantity(l.logIndex);if(indexes.has(l.logIndex))fail();indexes.add(l.logIndex);
  if(l.topics[2].toLowerCase()==='0x'+o.payoutAddress.slice(2).toLowerCase().padStart(64,'0'))actual+=BigInt(l.data);
 }
 if(actual<=0n||actual>BigInt(Number.MAX_SAFE_INTEGER)||Number(actual)!==o.payoutAmount)fail();return {actualUsdc:Number(actual),payoutHash:o.payoutHash,blockNumber:r.blockNumber,blockHash:r.blockHash};
}
export async function reconcileBridge(opts:{root:string;intentId:string;providers:BridgeProvider[];fetchFn?:typeof fetch}){
 const dir=record(opts.root,opts.intentId),fetchFn=opts.fetchFn??fetch;
 if(!present(join(opts.root,'payment.pending.json'))){return withPaymentGuard(opts.root,'bridge-reconcile-check',async()=>{checkHistory(opts.root);return read(dir,'complete.json');});}
 return withBridgeReconciliation(opts.root,opts.intentId,async guard=>{
  const list=checkHistory(opts.root,opts.intentId),i=read(dir,'intent.json'),order=validateOrder(read(dir,'order.json')),s=read(dir,'signed.json');
  const pending=read(opts.root,'payment.pending.json');
  if(pending.asset!=='bsv'||pending.amount!==i.amount||pending.to!==i.pocket)fail();
  if(i.intentId!==guard.id||order.provider!==i.provider||order.depositAmountSats!==i.amount||order.payoutAddress.toLowerCase()!==i.pocket.toLowerCase())fail();
  if(present(join(dir,'complete.json'))){const c=read(dir,'complete.json');
   // A completion fsynced before witness removal is recoverable, but do not
   // release restored exposure on stale/forked chain evidence.
   const receipt=await verifyReceipt(fetchFn,{...order,payoutHash:c.payoutHash,payoutAmount:c.actualUsdc},i.baseBoundary);
   if(receipt.blockNumber!==c.blockNumber||receipt.blockHash!==c.blockHash)fail();guard.complete();return c;}
  const provider=opts.providers.find(p=>p.name===i.provider);if(!provider)fail();const o=validateOrder(await provider.status(order.id));
  if(o.status!=='finished'||o.id!==order.id||o.provider!==i.provider||o.depositAddress!==order.depositAddress||o.depositAmountSats!==i.amount||o.payoutAddress.toLowerCase()!==i.pocket.toLowerCase()||o.depositHash!==s.txid)fail();
  for(const other of list){if(other.intentId===i.intentId)continue;const od=record(opts.root,other.intentId);if(present(join(od,'complete.json'))&&read(od,'complete.json').payoutHash.toLowerCase()===o.payoutHash?.toLowerCase())fail();}
  if(await defaultFetchTxHex(s.txid,fetchFn)!==s.raw)fail();const res=await fetchFn(WOC+'/tx/hash/'+s.txid,{redirect:'error'});if(!res.ok)fail();const b=await res.json();if(b.txid!==s.txid||!Number.isSafeInteger(b.confirmations)||b.confirmations<1||!HASH.test(b.blockhash))fail();
  validateSigned(i,order,s);
  const receipt=await verifyReceipt(fetchFn,o,i.baseBoundary);
  // Missing acknowledged accounting is corruption, not permission to reconstruct.
  if(!present(join(dir,'out.json'))){if(present(join(dir,'ack.json')))fail();const row=outRow(i,s);save(dir,'out.json',row);append(opts.root,row);save(dir,'out-committed.json',{txid:s.txid});}
  const row={t:i.started,kind:'bridge-in',asset:'bridge-usdc-base',bridgeIntentId:i.intentId,paymentId:i.intentId,txid:receipt.payoutHash,to:i.pocket,amount:receipt.actualUsdc};
  if(!present(join(dir,'in.json')))save(dir,'in.json',row);else if(!same(read(dir,'in.json'),row))fail();append(opts.root,row);
  const result={version:1,intentId:i.intentId,state:'complete',depositTxid:s.txid,...receipt};save(dir,'complete.json',result);checkHistory(opts.root,opts.intentId);guard.complete();return result;
 });
}
export function inspectFundedBridge(root:string){try{return records(root).map(i=>{const dir=record(root,i.intentId),o=present(join(dir,'order.json'))?read(dir,'order.json'):null,s=present(join(dir,'signed.json'))?read(dir,'signed.json'):null;return {intentId:i.intentId,provider:i.provider,orderId:o?.id,depositTxid:s?.txid,state:present(join(dir,'complete.json'))?'complete':s?'signed-exposure':o?'order-recorded':'creation-unresolved'};});}catch{return [{state:'invalid'}];}}
