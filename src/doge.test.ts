import {test,expect,spyOn} from 'bun:test';
import {PrivateKey} from '@bsv/sdk';
import {Transaction,p2wpkh,p2pkh,p2sh,p2wsh,p2tr} from '@scure/btc-signer';
import {createCipheriv,createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseStoredPolicy,killVault,loadUsage} from './vault';
import {inspectPaymentHold} from './payment-guard';
import {issuePolicyEnvelope,validateCanonicalDest} from './policy-issue';
import {usageFromLog,parseDogePolicy,evaluateDogeSend} from './policy';

import {secp256k1} from '@noble/curves/secp256k1';
const key=PrivateKey.fromString('1',16), pub=Uint8Array.from(key.toPublicKey().encode(true) as number[]);
const network={pubKeyHash:0x1e,scriptHash:0x16,wif:0x9e,bech32:'doge'};
const dest=p2pkh(pub,network).address!;
async function api(){return import('./doge');}
test('persisted DOGE intent validates operation/asset, positive amount and required nonnegative fee',async()=>{
 const h=await harness([3000000]);try{const f=(async(u:unknown,i?:RequestInit)=>{if(i?.method==='POST')throw Error('ambiguous');return h.fetchFn(u as string,i);}) as typeof fetch;
  await expect(h.run({fetchFn:f})).rejects.toThrow();const p=join(h.root,'payment.pending.json'),good=JSON.parse(readFileSync(p,'utf8'));
  expect(inspectPaymentHold(h.root).pending).toBe('valid');
  for(const bad of [{asset:'bsv'},{operation:'send'},{amount:0},{amount:-1},{fee:undefined},{fee:-1},{fee:0.5}]){writeFileSync(p,JSON.stringify({...good,...bad}));expect(inspectPaymentHold(h.root).pending).toBe('invalid');}
 }finally{h.clean()}
});
function source(script:Uint8Array,value:number,txid='11'.repeat(32),index=0){const t=new Transaction({allowUnknownInputs:true});t.addOutput({script,amount:BigInt(value)});t.addInput({txid,index,finalScriptSig:new Uint8Array([0])});return t;}
for(const confirmations of [0,1,239,240,1000])test('coinbase funding rejected regardless of claimed maturity '+confirmations,async()=>{
 const h=await harness([3000000]),sign=spyOn(Transaction.prototype,'sign');try{
 const t=source(h.m.dogeDestination(h.own).script,3000000,'00'.repeat(32),0xffffffff);
 const rows=[{...h.rows[0]!,tx_hash:t.id,confirmations}];h.responses.set('/addrs/'+h.own+'?unspentOnly=true&limit=200',addressBody(h.own,rows));h.responses.set('/txs/'+t.id+'?includeHex=true',{hash:t.id,hex:t.hex});
 await expect(h.run()).rejects.toThrow('coinbase');expect(sign).not.toHaveBeenCalled();expect(h.posts).toBe(0);expect(inspectPaymentHold(h.root).blocked).toBe(false);
 }finally{sign.mockRestore();h.clean()}
});
for(const amount of [100000,100001,999999,1000000,1000001])test('soft dust payout surcharge '+amount,async()=>{
 const h=await harness([5000000]);try{h.policy({maxFeeKoinu:3000000});const r=await h.run({koinu:amount});expect(r.fee).toBe(226000+(amount<1000000?1000000:0));}finally{h.clean()}
});
for(const gate of ['local','brc-fee','brc-total'])test('soft dust surcharge capped before signing '+gate,async()=>{
 const h=await harness([5000000]),sign=spyOn(Transaction.prototype,'sign');try{
 h.policy({maxFeeKoinu:gate==='local'?1225999:3000000});
 if(gate!=='local')writeFileSync(join(h.root,'brc181.json'),JSON.stringify(issuePolicyEnvelope(key,{origin:'doge-test',purpose:'test',perTxCap:1000000,totalBudget:gate==='brc-total'?1325999:10000000,maxFee:gate==='brc-fee'?1225999:3000000,destCaps:[],allowlist:['doge:'+dest]})));
 await expect(h.run({koinu:100000})).rejects.toThrow();expect(sign).not.toHaveBeenCalled();expect(h.posts).toBe(0);expect(inspectPaymentHold(h.root).blocked).toBe(false);
 }finally{sign.mockRestore();h.clean()}
});
for(const remainder of [99999,100000,100001,999999,1000000,1000001])test('change thresholds have no circular surcharge or soft dust folding '+remainder,async()=>{
 const h=await harness([1000000+226000+remainder]),sign=spyOn(Transaction.prototype,'sign');try{
 h.policy({maxFeeKoinu:3000000});
 if(remainder<1000000){await expect(h.run()).rejects.toThrow('Insufficient');expect(sign).not.toHaveBeenCalled();expect(h.posts).toBe(0);expect(inspectPaymentHold(h.root).blocked).toBe(false);}
 else{const r=await h.run();expect(r.fee).toBe(226000);expect(Transaction.fromRaw(Buffer.from(h.raw,'hex')).getOutput(1).amount).toBe(BigInt(remainder));}
 }finally{sign.mockRestore();h.clean()}
});
test('soft dust exact fee ceilings accept and fee estimate remains additive',async()=>{
 for(const rate of [1000000,2000000]){const h=await harness([5000000]);try{
 const fee=226*rate/1000+1000000;h.responses.set('/',{medium_fee_per_kb:rate});h.policy({maxFeeKoinu:fee});
 writeFileSync(join(h.root,'brc181.json'),JSON.stringify(issuePolicyEnvelope(key,{origin:'doge-test',purpose:'test',perTxCap:1000000,totalBudget:100000+fee,maxFee:fee,destCaps:[],allowlist:['doge:'+dest]})));
 expect((await h.run({koinu:100000})).fee).toBe(fee);
 }finally{h.clean()}}
});
test('fee discontinuity selects another input rather than burning soft change',async()=>{
 const h=await harness([1326000,1500000]);try{const r=await h.run();const t=Transaction.fromRaw(Buffer.from(h.raw,'hex'));expect(t.inputsLength).toBe(2);expect(t.getOutput(1).amount).toBe(1452000n);expect(r.fee).toBe(374000);}finally{h.clean()}
});
for(const [txid,index] of [['00'.repeat(32),0],['11'.repeat(32),0xffffffff]] as const)test('coinbase detection requires both null outpoint fields '+index,async()=>{
 const h=await harness([3000000]);try{const t=source(h.m.dogeDestination(h.own).script,3000000,txid,index);const rows=[{...h.rows[0]!,tx_hash:t.id}];h.responses.set('/addrs/'+h.own+'?unspentOnly=true&limit=200',addressBody(h.own,rows));h.responses.set('/txs/'+t.id+'?includeHex=true',{hash:t.id,hex:t.hex});expect((await h.run()).fee).toBe(226000);}finally{h.clean()}
});
async function harness(values=[20000000,700000,2000000]){
 const m=await api(),root=mkdtempSync(join(tmpdir(),'doge-test-'));
 const wrap=Buffer.alloc(32,7),iv=Buffer.alloc(12,8),cipher=createCipheriv('aes-256-gcm',wrap,iv),ct=Buffer.concat([cipher.update(key.toWif(),'utf8'),cipher.final()]);
 writeFileSync(join(root,'wrap.key'),wrap);writeFileSync(join(root,'wif.enc'),Buffer.concat([iv,cipher.getAuthTag(),ct]).toString('base64'));writeFileSync(join(root,'address.txt'),key.toAddress());
 const pocket={maxPerTx:10000000,maxPerDay:50000000,maxLifetime:null,allowlist:['doge:'+dest],maxFeeKoinu:1000000};
 const policy=(patch:Record<string,unknown>={})=>writeFileSync(join(root,'policy.json'),JSON.stringify({doge:{...pocket,...patch}}));policy();
 const own=m.dogeAddress(key),script=m.dogeDestination(own).script,coins=values.map(v=>source(script,v));
 const rows=coins.map((t,i)=>({tx_hash:t.id,tx_input_n:-1,tx_output_n:0,value:values[i],spent:false,double_spend:false,confirmations:i===0?0:1,block_height:i===0?-1:1}));
 const responses=new Map<string,unknown>([['/addrs/'+own+'?unspentOnly=true&limit=200',addressBody(own,rows)],['/',{medium_fee_per_kb:1000000}],...coins.map(t=>['/txs/'+t.id+'?includeHex=true',{hash:t.id,hex:t.hex}] as [string,unknown])]);
 let posts=0,gets=0,raw='';
 const evidence=()=>{const names=readdirSync(join(root,'doge-sends'));expect(names).toHaveLength(1);const e=JSON.parse(readFileSync(join(root,'doge-sends',names[0]!), 'utf8'));expect(names[0]).toBe(e.paymentId+'.json');return e;};
 const fetchFn=(async(u:unknown,i?:RequestInit)=>{expect(i?.redirect).toBe('error');expect(new Headers(i?.headers).get('User-Agent')).toContain('Dogfood');const url=String(u);expect(url.startsWith('https://api.blockcypher.com/v1/doge/main/')).toBe(true);const path=url.slice('https://api.blockcypher.com/v1/doge/main'.length);if(i?.method==='POST'){posts++;expect(path).toBe('/txs/push');raw=JSON.parse(String(i.body)).tx;expect(evidence().rawTx).toBe(raw);expect(inspectPaymentHold(root)).toMatchObject({blocked:true,pending:'valid'});return Response.json({hash:Transaction.fromRaw(Buffer.from(raw,'hex')).id});}gets++;expect(i?.method).toBe('GET');if(!responses.has(path))throw Error('Unexpected transport '+path);const b=responses.get(path);return new Response(typeof b==='string'?b:JSON.stringify(b));}) as typeof fetch;
 const run=(extra:Record<string,unknown>={})=>m.sendDoge({root,to:dest,koinu:1000000,fetchFn,timing:{wait:async()=>{}},...extra});
 return {m,root,own,coins,rows,responses,policy,fetchFn,evidence,run,get raw(){return raw},get posts(){return posts},get gets(){return gets},clean(){rmSync(root,{recursive:true,force:true})}};
}
for(const kind of ['absent','malformed','allowlist','cap','day','lifetime','fee','brc-dest','brc-fee','brc-total','brc-invalid','kill'])test('pre-sign '+kind,async()=>{const h=await harness([3000000]),sign=spyOn(Transaction.prototype,'sign');try{if(kind==='absent')writeFileSync(join(h.root,'policy.json'),'{}');if(kind==='malformed')writeFileSync(join(h.root,'policy.json'),'{"doge":{}}');if(kind==='allowlist')h.policy({allowlist:[]});if(kind==='cap')h.policy({maxPerTx:999000});if(kind==='day')h.policy({maxPerDay:999000});if(kind==='lifetime')h.policy({maxLifetime:999000});if(kind==='fee')h.policy({maxFeeKoinu:1});if(kind==='kill')killVault(h.root);if(kind.startsWith('brc')){const e=issuePolicyEnvelope(key,{origin:'doge-test',purpose:'test',perTxCap:10000000,totalBudget:kind==='brc-total'?1000000:100000000,maxFee:kind==='brc-fee'?0:10000000,destCaps:[],allowlist:[kind==='brc-dest'?'doge:'+h.own:'doge:'+dest]});writeFileSync(join(h.root,'brc181.json'),kind==='brc-invalid'?'{}':JSON.stringify(e));}await expect(h.run()).rejects.toThrow();expect(sign).not.toHaveBeenCalled();expect(h.posts).toBe(0);expect(inspectPaymentHold(h.root).blocked).toBe(false);}finally{sign.mockRestore();h.clean()}});
for(const stage of [2,3])for(const kind of ['spent','kill'])test(`fresh ${stage} ${kind}`,async()=>{const h=await harness([3000000]);try{let n=0;const fetchFn=(async(u:unknown,i?:RequestInit)=>{if(String(u).includes('/addrs/')&&++n===stage){if(stage===3)expect(h.evidence().rawTx).toBeTruthy();if(kind==='spent')return Response.json(addressBody(h.own,[]));killVault(h.root);}return h.fetchFn(u as string,i);}) as typeof fetch;await expect(h.run({fetchFn})).rejects.toThrow();expect(h.posts).toBe(0);expect(inspectPaymentHold(h.root).blocked).toBe(stage===3);}finally{h.clean()}});
for(const kind of ['timeout','mismatch','http','redirect'])test('ambiguous '+kind+' retains valid hold and no retry',async()=>{const h=await harness([3000000]);try{let posts=0;const fetchFn=(async(u:unknown,i?:RequestInit)=>{if(i?.method==='POST'){posts++;expect(h.evidence().rawTx).toBe(JSON.parse(String(i.body)).tx);if(kind==='timeout')throw Error('timeout');if(kind==='http')return new Response('failed',{status:400});if(kind==='redirect')return new Response('',{status:302,headers:{Location:'https://evil.example/'}});return new Response('00'.repeat(32));}return h.fetchFn(u as string,i);}) as typeof fetch;await expect(h.run({fetchFn})).rejects.toThrow();expect(inspectPaymentHold(h.root)).toMatchObject({blocked:true,pending:'valid'});await expect(h.run({fetchFn})).rejects.toThrow();expect(posts).toBe(1);expect(existsSync(join(h.root,'spends.jsonl'))).toBe(false);}finally{h.clean()}});
test('strict DOGE policy parsing, zero caps deny, scope includes only DOGE amount + fee',async()=>{for(const raw of [null,[],{}, {maxPerTx:1,maxPerDay:null,maxLifetime:null,allowlist:null,maxFeeKoinu:-1}])expect(()=>parseStoredPolicy(JSON.stringify({doge:raw}),false)).toThrow();const h=await harness();try{h.policy({maxPerTx:0});await expect(h.run()).rejects.toThrow();}finally{h.clean()}expect(usageFromLog([JSON.stringify({asset:'doge',amount:4,fee:2}),JSON.stringify({asset:'bsv',amount:50,fee:10})],new Date(),'brc181-doge').spentLifetime).toBe(6);});



test('frozen scalar-1 derived key signed legacy bytes',async()=>{
 const f=JSON.parse(readFileSync(join(import.meta.dir,'../testdata/doge-synthetic.json'),'utf8'));
 const h=await harness([3000000]);try{expect(h.own).toBe(f.address);expect(h.m.dogeKey(key).toPublicKey().toString()).toBe(f.publicKey);expect(h.coins[0]!.hex).toBe(f.sourceRawTx);const r=await h.run();expect(h.raw).toBe(f.rawTx);const t=Transaction.fromRaw(Buffer.from(f.rawTx,'hex')),s=t.getInput(0).finalScriptSig!,sig=s.slice(1,1+s[0]!),pk=s.slice(2+s[0]!);expect(secp256k1.verify(secp256k1.Signature.fromDER(sig.slice(0,-1)).toCompactRawBytes(),legacyDigest(t,0,p2pkh(pk,network).script),pk)).toBe(true);expect(r).toEqual({txid:f.txid,amount:1000000,fee:f.fee});}finally{h.clean()}
});
test('BRC181 successful send and cumulative fee-inclusive denial',async()=>{
 const h=await harness([3000000]);try{const e=issuePolicyEnvelope(key,{origin:'doge-test',purpose:'test',perTxCap:1000000,totalBudget:1226000,maxFee:226000,destCaps:[],allowlist:['doge:'+dest]});writeFileSync(join(h.root,'brc181.json'),JSON.stringify(e));expect((await h.run()).fee).toBe(226000);await expect(h.run()).rejects.toThrow('BRC-181');expect(h.posts).toBe(1);}finally{h.clean()}
});
for(const value of [1291999,1292000,1326000])test('fold only sub-hard-dust no-change remainder '+value,async()=>{
 const h=await harness([value]);try{if(value!==1291999){await expect(h.run()).rejects.toThrow('Insufficient');return;}const r=await h.run();const t=Transaction.fromRaw(Buffer.from(h.raw,'hex'));expect(t.outputsLength).toBe(1);expect(r.fee).toBe(291999);expect(r.fee).toBeGreaterThanOrEqual(t.vsize*1000);}finally{h.clean()}
});
test('invalid checksum, witness and dust fail before signing or transport',async()=>{
 const h=await harness(),sign=spyOn(Transaction.prototype,'sign');try{
 for(const to of [dest.slice(0,-1)+(dest.endsWith('1')?'2':'1'),p2wpkh(pub).address!,p2wpkh(pub,network).address!,p2wsh({type:'unknown',script:new Uint8Array([0x51])}).address!,p2tr(pub.slice(1)).address!])await expect(h.run({to})).rejects.toThrow('BAD_ADDRESS');await expect(h.run({koinu:99999})).rejects.toThrow('dust');expect(sign).not.toHaveBeenCalled();expect(h.gets).toBe(0);
 }finally{sign.mockRestore();h.clean()}
});
test('medium estimate above floor is used and actual fee capped',async()=>{
 const h=await harness([3000000]);try{h.responses.set('/',{medium_fee_per_kb:2000000});expect((await h.run()).fee).toBe(452000);}finally{h.clean()}
});
test('duplicate source outputs fetched once; address reads remain fresh and timing injected',async()=>{
 const h=await harness();try{const t=new Transaction({allowUnknownInputs:true});const script=h.m.dogeDestination(h.own).script;t.addOutput({script,amount:700000n});t.addOutput({script,amount:2000000n});t.addInput({txid:'11'.repeat(32),index:0,finalScriptSig:new Uint8Array([0])});
 const rows=[0,1].map(i=>({...h.rows[0]!,tx_hash:t.id,tx_output_n:i,value:i?2000000:700000}));h.responses.set('/addrs/'+h.own+'?unspentOnly=true&limit=200',addressBody(h.own,rows));h.responses.set('/txs/'+t.id+'?includeHex=true',{hash:t.id,hex:t.hex});
 let clock=0;const waits:number[]=[];await h.run({timing:{now:()=>clock,wait:async(ms:number)=>{waits.push(ms);clock+=ms;}}});expect(h.gets).toBe(5);expect(waits).toEqual([350,350,350,350,350]);
 }finally{h.clean()}
});
test('CLI address balance parsing and default broadcast use intercepted BlockCypher',async()=>{
 const h=await harness([3000000]);try{
 const preload=join(h.root,'preload.ts');writeFileSync(preload,`import {Transaction} from ${JSON.stringify(join(import.meta.dir,'../node_modules/@scure/btc-signer/index.js'))};const m=new Map(${JSON.stringify([...h.responses])});globalThis.fetch=async(u,i)=>{if(!String(u).startsWith('https://api.blockcypher.com/v1/doge/main/'))throw Error('Unexpected host');const p=String(u).slice('https://api.blockcypher.com/v1/doge/main'.length);if(i?.method==='POST'){if(p!=='/txs/push')throw Error('Unexpected POST');return Response.json({hash:Transaction.fromRaw(Buffer.from(JSON.parse(i.body).tx,'hex')).id});}if(!m.has(p))throw Error('Unexpected GET');return Response.json(m.get(p));};`);
 const run=(args:string[])=>Bun.spawnSync([process.execPath,'--preload',preload,'src/cli.ts',...args],{cwd:join(import.meta.dir,'..'),env:{...process.env,DOGFOOD_WALLET_DIR:h.root}});
 for(const args of [[],[dest],[dest,'0'],[dest,'-1'],[dest,'1.0'],[dest,'1e6'],[dest,'0x10'],[dest,'9007199254740992'],[dest,'1000000','--no-broadcast']]){const r=run(['doge-send',...args]);expect(r.exitCode).not.toBe(0);expect(r.stderr.toString()).not.toContain('Unknown command');}
 const a=run(['doge-address']);expect(a.exitCode).toBe(0);expect(a.stdout.toString().trim()).toBe(h.own);const b=run(['doge-balance']);expect(b.exitCode).toBe(0);expect(JSON.parse(b.stdout.toString())).toMatchObject({confirmed:0,unconfirmed:3000000});const s=run(['doge-send',dest,'1000000']);expect(s.stderr.toString()).toBe('');expect(s.exitCode).toBe(0);expect(JSON.parse(s.stdout.toString())).toEqual({txid:h.evidence().txid,amount:1000000,fee:226000});
 }finally{h.clean()}
},15000);


test('keyless hourly ceiling refuses before signing without retries',async()=>{
 const h=await harness(Array.from({length:189},(_,i)=>1000+i)),sign=spyOn(Transaction.prototype,'sign');try{let clock=0;await expect(h.run({koinu:100000,timing:{now:()=>clock,wait:async(ms:number)=>{clock+=ms;}}})).rejects.toThrow('hourly request budget');expect(h.gets).toBe(190);expect(h.posts).toBe(0);expect(sign).not.toHaveBeenCalled();}finally{sign.mockRestore();h.clean()}
});
test('kill during final POST throttle retains signed hold without POST',async()=>{
 const h=await harness([3000000]);try{let n=0;await expect(h.run({timing:{wait:async()=>{if(++n===5)killVault(h.root);}}})).rejects.toThrow('STOP_SPENDING');expect(h.posts).toBe(0);expect(inspectPaymentHold(h.root)).toMatchObject({blocked:true,pending:'valid'});}finally{h.clean()}
});

// Independent legacy serialization and double SHA-256, no signer preimage helper.
function legacyDigest(t:Transaction,index:number,script:Uint8Array){
 const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
 const u64=(n:bigint)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b;};
 const parts:Uint8Array[]=[u32(1),Buffer.from([t.inputsLength])];
 for(let j=0;j<t.inputsLength;j++){const i=t.getInput(j),s=j===index?script:new Uint8Array();parts.push(Buffer.from(i.txid!).reverse(),u32(i.index!),Buffer.from([s.length]),s,u32(i.sequence!));}
 parts.push(Buffer.from([t.outputsLength]));for(let j=0;j<t.outputsLength;j++){const o=t.getOutput(j);parts.push(u64(o.amount!),Buffer.from([o.script!.length]),o.script!);}
 parts.push(u32(0),u32(1));return createHash('sha256').update(createHash('sha256').update(Buffer.concat(parts)).digest()).digest();
}

function addressBody(address:string, rows:any[]) {return {address,final_balance:rows.reduce((n,r)=>n+r.value,0),txrefs:rows.filter(r=>r.confirmations>0),unconfirmed_txrefs:rows.filter(r=>r.confirmations===0)};}
test('DOGE policy persisted spelling and CLI spelling are distinct',async()=>{
 const m=await api(), pocket={maxPerTx:10000000,maxPerDay:null,maxLifetime:null,maxFeeKoinu:1000000,allowlist:['doge:'+dest]};
 expect(parseDogePolicy(pocket)).toEqual(pocket);expect(()=>parseDogePolicy({...pocket,allowlist:[dest]})).toThrow();
 expect(evaluateDogeSend(pocket,false,1000000,dest)).toEqual({ok:true});
 expect(validateCanonicalDest('doge:'+dest)).toBe('doge:'+dest);
 expect(m.dogeKey(key).toString()).toBe(key.deriveChild(key.toPublicKey(),'dogfood/doge/v1').toString());
 for(const bad of [dest.toLowerCase(),dest+' ',dest.slice(0,-1)+'0',p2wpkh(pub).address!,p2tr(pub.slice(1)).address!,p2pkh(pub).address!])expect(()=>m.dogeDestination(bad)).toThrow();
 expect(m.dogeDestination(p2sh(p2pkh(pub,network),network).address!).script.length).toBe(23);
});
test('legacy SIGHASH_ALL signatures independently verify; smallest first and native accounting',async()=>{
 const h=await harness();try{const r=await h.run(),t=Transaction.fromRaw(Buffer.from(h.raw,'hex'));
 expect(t.inputsLength).toBe(2);expect(t.getInput(0).txid).toEqual(Buffer.from(h.coins[1]!.id,'hex'));
 for(let i=0;i<t.inputsLength;i++){const input=t.getInput(i);expect(input.finalScriptWitness).toBeUndefined();const s=input.finalScriptSig!;const sig=s.slice(1,1+s[0]!);const pk=s.slice(2+s[0]!);expect(sig.at(-1)).toBe(1);const digest=legacyDigest(t,i,p2pkh(pk,network).script);expect(secp256k1.verify(secp256k1.Signature.fromDER(sig.slice(0,-1)).toCompactRawBytes(),digest,pk)).toBe(true);}
 expect(r.fee).toBeGreaterThanOrEqual(t.vsize*1000);expect(h.posts).toBe(1);expect(loadUsage(h.root,new Date(),'doge').spentLifetime).toBe(1000000);expect(loadUsage(h.root,new Date(),'brc181-doge').spentLifetime).toBe(1000000+r.fee);expect(loadUsage(h.root).spentLifetime).toBe(0);
 }finally{h.clean()}
});
test('balance uses documented confirmed and unconfirmed output refs',async()=>{const h=await harness();try{expect(await h.m.dogeBalance(h.own,h.fetchFn,{wait:async()=>{}})).toEqual({confirmed:2700000,unconfirmed:20000000});}finally{h.clean()}});
for(const bad of ['truncated','limit','balance','duplicate','spent','input','missing','txid','value','vout','lock','fee','insufficient'])test('failclosed untrusted '+bad,async()=>{
 const h=await harness([3000000]);try{const path='/addrs/'+h.own+'?unspentOnly=true&limit=200',body=addressBody(h.own,h.rows);
 if(bad==='truncated')Object.assign(body,{hasMore:true});if(bad==='limit')body.unconfirmed_txrefs=Array(200).fill(h.rows[0]);if(bad==='balance')body.final_balance++;if(bad==='duplicate')body.unconfirmed_txrefs.push(h.rows[0]);if(bad==='spent')h.rows[0]!.spent=true;if(bad==='input')h.rows[0]!.tx_output_n=-1;if(bad==='missing')body.unconfirmed_txrefs=[];
 if(bad==='value')h.rows[0]!.value!++;if(bad==='vout')h.rows[0]!.tx_output_n=1;if(bad==='insufficient')Object.assign(body,addressBody(h.own,[]));
 h.responses.set(path,body);if(bad==='txid')h.responses.set('/txs/'+h.coins[0]!.id+'?includeHex=true',{hash:h.coins[0]!.id,hex:source(h.m.dogeDestination(dest).script,3000000).hex});
 if(bad==='lock'){const t=source(h.m.dogeDestination(dest).script,3000000);h.rows[0]!.tx_hash=t.id;h.responses.set('/txs/'+t.id+'?includeHex=true',{hash:t.id,hex:t.hex});}
 if(bad==='fee')h.responses.set('/',{medium_fee_per_kb:-1});await expect(h.run()).rejects.toThrow();expect(h.posts).toBe(0);expect(inspectPaymentHold(h.root).blocked).toBe(false);
 }finally{h.clean()}
});
