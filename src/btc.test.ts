import {test,expect,spyOn} from 'bun:test';
import {PrivateKey} from '@bsv/sdk';
import {Transaction,p2wpkh,p2pkh,p2sh,p2wsh,p2tr} from '@scure/btc-signer';
import {createCipheriv} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseStoredPolicy,killVault,loadUsage} from './vault';
import {inspectPaymentHold} from './payment-guard';
import {issuePolicyEnvelope,validateCanonicalDest} from './policy-issue';
import {usageFromLog,parseBtcPolicy,evaluateBtcSend} from './policy';

test('BTC policy requires canonical prefixed entries without repairing stored tokens',()=>{
 const addresses=[dest,p2pkh(pub).address!,p2sh(p2wpkh(pub)).address!,p2tr(pub.slice(1)).address!];
 const pocket={maxPerTx:10000,maxPerDay:null,maxLifetime:null,maxFeeSats:1000};
 for(const address of addresses){
  const canonical='btc:'+address;
  expect(parseBtcPolicy({...pocket,allowlist:[canonical]})!.allowlist).toEqual([canonical]);
  expect(()=>parseBtcPolicy({...pocket,allowlist:[address]})).toThrow();
 }
 for(const invalid of ['btc:'+dest.toUpperCase(),'BTC:'+dest,'btc:'+dest.slice(0,4).toUpperCase()+dest.slice(4),'btc: '+dest,'btc:'+dest+'\n'])
  expect(()=>parseBtcPolicy({...pocket,allowlist:[invalid]})).toThrow();
});
test('BTC evaluator normalizes valid CLI bech32 while preserving base58 case',()=>{
 const pocket={maxPerTx:10000,maxPerDay:null,maxLifetime:null,maxFeeSats:1000,allowlist:['btc:'+dest]};
 expect(evaluateBtcSend(pocket,false,1000,dest)).toEqual({ok:true});
 expect(evaluateBtcSend(pocket,false,1000,dest.toUpperCase())).toEqual({ok:true});
 expect(evaluateBtcSend(pocket,false,1000,dest.slice(0,4).toUpperCase()+dest.slice(4))).toMatchObject({ok:false,code:'BAD_ADDRESS'});
 const base58=p2pkh(pub).address!;
 expect(evaluateBtcSend({...pocket,allowlist:['btc:'+base58]},false,1000,base58)).toEqual({ok:true});
 expect(evaluateBtcSend({...pocket,allowlist:['btc:'+base58.toLowerCase()]},false,1000,base58)).toMatchObject({ok:false,code:'ALLOWLIST'});
});
import {secp256k1} from '@noble/curves/secp256k1';
const key=PrivateKey.fromString('1',16), pub=Uint8Array.from(key.toPublicKey().encode(true) as number[]);
const dest=p2wpkh(pub).address!;
async function api(){return import('./btc');}
test('segwit witness signatures verify independently with existing noble dependency',async()=>{
 const h=await harness();try{await h.run();const t=Transaction.fromRaw(Buffer.from(h.raw,'hex'));
  for(let i=0;i<t.inputsLength;i++){
   const w=t.getInput(i).finalScriptWitness!;expect(w).toHaveLength(2);const sig=w[0]!,pubkey=w[1]!;
   expect(sig[sig.length-1]).toBe(1);
   const digest=t.preimageWitnessV0(i,p2pkh(pubkey).script,1,BigInt(i===0?700:1000));
   expect(secp256k1.verify(secp256k1.Signature.fromDER(sig.slice(0,-1)).toCompactRawBytes(),digest,pubkey)).toBe(true);
  }
 }finally{h.clean()}
});
test('persisted BTC intent validates operation/asset, positive amount and required nonnegative fee',async()=>{
 const h=await harness([3000]);try{const f=(async(u:unknown,i?:RequestInit)=>{if(i?.method==='POST')throw Error('ambiguous');return h.fetchFn(u as string,i);}) as typeof fetch;
  await expect(h.run({fetchFn:f})).rejects.toThrow();const p=join(h.root,'payment.pending.json'),good=JSON.parse(readFileSync(p,'utf8'));
  expect(inspectPaymentHold(h.root).pending).toBe('valid');
  for(const bad of [{asset:'bsv'},{operation:'send'},{amount:0},{amount:-1},{fee:undefined},{fee:-1},{fee:0.5}]){writeFileSync(p,JSON.stringify({...good,...bad}));expect(inspectPaymentHold(h.root).pending).toBe('invalid');}
 }finally{h.clean()}
});
test('successful BTC BRC-181 gate and cumulative fee-inclusive budget',async()=>{
 const h=await harness([3000]);try{
  const e=issuePolicyEnvelope(key,{origin:'btc-test',purpose:'test',perTxCap:1000,totalBudget:1141,maxFee:141,destCaps:[],allowlist:['btc:'+dest]});writeFileSync(join(h.root,'brc181.json'),JSON.stringify(e));
  expect((await h.run()).fee).toBe(141);await expect(h.run()).rejects.toThrow('BRC-181');expect(h.posts).toBe(1);
 }finally{h.clean()}
});
test('frozen public scalar-1 synthetic exact signed bytes',async()=>{
 const f=JSON.parse(readFileSync(join(import.meta.dir,'../testdata/btc-synthetic.json'),'utf8'));
 const h=await harness([3000]);try{expect(h.own).toBe(f.address);expect(h.coins[0]!.hex).toBe(f.sourceRawTx);expect(h.coins[0]!.id).toBe(f.sourceTxid);const r=await h.run();expect(h.raw).toBe(f.rawTx);expect(r).toEqual({txid:f.txid,amount:1000,fee:f.fee});}finally{h.clean()}
});
test('BTC CLI parsing, address, balance and default signed broadcast with intercepted transport',async()=>{
 const h=await harness([3000]);try{
  const preload=join(h.root,'preload.ts');
  writeFileSync(preload,`import {Transaction} from ${JSON.stringify(join(import.meta.dir,'../node_modules/@scure/btc-signer/index.js'))};const m=new Map(${JSON.stringify([...h.responses])});globalThis.fetch=async(u,i)=>{if(!String(u).startsWith('https://mempool.space/api/'))throw Error('Unexpected host');const p=String(u).slice('https://mempool.space/api'.length);if(i?.method==='POST'){if(p!=='/tx')throw Error('Unexpected POST');return new Response(Transaction.fromRaw(Buffer.from(String(i.body),'hex')).id);}if(!m.has(p))throw Error('Unexpected GET');const b=m.get(p);return new Response(typeof b==='string'?b:JSON.stringify(b));};`);
  const run=(args:string[])=>Bun.spawnSync([process.execPath,'--preload',preload,'src/cli.ts',...args],{cwd:join(import.meta.dir,'..'),env:{...process.env,DOGFOOD_WALLET_DIR:h.root}});
  for(const args of [[],[dest],[dest,'0'],[dest,'-1'],[dest,'1.0'],[dest,'1e3'],[dest,'0x10'],[dest,'9007199254740992'],[dest,'1','--no-broadcast']]){const r=run(['btc-send',...args]);expect(r.exitCode).not.toBe(0);expect(r.stderr.toString()).not.toContain('Unknown command');}
  const a=run(['btc-address']);expect(a.exitCode).toBe(0);expect(a.stdout.toString().trim()).toBe(h.own);
  const b=run(['btc-balance']);expect(b.exitCode).toBe(0);expect(JSON.parse(b.stdout.toString())).toMatchObject({confirmed:0,unconfirmed:3000});
  const s=run(['btc-send',dest.toUpperCase(),'1000']);expect(s.stderr.toString()).toBe('');expect(s.exitCode).toBe(0);expect(JSON.parse(s.stdout.toString())).toMatchObject({txid:h.evidence().txid,amount:1000,fee:h.evidence().fee});
 }finally{h.clean()}
});
function source(script:Uint8Array,value:number){const t=new Transaction({allowUnknownInputs:true});t.addOutput({script,amount:BigInt(value)});t.addInput({txid:'00'.repeat(32),index:0xffffffff,finalScriptSig:new Uint8Array([0])});return t;}
async function harness(values=[20000,700,1000]){
 const m=await api(),root=mkdtempSync(join(tmpdir(),'btc-test-'));
 const wrap=Buffer.alloc(32,7),iv=Buffer.alloc(12,8),cipher=createCipheriv('aes-256-gcm',wrap,iv),ct=Buffer.concat([cipher.update(key.toWif(),'utf8'),cipher.final()]);
 writeFileSync(join(root,'wrap.key'),wrap);writeFileSync(join(root,'wif.enc'),Buffer.concat([iv,cipher.getAuthTag(),ct]).toString('base64'));writeFileSync(join(root,'address.txt'),key.toAddress());
 const pocket={maxPerTx:10000,maxPerDay:50000,maxLifetime:null,allowlist:['btc:'+dest],maxFeeSats:1000};
 const policy=(patch:Record<string,unknown>={})=>writeFileSync(join(root,'policy.json'),JSON.stringify({btc:{...pocket,...patch}}));policy();
 const own=m.btcAddress(key),script=m.btcDestination(own).script,coins=values.map(v=>source(script,v));
 const rows=coins.map((t,i)=>({txid:t.id,vout:0,value:values[i],status:{confirmed:i!==0}}));
 const responses=new Map<string,unknown>([['/address/'+own+'/utxo',rows],['/fee-estimates',{'6':1}],...coins.map(t=>['/tx/'+t.id+'/hex',t.hex] as [string,unknown])]);
 let posts=0,gets=0,raw='';
 const evidence=()=>{const names=readdirSync(join(root,'btc-sends'));expect(names).toHaveLength(1);const e=JSON.parse(readFileSync(join(root,'btc-sends',names[0]!), 'utf8'));expect(names[0]).toBe(e.paymentId+'.json');return e;};
 const fetchFn=(async(u:unknown,i?:RequestInit)=>{expect(i?.redirect).toBe('error');expect(new Headers(i?.headers).get('User-Agent')).toContain('Dogfood');const url=String(u);expect(url.startsWith('https://mempool.space/api/')).toBe(true);const path=url.slice('https://mempool.space/api'.length);if(i?.method==='POST'){posts++;expect(path).toBe('/tx');raw=String(i.body);expect(evidence().rawTx).toBe(raw);expect(inspectPaymentHold(root)).toMatchObject({blocked:true,pending:'valid'});return new Response(Transaction.fromRaw(Buffer.from(raw,'hex')).id);}gets++;expect(i?.method).toBe('GET');if(!responses.has(path))throw Error('Unexpected transport '+path);const b=responses.get(path);return new Response(typeof b==='string'?b:JSON.stringify(b));}) as typeof fetch;
 const run=(extra:Record<string,unknown>={})=>m.sendBtc({root,to:dest,sats:1000,fetchFn,...extra});
 return {m,root,own,coins,rows,responses,policy,fetchFn,evidence,run,get raw(){return raw},get posts(){return posts},get gets(){return gets},clean(){rmSync(root,{recursive:true,force:true})}};
}
test('domain-separated exact self derivation and mainnet address checksums',async()=>{const m=await api();expect(m.btcKey(key).toString()).toBe(key.deriveChild(key.toPublicKey(),'dogfood/btc/v1').toString());expect(m.btcAddress(key)).not.toBe(dest);expect(m.btcAddress(key)).toStartWith('bc1q');for(const a of [dest,p2pkh(pub).address!,p2sh(p2wpkh(pub)).address!,p2wsh({type:'unknown',script:new Uint8Array([0x51])}).address!,p2tr(pub.slice(1)).address!]){expect(m.btcDestination(a).address).toBe(a);expect(validateCanonicalDest('btc:'+a)).toBe('btc:'+a);expect(()=>m.btcDestination(a.slice(0,-1)+(a.endsWith('q')?'p':'q'))).toThrow();}expect(m.btcDestination(dest.toUpperCase()).address).toBe(dest);for(const a of ['tb1qxxx',dest.slice(0,4).toUpperCase()+dest.slice(4),' '+dest,dest+'\n'])expect(()=>m.btcDestination(a)).toThrow();expect(()=>validateCanonicalDest('btc:'+dest.toUpperCase())).toThrow();});
test('smallest-first segwit signed send, own change, fee math and isolated usage',async()=>{const h=await harness();try{const r=await h.run();const tx=Transaction.fromRaw(Buffer.from(h.raw,'hex'));expect(tx.inputsLength).toBe(2);expect(tx.getInput(0).txid).toEqual(Buffer.from(h.coins[1]!.id,'hex'));expect(tx.getOutput(0).amount).toBe(1000n);expect(r.fee).toBe(700);expect(tx.outputsLength).toBe(1);expect(r.txid).toBe(tx.id);expect(h.posts).toBe(1);expect(inspectPaymentHold(h.root).blocked).toBe(false);expect(loadUsage(h.root,new Date(),'btc').spentLifetime).toBe(1000);expect(loadUsage(h.root).spentLifetime).toBe(0);expect(loadUsage(h.root,new Date(),'brc181-btc').spentLifetime).toBe(1700);}finally{h.clean()}});
test('non-dust change and conservative real witness vsize',async()=>{const h=await harness([3000]);try{const r=await h.run();const t=Transaction.fromRaw(Buffer.from(h.raw,'hex'));expect(t.outputsLength).toBe(2);expect(t.getOutput(1).script).toEqual(h.m.btcDestination(h.own).script);expect(r.fee).toBe(h.m.p2wpkhVsize(1,[22,22]));expect(r.fee).toBeGreaterThanOrEqual(t.vsize);expect(r.fee-t.vsize).toBeLessThanOrEqual(1);}finally{h.clean()}});
for(const kind of ['absent','malformed','allowlist','cap','day','lifetime','fee','brc-dest','brc-fee','brc-total','brc-invalid','kill'])test('pre-sign '+kind,async()=>{const h=await harness([3000]),sign=spyOn(Transaction.prototype,'sign');try{if(kind==='absent')writeFileSync(join(h.root,'policy.json'),'{}');if(kind==='malformed')writeFileSync(join(h.root,'policy.json'),'{"btc":{}}');if(kind==='allowlist')h.policy({allowlist:[]});if(kind==='cap')h.policy({maxPerTx:999});if(kind==='day')h.policy({maxPerDay:999});if(kind==='lifetime')h.policy({maxLifetime:999});if(kind==='fee')h.policy({maxFeeSats:1});if(kind==='kill')killVault(h.root);if(kind.startsWith('brc')){const e=issuePolicyEnvelope(key,{origin:'btc-test',purpose:'test',perTxCap:10000,totalBudget:kind==='brc-total'?1000:100000,maxFee:kind==='brc-fee'?0:10000,destCaps:[],allowlist:[kind==='brc-dest'?'btc:'+h.own:'btc:'+dest]});writeFileSync(join(h.root,'brc181.json'),kind==='brc-invalid'?'{}':JSON.stringify(e));}await expect(h.run()).rejects.toThrow();expect(sign).not.toHaveBeenCalled();expect(h.posts).toBe(0);expect(inspectPaymentHold(h.root).blocked).toBe(false);}finally{sign.mockRestore();h.clean()}});
for(const stage of [2,3])for(const kind of ['spent','kill'])test(`fresh ${stage} ${kind}`,async()=>{const h=await harness([3000]);try{let n=0;const fetchFn=(async(u:unknown,i?:RequestInit)=>{if(String(u).includes('/address/')&&++n===stage){if(stage===3)expect(h.evidence().rawTx).toBeTruthy();if(kind==='spent')return Response.json([]);killVault(h.root);}return h.fetchFn(u as string,i);}) as typeof fetch;await expect(h.run({fetchFn})).rejects.toThrow();expect(h.posts).toBe(0);expect(inspectPaymentHold(h.root).blocked).toBe(stage===3);}finally{h.clean()}});
for(const kind of ['timeout','mismatch','http','redirect'])test('ambiguous '+kind+' retains valid hold and no retry',async()=>{const h=await harness([3000]);try{let posts=0;const fetchFn=(async(u:unknown,i?:RequestInit)=>{if(i?.method==='POST'){posts++;expect(h.evidence().rawTx).toBe(String(i.body));if(kind==='timeout')throw Error('timeout');if(kind==='http')return new Response('failed',{status:400});if(kind==='redirect')return new Response('',{status:302,headers:{Location:'https://evil.example/'}});return new Response('00'.repeat(32));}return h.fetchFn(u as string,i);}) as typeof fetch;await expect(h.run({fetchFn})).rejects.toThrow();expect(inspectPaymentHold(h.root)).toMatchObject({blocked:true,pending:'valid'});await expect(h.run({fetchFn})).rejects.toThrow();expect(posts).toBe(1);expect(existsSync(join(h.root,'spends.jsonl'))).toBe(false);}finally{h.clean()}});
for(const kind of ['insufficient','txid','value','vout','lock','duplicate','fee-estimate'])test('reject untrusted '+kind,async()=>{const h=await harness([3000]);try{const path='/address/'+h.own+'/utxo';if(kind==='insufficient')h.responses.set(path,[]);if(kind==='txid')h.responses.set('/tx/'+h.coins[0]!.id+'/hex',source(h.m.btcDestination(dest).script,3000).hex);if(kind==='value')h.responses.set(path,[{...h.rows[0],value:3001}]);if(kind==='vout')h.responses.set(path,[{...h.rows[0],vout:1}]);if(kind==='lock'){const t=source(h.m.btcDestination(dest).script,3000);h.responses.set(path,[{...h.rows[0],txid:t.id}]);h.responses.set('/tx/'+t.id+'/hex',t.hex);}if(kind==='duplicate')h.responses.set(path,[h.rows[0],h.rows[0]]);if(kind==='fee-estimate')h.responses.set('/fee-estimates',{'6':0});await expect(h.run()).rejects.toThrow();expect(h.posts).toBe(0);expect(inspectPaymentHold(h.root).blocked).toBe(false);}finally{h.clean()}});
test('balance confirmed and unconfirmed sats via only utxo GET',async()=>{const h=await harness();try{expect(await h.m.btcBalance(h.own,h.fetchFn)).toEqual({confirmed:1700,unconfirmed:20000});expect(h.gets).toBe(1);}finally{h.clean()}});
test('strict BTC policy parsing, zero caps deny, scope includes only BTC amount + fee',async()=>{for(const raw of [null,[],{}, {maxPerTx:1,maxPerDay:null,maxLifetime:null,allowlist:null,maxFeeSats:-1}])expect(()=>parseStoredPolicy(JSON.stringify({btc:raw}),false)).toThrow();const h=await harness();try{h.policy({maxPerTx:0});await expect(h.run()).rejects.toThrow();}finally{h.clean()}expect(usageFromLog([JSON.stringify({asset:'btc',amount:4,fee:2}),JSON.stringify({asset:'bsv',amount:50,fee:10})],new Date(),'brc181-btc').spentLifetime).toBe(6);});
