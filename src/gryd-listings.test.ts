import { test, expect } from 'bun:test';
import { P2PKH, PrivateKey, Script, Transaction, Hash, Utils, Spend } from '@bsv/sdk';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initVault, loadVault, killVault, loadUsage } from './vault';
import { propertyKey, decodeListing } from './gryd-buy';
import { inspectPaymentHold, withPaymentGuard } from './payment-guard';
import * as listing from './gryd-listings';
import fixture from '../testdata/gryd-buy-mainnet.json';
function source(script: Script, value: number) { const t = new Transaction(); t.addInput({sourceTXID:'00'.repeat(32),sourceOutputIndex:0xffffffff,unlockingScript:Script.fromASM('OP_0')}); t.addOutput({lockingScript:script,satoshis:value}); return t; }
function harness(cancel = false) {
 const root = mkdtempSync(join(tmpdir(),'gryd-list-')); initVault(root); const v = loadVault(root), property = propertyKey(v.key);
 const original = source(new P2PKH().lock(property.toAddress()),1);
 const ordinal = cancel ? source(listing.listingScript(property.toAddress(), v.address,1000),1) : original;
 const funding = source(new P2PKH().lock(v.address),20000), point = `${ordinal.id('hex')}_0`;
 const directory = join(root,cancel?'gryd-listings':'gryd-purchases'); mkdirSync(directory);
 writeFileSync(join(directory,`${ordinal.id('hex')}.json`),JSON.stringify({version:1,mode:'broadcast',operation:cancel?'agent-list':'agent-buy',agentId:'object:42',txid:ordinal.id('hex'),rawTx:ordinal.toHex()}));
 const hash = Utils.toHex(Hash.sha256(ordinal.outputs[0]!.lockingScript.toBinary()).reverse());
 const responses = new Map<string,unknown>([[`/tx/${ordinal.id('hex')}/hex`,ordinal.toHex()],[`/tx/${funding.id('hex')}/hex`,funding.toHex()],[`/script/${hash}/unspent`,[{tx_hash:ordinal.id('hex'),tx_pos:0,value:1}]],[`/address/${v.address}/unspent`,[{tx_hash:funding.id('hex'),tx_pos:0,value:20000}]],[`https://the-grid-api.fly.dev/api/v1/agents/object%3A42`,{agent:{id:'object:42',source:'object'}}]]);
 let raw='', broadcasts=0; const calls:string[]=[];
 const fetchFn = (async(url: unknown,init?:RequestInit)=>{expect(init?.method).toBe('GET'); const key=String(url).replace('https://api.whatsonchain.com/v1/bsv/main','');calls.push(key);if(!responses.has(key)) throw Error('Unexpected network '+key); const b=responses.get(key);return new Response(typeof b==='string'?b:JSON.stringify(b));}) as typeof fetch;
 const broadcast=async(r:string)=>{raw=r;broadcasts++;const id=Transaction.fromHex(r).id('hex');expect(JSON.parse(readFileSync(join(root,'gryd-listings',id+'.json'),'utf8')).rawTx).toBe(r);return {txid:id};};
 const run=(extra:Record<string,unknown>={})=> cancel?listing.cancelAgentListing({root,listingOutpoint:point,fetchFn,broadcast,...extra}):listing.listAgent({root,ordinalOutpoint:point,priceSats:1000,fetchFn,broadcast,...extra});
 return {root,v,property,ordinal,funding,point,hash,responses,calls,fetchFn,run,broadcast,get raw(){return raw},get broadcasts(){return broadcasts},clean(){rmSync(root,{recursive:true,force:true})}};
}
test('listing builder reproduces real mainnet legacy covenant byte for byte',()=>{expect(listing.listingScript(fixture.seller,fixture.seller,fixture.price).toHex()).toBe(Transaction.fromHex(fixture.listing.rawHex).outputs[0]!.lockingScript.toHex());});
for(const cancel of [false,true]) {
 test(`${cancel?'cancel':'list'} validates every signed input and exact property envelope, evidence precedes broadcast`,async()=>{const h=harness(cancel);try{const r=await h.run();expect(r.mode).toBe('broadcast');const tx=Transaction.fromHex(h.raw);expect(tx.outputs[0]!.satoshis).toBe(1);if(cancel)expect(tx.outputs[0]!.lockingScript.toHex()).toBe(new P2PKH().lock(h.property.toAddress()).toHex());else expect(decodeListing(tx.outputs[0]!.lockingScript.toHex()).payAddress).toBe(h.v.address);
 for(const [i,prev] of [h.ordinal,h.funding].entries()){const input=tx.inputs[i]!;expect(new Spend({sourceTXID:input.sourceTXID!,sourceOutputIndex:0,sourceSatoshis:prev.outputs[0]!.satoshis!,lockingScript:prev.outputs[0]!.lockingScript,transactionVersion:tx.version,otherInputs:tx.inputs.filter((_,j)=>j!==i),inputIndex:i,unlockingScript:input.unlockingScript!,inputSequence:input.sequence!,outputs:tx.outputs,lockTime:tx.lockTime}).validate()).toBe(true);}
 if(r.mode!=='broadcast')throw Error('mode');expect(r.envelope.address).toBe(h.property.toAddress());expect(r.envelope.payload).toMatchObject({action:cancel?'agent.cancel_listing':'agent.list',method:'POST',path:`/api/v1/agents/object%3A42/${cancel?'listing/cancel':'list'}`,body:cancel?{}:{price_sats:1000,listing_type:'sale',outpoint:tx.id('hex')+'_0',list_txid:tx.id('hex')}});expect(loadUsage(h.root).spentLifetime).toBe(0);expect(inspectPaymentHold(h.root).blocked).toBe(false);
 }finally{h.clean()}});
 test(`${cancel?'cancel':'list'} unsigned preview bypasses purchase and destination budgets`,async()=>{const h=harness(cancel);try{const p=join(h.root,'policy.json');writeFileSync(p,JSON.stringify({...JSON.parse(readFileSync(p,'utf8')),maxSatsPerTx:0,gryd:{maxPerTxSats:0,maxPerDaySats:0}}));writeFileSync(join(h.root,'brc181.json'),'{}');const r=await h.run({noBroadcast:true});expect(r.mode).toBe('preview');expect(JSON.stringify(r)).not.toMatch(/rawTx|envelope|signature|unlockingScript/);expect(h.broadcasts).toBe(0);expect(existsSync(join(h.root,'spends.jsonl'))).toBe(false);expect(inspectPaymentHold(h.root).blocked).toBe(false);}finally{h.clean()}});
 test(`${cancel?'cancel':'list'} chain, identity, kill and ownership refusals`,async()=>{for(const bad of ['spent','value','position','source','funding','identity','kill','ownership']){const h=harness(cancel);try{const u=`/script/${h.hash}/unspent`;if(bad==='spent')h.responses.set(u,[]);if(bad==='value')h.responses.set(u,[{tx_hash:h.ordinal.id('hex'),tx_pos:0,value:2}]);if(bad==='position')h.responses.set(u,[{tx_hash:h.ordinal.id('hex'),tx_pos:1,value:1}]);if(bad==='source')h.responses.set(`/tx/${h.ordinal.id('hex')}/hex`,h.funding.toHex());if(bad==='funding')h.responses.set(`/address/${h.v.address}/unspent`,[{tx_hash:h.funding.id('hex'),tx_pos:0,value:30000}]);if(bad==='identity')rmSync(join(h.root,cancel?'gryd-listings':'gryd-purchases'),{recursive:true});if(bad==='kill')killVault(h.root);if(bad==='ownership'){initVault(join(h.root,'other'));const other=join(h.root,'other');for(const f of ['wif.enc','wrap.key','address.txt'])if(existsSync(join(other,f)))writeFileSync(join(h.root,f),readFileSync(join(other,f)));}await expect(h.run()).rejects.toThrow();expect(h.broadcasts).toBe(0);}finally{h.clean()}}});
 test(`${cancel?'cancel':'list'} ambiguous acknowledgement retains hold and blocks retries`,async()=>{const h=harness(cancel);try{await expect(h.run({broadcast:async(raw:string)=>{await h.broadcast(raw);return {txid:'00'.repeat(32)}}})).rejects.toThrow();expect(inspectPaymentHold(h.root)).toMatchObject({blocked:true,pending:'valid'});const n=h.calls.length;await expect(h.run()).rejects.toThrow();expect(h.calls.length).toBe(n);expect(h.broadcasts).toBe(1);}finally{h.clean()}});
}
test('list then cancel then relist uses durable route evidence without backend writes',async()=>{
 const h=harness();try{
 const listed=await h.run();if(listed.mode!=='broadcast')throw Error('mode');
 const install=(raw:string)=>{const tx=Transaction.fromHex(raw);h.responses.set(`/tx/${tx.id('hex')}/hex`,raw);const hash=Utils.toHex(Hash.sha256(tx.outputs[0]!.lockingScript.toBinary()).reverse());h.responses.set(`/script/${hash}/unspent`,[{tx_hash:tx.id('hex'),tx_pos:0,value:1}]);h.responses.set(`/address/${h.v.address}/unspent`,[{tx_hash:tx.id('hex'),tx_pos:1,value:tx.outputs[1]!.satoshis}]);return tx.id('hex')+'_0';};
 const point=install(h.raw);const cancelled=await listing.cancelAgentListing({root:h.root,listingOutpoint:point,fetchFn:h.fetchFn,broadcast:h.broadcast});expect(cancelled.mode).toBe('broadcast');
 const ordinalOutpoint=install(h.raw);const relisted=await listing.listAgent({root:h.root,ordinalOutpoint,priceSats:999,fetchFn:h.fetchFn,broadcast:h.broadcast});expect(relisted.mode).toBe('broadcast');expect(relisted.agentId).toBe('object:42');expect(h.broadcasts).toBe(3);expect(inspectPaymentHold(h.root).blocked).toBe(false);
 }finally{h.clean()}
});
test('smallest-first main funding excludes one-sat coins and refreshes triples',async()=>{
 const h=harness();try{
 const small=source(new P2PKH().lock(h.v.address),2000), dust=source(new P2PKH().lock(h.v.address),1);
 h.responses.set(`/tx/${small.id('hex')}/hex`,small.toHex());
 h.responses.set(`/address/${h.v.address}/unspent`,[h.funding,dust,small].map(t=>({tx_hash:t.id('hex'),tx_pos:0,value:t.outputs[0]!.satoshis})));
 const result=await h.run();expect(result.inputs[1]!.outpoint).toBe(small.id('hex')+'_0');expect(result.inputs).toHaveLength(2);expect(h.calls).not.toContain(`/tx/${dust.id('hex')}/hex`);
 }finally{h.clean()}
});
for(const cancel of [false,true]) {
 test(`${cancel?'cancel':'list'} shared lock blocks before reads`,async()=>{const h=harness(cancel);try{await withPaymentGuard(h.root,'send',async()=>{await expect(h.run()).rejects.toThrow('payment is active');expect(h.calls).toHaveLength(0)});}finally{h.clean()}});
 test(`${cancel?'cancel':'list'} default ARC only after evidence; timeout never retried`,async()=>{const h=harness(cancel);try{let posts=0;const fetchFn=(async(u:unknown,i?:RequestInit)=>{if(i?.method==='POST'){posts++;expect(String(u)).toBe('https://arc.gorillapool.io/v1/tx');const raw=JSON.parse(String(i.body)).rawTx;const tx=Transaction.fromHex(raw);expect(JSON.parse(readFileSync(join(h.root,'gryd-listings',tx.id('hex')+'.json'),'utf8')).rawTx).toBe(raw);throw Error('synthetic timeout');}return h.fetchFn(u as string,i);}) as typeof fetch;await expect(h.run({broadcast:undefined,fetchFn})).rejects.toThrow();expect(posts).toBe(1);expect(inspectPaymentHold(h.root).blocked).toBe(true);expect(existsSync(join(h.root,'spends.jsonl'))).toBe(false);}finally{h.clean()}});
 test(`${cancel?'cancel':'list'} existing signed evidence is never overwritten or broadcast`,async()=>{const h=harness(cancel);try{
 // A fixed synthetic key produces deterministic bytes; first intercept and save them.
 let saved='';await expect(h.run({broadcast:async(raw:string)=>{saved=raw;throw Error('capture')}})).rejects.toThrow();
 const txid=Transaction.fromHex(saved).id('hex'), path=join(h.root,'gryd-listings',txid+'.json'), before=readFileSync(path,'utf8');
 // Test-only forensic reset in an unfunded fixture, never a production recovery API.
 rmSync(join(h.root,'payment.lock'));rmSync(join(h.root,'payment.pending.json'));
 await expect(h.run()).rejects.toThrow();expect(h.broadcasts).toBe(0);expect(readFileSync(path,'utf8')).toBe(before);expect(inspectPaymentHold(h.root).blocked).toBe(true);
 }finally{h.clean()}});
}
test('cancellation rejects noncanonical covenant, foreign cancellation and foreign payout',async()=>{
 for(const kind of ['wrapper','suffix','cancel','payout']){const h=harness(true);try{
 const other=PrivateKey.fromHex('04'.padStart(64,'0')).toAddress();let hex=listing.listingScript(kind==='cancel'?other:h.property.toAddress(),kind==='payout'?other:h.v.address,1000).toHex();if(kind==='wrapper')hex='51'+hex;if(kind==='suffix')hex+='51';const bad=source(Script.fromHex(hex),1);h.responses.set(`/tx/${bad.id('hex')}/hex`,bad.toHex());await expect(listing.cancelAgentListing({root:h.root,listingOutpoint:bad.id('hex')+'_0',fetchFn:h.fetchFn,broadcast:h.broadcast})).rejects.toThrow();expect(h.broadcasts).toBe(0);expect(inspectPaymentHold(h.root).blocked).toBe(false);
 }finally{h.clean()}}
});
test('invalid inputs fail before vault access',async()=>{for(const priceSats of [0,-1,NaN,Infinity,1.1,Number.MAX_SAFE_INTEGER+1])await expect(listing.listAgent({root:'DOES-NOT-EXIST',ordinalOutpoint:'ab'.repeat(32)+'_0',priceSats})).rejects.toThrow('price');await expect(listing.cancelAgentListing({root:'DOES-NOT-EXIST',listingOutpoint:'bad'})).rejects.toThrow('outpoint');});
test('CLI help advertises both human-only Phase 3 commands',()=>{
 const result=Bun.spawnSync([process.execPath,'src/cli.ts','--help'],{cwd:join(import.meta.dir,'..'),env:{...process.env,DOGFOOD_WALLET_DIR:join(tmpdir(),'unused-phase3-help')}});
 expect(result.exitCode).toBe(0);expect(result.stdout.toString()).toContain('agent-cancel-listing');expect(result.stdout.toString()).toContain('agent-list');
});
test('human CLI preview, strict flags, package allowlist and MCP isolation',()=>{const h=harness();try{const preload=join(h.root,'preload.ts');writeFileSync(preload,`const m=new Map(${JSON.stringify([...h.responses])});globalThis.fetch=async(u,i)=>{if(i?.method!=='GET')throw Error('POST forbidden');const k=String(u).replace('https://api.whatsonchain.com/v1/bsv/main','');if(!m.has(k))throw Error(k);const b=m.get(k);return new Response(typeof b==='string'?b:JSON.stringify(b));};`);const run=(args:string[])=>Bun.spawnSync([process.execPath,'--preload',preload,'src/cli.ts',...args],{cwd:join(import.meta.dir,'..'),env:{...process.env,DOGFOOD_WALLET_DIR:h.root}});const r=run(['agent-list',h.point,'1000','--no-broadcast']);expect(r.exitCode).toBe(0);expect(JSON.parse(r.stdout.toString()).mode).toBe('preview');for(const args of [['agent-list',h.point,'1e3'],['agent-list',h.point,'1','--bad'],['agent-cancel-listing',h.point,'--bad']])expect(run(args).exitCode).not.toBe(0);expect(JSON.parse(readFileSync(join(import.meta.dir,'../package.json'),'utf8')).files).toContain('src/gryd-listings.ts');expect(readFileSync(join(import.meta.dir,'mcp.ts'),'utf8')).not.toMatch(/gryd-listings|agent-list|cancelAgentListing|listAgent/);}finally{h.clean()}});
