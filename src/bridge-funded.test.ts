import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,mkdirSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {P2PKH,Transaction} from '@bsv/sdk';
import {initVault,loadVault} from './vault';import {deriveEvmAddress} from './evm';
import {inspectPaymentHold,withPaymentGuard} from './payment-guard';
import * as funded from './bridge-funded';

import {canonicalPayloadBytes,canonicalDest} from './brc181';
import {sendPayment} from './send';
import {payX402} from './x402-pay';
import {delegateX402} from './x402-delegate';
for(const surface of ['direct','delegation'])test(`bridge principal reaches guarded ${surface} signed budget`,async()=>{
 const f=setup();signedBudget(f);
 const a=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});
 await funded.reconcileBridge({root:f.root,intentId:a.intentId,providers:[f.provider],fetchFn:f.fetchFn});
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=(async(u)=>{calls++;if(String(u)==='https://synthetic/merchant')return Response.json({accepts:[{scheme:'bsv-direct',network:'bsv-main',satoshis:100000,payTo:deposit}]},{status:402});throw Error('must refuse before network exposure');}) as typeof fetch;
 try{
  if(surface==='direct'){await expect(payX402(f.root,'https://synthetic/merchant')).rejects.toMatchObject({code:'POLICY'});expect(calls).toBe(1);}
  else {const vectors=JSON.parse(readFileSync(new URL('../testdata/x402-vectors-v1.json',import.meta.url),'utf8'));const challenge={...vectors.vectors.find((v:any)=>v.name==='valid_get_empty').challenge,amount_sats:100000,payee_locking_script_hex:new P2PKH().lock(deposit).toHex()};
   const r=await delegateX402(f.root,{challenge,vaultFund:true});expect(r.ok).toBe(false);if(!r.ok)expect(r.code).toBe('POLICY');expect(calls).toBe(0);}
 }finally{globalThis.fetch=original;}
});
function signedBudget(f:ReturnType<typeof setup>,totalBudget=150000){
 const v=loadVault(f.root),vectors=JSON.parse(readFileSync(new URL('../testdata/brc-181-vectors.json',import.meta.url),'utf8'));
 const payload=JSON.parse(vectors.vectorA.canonical);
 Object.assign(payload,{issuer:v.key.toPublicKey().toString(),per_tx_cap:150000,total_budget:totalBudget,max_fee:10000,dest_allowlist:[canonicalDest(new P2PKH().lock(deposit).toHex())],dest_caps:[]});
 writeFileSync(join(f.root,'brc181.json'),JSON.stringify({payload,sig:{alg:'ECDSA-SHA256-secp256k1',issuer:payload.issuer,signature:v.key.sign(Array.from(canonicalPayloadBytes(payload))).toDER('hex')}}));
 const p=JSON.parse(readFileSync(join(f.root,'policy.json'),'utf8'));Object.assign(p,{maxSatsPerTx:200000,maxSatsPerDay:500000,allowlist:[deposit]});writeFileSync(join(f.root,'policy.json'),JSON.stringify(p));
}
for(const budget of [100226,100227])test(`ordinary BRC budget includes discarded one-satoshi change as actual miner fee ${budget}`,async()=>{
 const f=setup();signedBudget(f,budget);const v=loadVault(f.root),source=new Transaction();source.addOutput({satoshis:100227,lockingScript:new P2PKH().lock(v.address)});let broadcasts=0;
 const r=await sendPayment({root:f.root,to:deposit,amount:100000,fetchUtxos:async()=>[{tx_hash:source.id('hex'),tx_pos:0,value:100227}],fetchTxHex:async()=>source.toHex(),broadcast:async raw=>{broadcasts++;return {txid:Transaction.fromHex(raw).id('hex')};}});
 if(budget===100226){expect(r.ok).toBe(false);if(!r.ok)expect(r.code).toBe('POLICY');expect(broadcasts).toBe(0);}
 else {expect(r.ok).toBe(true);if(r.ok)expect(r.fee).toBe(227);expect(broadcasts).toBe(1);expect(JSON.parse(readFileSync(join(f.root,'spends.jsonl'),'utf8')).fee).toBe(227);}
});
for(const budget of [200451,200452])test(`repeated bridge signed total counts each fee once at exact limit ${budget}`,async()=>{
 const f=setup();signedBudget(f,budget);
 const a=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});
 await funded.reconcileBridge({root:f.root,intentId:a.intentId,providers:[f.provider],fetchFn:f.fetchFn});f.next();
 const second=funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});
 if(budget===200452){expect((await second).state).toBe('awaiting-reconciliation');expect(f.posts).toBe(2);}
 else {await expect(second).rejects.toThrow();expect(f.posts).toBe(1);}
});
for(const next of ['bridge','ordinary'])test(`signed cumulative budget rejects bridge -> ${next}`,async()=>{
 const f=setup();signedBudget(f);
 const a=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});
 await funded.reconcileBridge({root:f.root,intentId:a.intentId,providers:[f.provider],fetchFn:f.fetchFn});f.next();
 if(next==='bridge')await expect(funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn})).rejects.toThrow();
 else {const r=await sendPayment({root:f.root,to:deposit,amount:100000,fetchUtxos:async()=>{throw Error('must reject before funding lookup');}});expect(r.ok).toBe(false);if(!r.ok)expect(r.code).toBe('POLICY');}
 expect(f.posts).toBe(1);
});
test('legacy ordinary debit also constrains the next bridge',async()=>{
 const f=setup();signedBudget(f);writeFileSync(join(f.root,'spends.jsonl'),JSON.stringify({t:new Date().toISOString(),amount:100000,fee:226})+'\n');
 await expect(funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn})).rejects.toThrow();expect(f.posts).toBe(0);
});
test('ordinary send principal constrains bridge without changing separate local caps',async()=>{
 const f=setup();signedBudget(f);
 const r=await sendPayment({root:f.root,to:deposit,amount:100000,fetchUtxos:async()=>await (await f.fetchFn('https://synthetic/unspent')).json(),fetchTxHex:async id=>await (await f.fetchFn('https://synthetic/'+id+'/hex')).text(),broadcast:async raw=>({txid:Transaction.fromHex(raw).id('hex')})});expect(r.ok).toBe(true);
 await expect(funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn})).rejects.toThrow();expect(f.posts).toBe(0);
});
for(const fork of [false,true])test(`completion crash recovery revalidates pinned boundary (fork=${fork})`,async()=>{
 const f=setup();const a=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});
 const pending=readFileSync(join(f.root,'payment.pending.json'),'utf8'),parked=readFileSync(join(f.root,'payment.bridge-parked.json'),'utf8');
 await funded.reconcileBridge({root:f.root,intentId:a.intentId,providers:[f.provider],fetchFn:f.fetchFn});
 // Restore the exact exposure witnesses to model death after completion fsync,
 // before witness removal. No invented production evidence.
 writeFileSync(join(f.root,'payment.pending.json'),pending);writeFileSync(join(f.root,'payment.bridge-parked.json'),parked);
 const before=readFileSync(join(f.root,'spends.jsonl'),'utf8');
 const fetchFn=interceptRpc(f,q=>fork&&q.method==='eth_getBlockByNumber'&&q.params[0]==='0x63'?{number:'0x63',hash:'0x'+'e'.repeat(64)}:undefined);
 if(fork)await expect(funded.reconcileBridge({root:f.root,intentId:a.intentId,providers:[f.provider],fetchFn})).rejects.toThrow();
 else expect((await funded.reconcileBridge({root:f.root,intentId:a.intentId,providers:[f.provider],fetchFn})).state).toBe('complete');
 expect(inspectPaymentHold(f.root).blocked).toBe(fork);expect(readFileSync(join(f.root,'spends.jsonl'),'utf8')).toBe(before);
});
function interceptRpc(f:ReturnType<typeof setup>,change:(q:any)=>any):typeof fetch{return (async(u,i)=>{
 if(String(u)==='https://mainnet.base.org'){const result=change(JSON.parse(String(i?.body)));if(result!==undefined)return Response.json({jsonrpc:'2.0',id:1,result});}
 return f.fetchFn(u,i);
}) as typeof fetch;}
for(const kind of ['rpc-error','chain','missing','malformed','fork'])test(`pre-order boundary ${kind} refuses before provider exposure`,async()=>{
 const f=setup();const fetchFn=interceptRpc(f,q=>{
  if(kind==='rpc-error')throw Error('offline');
  if(q.method==='eth_chainId'&&kind==='chain')return '0x1';
  if(q.method==='eth_getBlockByNumber'){
   if(kind==='missing')return null;
   if(kind==='malformed')return {number:'0x063',hash:blockHash};
   if(kind==='fork')return {number:'0x63',hash:q.params[0]==='latest'?blockHash:'0x'+'e'.repeat(64)};
  }
 });
 await expect(funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn})).rejects.toThrow();expect(f.creates).toBe(0);expect(f.posts).toBe(0);expect(inspectPaymentHold(f.root).blocked).toBe(false);
});
for(const kind of ['historical','equal','missing','malformed','fork','unfinalized'])test(`reconciliation boundary ${kind} retains durable exposure`,async()=>{
 const f=setup();const a=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});
 const path=join(f.root,'bridge-records',a.intentId,'intent.json'),i=JSON.parse(readFileSync(path,'utf8'));
 if(kind==='missing'){delete i.baseBoundary;writeFileSync(path,JSON.stringify(i));}
 if(kind==='malformed'){i.baseBoundary={chainId:'0x2105',number:'0x063',hash:blockHash};writeFileSync(path,JSON.stringify(i));}
 if(kind==='historical'||kind==='equal'){f.receipt.blockNumber=kind==='historical'?'0x62':'0x63';f.receipt.logs[0].blockNumber=f.receipt.blockNumber;}
 const fetchFn=interceptRpc(f,q=>q.method==='eth_getBlockByNumber'&&kind==='fork'&&q.params[0]==='0x63'?{number:'0x63',hash:'0x'+'e'.repeat(64)}:q.method==='eth_getBlockByNumber'&&kind==='unfinalized'&&q.params[0]==='finalized'?{number:'0x62',hash:blockHash}:undefined);
 await expect(funded.reconcileBridge({root:f.root,intentId:a.intentId,providers:[f.provider],fetchFn})).rejects.toThrow();expect(inspectPaymentHold(f.root).blocked).toBe(true);expect(readFileSync(join(f.root,'spends.jsonl'),'utf8')).not.toContain('bridge-in');
});
test('boundary is durably recorded before create, survives restart and admits newer finalized payout',async()=>{
 const f=setup(),create=f.provider.create;
 f.provider.create=async()=>{const id=JSON.parse(readFileSync(join(f.root,'payment.pending.json'),'utf8')).id;
  expect(JSON.parse(readFileSync(join(f.root,'bridge-records',id,'intent.json'),'utf8')).baseBoundary).toEqual({chainId:'0x2105',number:'0x63',hash:blockHash});return create();};
 const a=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});
 const done=await funded.reconcileBridge({root:f.root,intentId:a.intentId,providers:[f.provider],fetchFn:f.fetchFn});expect(done.state).toBe('complete');expect(inspectPaymentHold(f.root).blocked).toBe(false);
});

const roots:string[]=[];afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const deposit='1BoatSLRHtKNngkdXEeobR76b53LETtpyT', payoutHash='0x'+'b'.repeat(64),blockHash='0x'+'c'.repeat(64);
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function setup(){
 const root=mkdtempSync(join(tmpdir(),'bridge-funded-'));roots.push(root);initVault(root);
 const policy=JSON.parse(readFileSync(join(root,'policy.json'),'utf8'));policy.bridge={maxSatsPerSwap:200000,maxSatsPerDay:500000};writeFileSync(join(root,'policy.json'),JSON.stringify(policy));
 const vault=loadVault(root),pocket=deriveEvmAddress(vault.key);const source=new Transaction();source.addOutput({satoshis:500000,lockingScript:new P2PKH().lock(vault.address)});
 let raw='',posts=0,creates=0,orderId='synthetic00001';
 const provider:any={name:'fixture',quote:async({fromAmountSats}:any)=>({provider:'fixture',fromAsset:'bsv',toAsset:'usdc-base',fromAmountSats,toAmount:1000000}),create:async()=>{creates++;return {provider:'fixture',id:orderId,depositAddress:deposit,depositAmountSats:100000,payoutAddress:pocket,payoutAmount:1000000,status:'waiting'};},status:async(id:string)=>({provider:'fixture',id,depositAddress:deposit,depositAmountSats:100000,payoutAddress:pocket,payoutAmount:999999,status:'finished',depositHash:Transaction.fromHex(raw).id('hex'),payoutHash})};
 const receipt:any={status:'0x1',transactionHash:payoutHash,blockNumber:'0x64',blockHash,logs:[{address:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',topics:[transfer,'0x'+'0'.repeat(64),'0x'+pocket.slice(2).toLowerCase().padStart(64,'0')],data:'0x'+(999999).toString(16).padStart(64,'0'),transactionHash:payoutHash,blockHash,blockNumber:'0x64',logIndex:'0x0',removed:false}]};
 const fetchFn=(async(u:any,i:any)=>{const url=String(u);
  if(url.endsWith('/unspent')) return Response.json([{tx_hash:source.id('hex'),tx_pos:0,value:500000}]);
  if(url.endsWith('/'+source.id('hex')+'/hex')) return new Response(source.toHex());
  if(url==='https://arc.gorillapool.io/v1/tx'){posts++;raw=JSON.parse(i.body).rawTx;return Response.json({txid:Transaction.fromHex(raw).id('hex'),txStatus:'SEEN_ON_NETWORK'});}
  if(raw&&url.endsWith('/'+Transaction.fromHex(raw).id('hex')+'/hex')) return new Response(raw);
  if(raw&&url.endsWith('/tx/hash/'+Transaction.fromHex(raw).id('hex'))) return Response.json({txid:Transaction.fromHex(raw).id('hex'),confirmations:2,blockhash:'d'.repeat(64)});
  if(url==='https://mainnet.base.org'){const q=JSON.parse(i.body);const result=q.method==='eth_chainId'?'0x2105':q.method==='eth_getTransactionReceipt'?receipt:q.method==='eth_blockNumber'?'0x80':q.method==='eth_getBlockByNumber'?{number:q.params[0]==='finalized'?'0x70':q.params[0]==='latest'?'0x63':q.params[0],hash:blockHash}:undefined;if(result===undefined)throw Error('unexpected RPC');return Response.json({jsonrpc:'2.0',id:q.id,result});}
  throw Error('Unexpected synthetic network '+url);
 }) as typeof fetch;
 return {root,provider,fetchFn,receipt,get posts(){return posts},get creates(){return creates},next(){orderId='synthetic00002';source.lockTime=1;},get raw(){return raw}};
}
test('fund -> verify actual USDC with provider attribution -> release -> duplicate no-op -> next swap',async()=>{
 const f=setup();const r=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});
 expect(r.state).toBe('awaiting-reconciliation');expect(f.posts).toBe(1);expect(inspectPaymentHold(f.root).blocked).toBe(true);
 const done=await funded.reconcileBridge({root:f.root,intentId:r.intentId,providers:[f.provider],fetchFn:f.fetchFn});
 expect(done.actualUsdc).toBe(999999);expect(inspectPaymentHold(f.root).blocked).toBe(false);
 const before=readFileSync(join(f.root,'spends.jsonl'),'utf8');
 await funded.reconcileBridge({root:f.root,intentId:r.intentId,providers:[f.provider],fetchFn:f.fetchFn});
 expect(readFileSync(join(f.root,'spends.jsonl'),'utf8')).toBe(before);f.next();
 await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});expect(f.posts).toBe(2);
});
for(const kind of ['chain','token','recipient','amount','confirmation','status','removed'])test(`reconcile rejects ${kind}, holds without accounting arrival`,async()=>{
 const f=setup();const r=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});
 let fetchFn=f.fetchFn;
 if(kind==='chain')fetchFn=(async(u,i)=>{if(String(u)==='https://mainnet.base.org'&&JSON.parse(String(i?.body)).method==='eth_chainId')return Response.json({jsonrpc:'2.0',id:1,result:'0x1'});return f.fetchFn(u,i);}) as typeof fetch;
 if(kind==='token')f.receipt.logs[0].address='0x'+'1'.repeat(40);
 if(kind==='recipient')f.receipt.logs[0].topics[2]='0x'+'2'.repeat(64);
 if(kind==='amount')f.receipt.logs[0].data='0x'+'0'.repeat(63)+'1';
 if(kind==='confirmation')f.receipt.blockNumber='0x80';
 if(kind==='status')f.receipt.status='0x0';
 if(kind==='removed')f.receipt.logs[0].removed=true;
 await expect(funded.reconcileBridge({root:f.root,intentId:r.intentId,providers:[f.provider],fetchFn})).rejects.toThrow();
 expect(inspectPaymentHold(f.root).blocked).toBe(true);expect(readFileSync(join(f.root,'spends.jsonl'),'utf8')).not.toContain('bridge-in');expect(f.posts).toBe(1);
});
test('source transaction mismatch prevents signing/broadcast; ambiguous create retains hold',async()=>{
 const f=setup();const fetchFn=(async(u,i)=>String(u).endsWith('/hex')?new Response(new Transaction().toHex()):f.fetchFn(u,i)) as typeof fetch;
 await expect(funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn})).rejects.toThrow();expect(f.posts).toBe(0);expect(inspectPaymentHold(f.root).blocked).toBe(true);
});
test('broadcast mismatch retains signed bytes and prohibits duplicate deposit',async()=>{
 const f=setup();const fetchFn=(async(u,i)=>String(u)==='https://arc.gorillapool.io/v1/tx'?Response.json({txid:'e'.repeat(64)}):f.fetchFn(u,i)) as typeof fetch;
 await expect(funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn})).rejects.toThrow();
 await expect(funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn})).rejects.toThrow();expect(f.creates).toBe(1);expect(inspectPaymentHold(f.root).blocked).toBe(true);
});
test('same payout transaction cannot be claimed by a second intent',async()=>{
 const f=setup();const a=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});
 await funded.reconcileBridge({root:f.root,intentId:a.intentId,providers:[f.provider],fetchFn:f.fetchFn});f.next();
 const b=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});
 await expect(funded.reconcileBridge({root:f.root,intentId:b.intentId,providers:[f.provider],fetchFn:f.fetchFn})).rejects.toThrow();expect(inspectPaymentHold(f.root).blocked).toBe(true);
});
test('reconcile cannot unlink another process live lock',async()=>{
 const f=setup();const a=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});
 const lock=join(f.root,'payment.lock');writeFileSync(lock,JSON.stringify({id:'another-live-process'}));
 await expect(funded.reconcileBridge({root:f.root,intentId:a.intentId,providers:[f.provider],fetchFn:f.fetchFn})).rejects.toThrow();expect(JSON.parse(readFileSync(lock,'utf8')).id).toBe('another-live-process');
});
test('corrupt signed source evidence cannot authorize reconciliation',async()=>{
 const f=setup();const r=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});
 const path=join(f.root,'bridge-records',r.intentId,'signed.json'),s=JSON.parse(readFileSync(path,'utf8'));s.sources=[];writeFileSync(path,JSON.stringify(s));
 await expect(funded.reconcileBridge({root:f.root,intentId:r.intentId,providers:[f.provider],fetchFn:f.fetchFn})).rejects.toThrow();expect(inspectPaymentHold(f.root).blocked).toBe(true);
});
test('completed accounting corrupted consistently with missing sources cannot be reused',async()=>{
 const f=setup();const r=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});
 await funded.reconcileBridge({root:f.root,intentId:r.intentId,providers:[f.provider],fetchFn:f.fetchFn});
 const p=join(f.root,'bridge-records',r.intentId,'signed.json'),s=JSON.parse(readFileSync(p,'utf8'));s.sources=[];writeFileSync(p,JSON.stringify(s));
 await expect(funded.reconcileBridge({root:f.root,intentId:r.intentId,providers:[f.provider],fetchFn:f.fetchFn})).rejects.toThrow();
});
test('missing/corrupt accounting never releases exposure',async()=>{
 for(const content of ['', '{broken']){const f=setup();const r=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});writeFileSync(join(f.root,'spends.jsonl'),content);await expect(funded.reconcileBridge({root:f.root,intentId:r.intentId,providers:[f.provider],fetchFn:f.fetchFn})).rejects.toThrow();expect(inspectPaymentHold(f.root).blocked).toBe(true);}
});


test('no-argument threshold path stays idle above low water without creating an order',async()=>{
 const f=setup();const fetchFn=(async(u,i)=>{if(String(u)==='https://mainnet.base.org'&&JSON.parse(String(i?.body)).method==='eth_call')return Response.json({jsonrpc:'2.0',id:1,result:'0x'+(6000000).toString(16).padStart(64,'0')});return f.fetchFn(u,i);}) as typeof fetch;
 expect((await funded.fundBridge({root:f.root,providers:[f.provider],fetchFn})).state).toBe('not-needed');expect(f.creates).toBe(0);expect(f.posts).toBe(0);expect(inspectPaymentHold(f.root).blocked).toBe(false);
});
test('funded execution process death after signed persistence leaves unstealable hold',async()=>{
 const f=setup();const u=await (await f.fetchFn('https://synthetic/unspent')).json();const hex=await (await f.fetchFn('https://synthetic/'+u[0].tx_hash+'/hex')).text();
 const moduleUrl=new URL('./bridge-funded.ts',import.meta.url).href;
 const order=await f.provider.create();
 const code=`import {fundBridge} from ${JSON.stringify(moduleUrl)};
 const order=${JSON.stringify(order)};await fundBridge({root:${JSON.stringify(f.root)},fromAmountSats:100000,providers:[{name:'fixture',quote:async()=>({provider:'fixture',fromAsset:'bsv',toAsset:'usdc-base',fromAmountSats:100000,toAmount:1000000}),create:async()=>order}],fetchFn:async(u,i)=>{u=String(u);if(u==='https://mainnet.base.org'){const q=JSON.parse(i.body);return Response.json({jsonrpc:'2.0',id:1,result:q.method==='eth_chainId'?'0x2105':{number:'0x63',hash:'0x'+'c'.repeat(64)}});}if(u.endsWith('/unspent'))return Response.json(${JSON.stringify(u)});if(u.endsWith('/hex'))return new Response(${JSON.stringify(hex)});if(u==='https://arc.gorillapool.io/v1/tx')process.exit(77);throw Error('unexpected network');}});`;
 const child=Bun.spawnSync([process.execPath,'-e',code],{env:{PATH:process.env.PATH!,SystemRoot:process.env.SystemRoot!,TEMP:tmpdir(),TMP:tmpdir(),TMPDIR:tmpdir()},stdout:'pipe',stderr:'pipe'});
 expect(child.exitCode).toBe(77);const id=JSON.parse(readFileSync(join(f.root,'payment.pending.json'),'utf8')).id;
 expect(existsSync(join(f.root,'bridge-records',id,'signed.json'))).toBe(true);
 const lock=readFileSync(join(f.root,'payment.lock'),'utf8');
 await expect(funded.reconcileBridge({root:f.root,intentId:id,providers:[f.provider],fetchFn:f.fetchFn})).rejects.toThrow();expect(readFileSync(join(f.root,'payment.lock'),'utf8')).toBe(lock);
});

for(const stage of ['order','signed','ack','out'])test(`funding persistence boundary ${stage} remains held without repeat`,async()=>{
 const f=setup();const create=f.provider.create;
 const block=()=>{const id=JSON.parse(readFileSync(join(f.root,'payment.pending.json'),'utf8')).id;mkdirSync(join(f.root,'bridge-records',id,stage+'.json'));};
 if(stage==='order')f.provider.create=async()=>{const o=await create();block();return o;};
 const fetchFn=(async(u,i)=>{const result=await f.fetchFn(u,i);if(stage==='signed'&&String(u).endsWith('/hex'))block();if(['ack','out'].includes(stage)&&String(u)==='https://arc.gorillapool.io/v1/tx')block();return result;}) as typeof fetch;
 await expect(funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn})).rejects.toThrow();
 expect(f.posts).toBe(['ack','out'].includes(stage)?1:0);expect(inspectPaymentHold(f.root).blocked).toBe(true);
 await expect(funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn})).rejects.toThrow();expect(f.creates).toBe(1);
});

test('completion persistence failure retains hold and never duplicates an arrival row',async()=>{
 const f=setup();const r=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});
 mkdirSync(join(f.root,'bridge-records',r.intentId,'complete.json'));
 // Corrupt completion is refused before trusting it, and neither attempt may
 // append an arrival or release pending exposure.
 const before=readFileSync(join(f.root,'spends.jsonl'),'utf8');
 for(let n=0;n<2;n++)await expect(funded.reconcileBridge({root:f.root,intentId:r.intentId,providers:[f.provider],fetchFn:f.fetchFn})).rejects.toThrow();
 expect(readFileSync(join(f.root,'spends.jsonl'),'utf8')).toBe(before);expect(inspectPaymentHold(f.root).blocked).toBe(true);
});
test('corrupt completion amount cannot be returned as verified accounting',async()=>{
 const f=setup();const r=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});await funded.reconcileBridge({root:f.root,intentId:r.intentId,providers:[f.provider],fetchFn:f.fetchFn});
 const p=join(f.root,'bridge-records',r.intentId,'complete.json'),c=JSON.parse(readFileSync(p,'utf8'));c.actualUsdc=1;writeFileSync(p,JSON.stringify(c));
 await expect(funded.reconcileBridge({root:f.root,intentId:r.intentId,providers:[f.provider],fetchFn:f.fetchFn})).rejects.toThrow();
});
test('corrupt pending amount cannot be reconciled using a merely matching intent ID',async()=>{
 const f=setup();const r=await funded.fundBridge({root:f.root,providers:[f.provider],fromAmountSats:100000,fetchFn:f.fetchFn});
 const p=join(f.root,'payment.pending.json'),pending=JSON.parse(readFileSync(p,'utf8'));pending.amount=999;writeFileSync(p,JSON.stringify(pending));
 await expect(funded.reconcileBridge({root:f.root,intentId:r.intentId,providers:[f.provider],fetchFn:f.fetchFn})).rejects.toThrow();expect(inspectPaymentHold(f.root).blocked).toBe(true);
});
