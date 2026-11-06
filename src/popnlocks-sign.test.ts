import {test, expect} from 'bun:test';
import {P2PKH, PrivateKey, Script, Spend, Transaction} from '@bsv/sdk';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initVault, killVault, parseStoredPolicy, loadUsage} from './vault';
import {inspectPaymentHold} from './payment-guard';
async function api() { expect(existsSync(join(import.meta.dir,'popnlocks-sign.ts'))).toBe(true); return import('./popnlocks-sign'); }
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'popnlocks-')); const {address}=initVault(root);
 const policy=(block:unknown={maxPerTxSats:1000,maxPerDaySats:2000})=>writeFileSync(join(root,'policy.json'),JSON.stringify({popnlocks:block}));policy();
 const source=new Transaction();source.addInput({sourceTXID:'12'.repeat(32),sourceOutputIndex:0,unlockingScript:Script.fromASM('OP_0')});source.addOutput({satoshis:1000,lockingScript:new P2PKH().lock(address)});
 const tx=new Transaction();tx.addInput({sourceTXID:source.id('hex'),sourceOutputIndex:0,unlockingScript:new Script()});tx.addInput({sourceTXID:'34'.repeat(32),sourceOutputIndex:1,unlockingScript:new Script()});tx.addOutput({satoshis:1900,lockingScript:Script.fromASM('OP_1')});
 const responses=new Map<string,unknown>([[`/tx/${source.id('hex')}/hex`,source.toHex()],[`/address/${address}/unspent`,[{tx_hash:source.id('hex'),tx_pos:0,value:1000}]]]);
 const fetchFn=(async(u:unknown,i?:RequestInit)=>{expect(i?.method).toBe('GET');const k=String(u).replace('https://api.whatsonchain.com/v1/bsv/main','');if(!responses.has(k))throw Error('Unexpected network');const v=responses.get(k);return new Response(typeof v==='string'?v:JSON.stringify(v));}) as typeof fetch;
 const run=async(extra:Record<string,unknown>={})=>(await api()).popnlocksSign({root,txhex:tx.toHex(),inputIndex:0,fetchFn,...extra});
 return {root,address,source,tx,policy,responses,fetchFn,run,clean(){rmSync(root,{recursive:true,force:true})}};
}
test('stored popnlocks policy validates required safe integer caps; absent disabled',()=>{
 expect((parseStoredPolicy('{}',false) as any).popnlocks).toBeUndefined();
 expect((parseStoredPolicy('{"popnlocks":{"maxPerTxSats":0,"maxPerDaySats":1}}',false) as any).popnlocks).toEqual({maxPerTxSats:0,maxPerDaySats:1});
 for(const b of [null,[],{}, {maxPerTxSats:1}, {maxPerTxSats:1,maxPerDaySats:-1},{maxPerTxSats:'1',maxPerDaySats:1},{maxPerTxSats:1.1,maxPerDaySats:1},{maxPerTxSats:1,maxPerDaySats:9007199254740992}])expect(()=>parseStoredPolicy(JSON.stringify({popnlocks:b}),false)).toThrow('popnlocks');
});
test('signs only selected input with ALL, preserves outputs and durably charges exposure before return',async()=>{const h=fixture();try{
 const raw=await h.run();const tx=Transaction.fromHex(raw),i=tx.inputs[0]!,prev=h.source.outputs[0]!;
 expect(tx.inputs[1]!.unlockingScript!.toHex()).toBe('');expect(tx.outputs.map(o=>[o.satoshis,o.lockingScript.toHex()])).toEqual(h.tx.outputs.map(o=>[o.satoshis,o.lockingScript.toHex()]));
 const valid=()=>new Spend({sourceTXID:i.sourceTXID!,sourceOutputIndex:0,sourceSatoshis:1000,lockingScript:prev.lockingScript,transactionVersion:tx.version,otherInputs:[tx.inputs[1]!],inputIndex:0,unlockingScript:i.unlockingScript!,inputSequence:i.sequence!,outputs:tx.outputs,lockTime:tx.lockTime}).validate();expect(valid()).toBe(true);
 expect(i.unlockingScript!.chunks[0]!.data!.at(-1)).toBe(0x41);tx.outputs[0]!.satoshis!--;expect(valid).toThrow();
 const names=readdirSync(join(h.root,'popnlocks-signs'));expect(names).toHaveLength(1);const evidence=JSON.parse(readFileSync(join(h.root,'popnlocks-signs',names[0]!), 'utf8'));expect(evidence).toMatchObject({txid:Transaction.fromHex(raw).id('hex'),inputIndex:0,inputValue:1000,covenantOutputValue:1900});expect(Number.isFinite(Date.parse(evidence.timestamp))).toBe(true);
 expect(loadUsage(h.root,new Date(),'popnlocks').spentToday).toBe(1000);expect(inspectPaymentHold(h.root).blocked).toBe(false);
 }finally{h.clean()}});
for(const kind of ['absent','tx-cap','day-cap','kill','ours','hash','value','position','spent','kill-race'])test('rejects before key access: '+kind,async()=>{const h=fixture();try{
 if(kind==='absent')writeFileSync(join(h.root,'policy.json'),'{}');if(kind==='tx-cap')h.policy({maxPerTxSats:999,maxPerDaySats:2000});if(kind==='day-cap'){h.policy({maxPerTxSats:1000,maxPerDaySats:1000});writeFileSync(join(h.root,'spends.jsonl'),JSON.stringify({t:new Date().toISOString(),asset:'popnlocks',amount:1}));}if(kind==='kill')killVault(h.root);
 if(kind==='ours'){h.source.outputs[0]!.lockingScript=new P2PKH().lock(PrivateKey.fromString('2',16).toAddress());h.tx.inputs[0]!.sourceTXID=h.source.id('hex');h.responses.set(`/tx/${h.source.id('hex')}/hex`,h.source.toHex());}
 if(kind==='hash')h.responses.set(`/tx/${h.source.id('hex')}/hex`,h.tx.toHex());if(kind==='value'||kind==='position'||kind==='spent')h.responses.set(`/address/${h.address}/unspent`,kind==='spent'?[]:[{tx_hash:h.source.id('hex'),tx_pos:kind==='position'?1:0,value:kind==='value'?999:1000}]);
 // Corrupt key material proves refusal precedes decrypt, not merely no broadcast.
 writeFileSync(join(h.root,'wif.enc'),'broken');let calls=0;const fetchFn=(async(u:unknown,i?:RequestInit)=>{const r=await h.fetchFn(u as string,i);if(kind==='kill-race'&&++calls===2)killVault(h.root);return r;}) as typeof fetch;
 await expect(h.run({fetchFn})).rejects.toThrow(/disabled|maxPerTxSats|maxPerDaySats|STOP_SPENDING|ours|hash|triple/i);expect(inspectPaymentHold(h.root).blocked).toBe(false);
 }finally{h.clean()}});
test('malformed tx and index reject before filesystem/network',async()=>{const m=await api();for(const txhex of ['', 'zz','00','01000000','00ff ', 'ab'])await expect(m.popnlocksSign({root:'MISSING',txhex,inputIndex:0})).rejects.toThrow('transaction');const h=fixture();try{for(const inputIndex of [-1,2,0.5,NaN,Infinity,'0'])await expect(h.run({inputIndex})).rejects.toThrow('inputIndex');await expect(h.run({txhex:h.tx.toHex()+'00'})).rejects.toThrow('transaction');}finally{h.clean()}});
test('accounting is scoped, UTC-day based and charges each authorization, not settlement',async()=>{const h=fixture();try{writeFileSync(join(h.root,'spends.jsonl'),[JSON.stringify({t:new Date().toISOString(),asset:'bsv',amount:999999}),JSON.stringify({t:'2000-01-01T00:00:00Z',asset:'popnlocks',amount:999999})].join('\n'));await h.run();await h.run();await expect(h.run()).rejects.toThrow('maxPerDaySats');expect(loadUsage(h.root,new Date(),'popnlocks').spentToday).toBe(2000);}finally{h.clean()}});
test('evidence failure retains valid hold and refuses retry',async()=>{const h=fixture();try{writeFileSync(join(h.root,'popnlocks-signs'),'blocked');await expect(h.run()).rejects.toThrow();expect(inspectPaymentHold(h.root)).toMatchObject({blocked:true,pending:'valid'});await expect(h.run()).rejects.toThrow('unresolved');expect(existsSync(join(h.root,'spends.jsonl'))).toBe(false);}finally{h.clean()}});
test('index one preserves an existing counterparty script and shared guard excludes concurrent signing',async()=>{const h=fixture();try{
 h.tx.inputs.reverse();h.tx.inputs[0]!.unlockingScript=Script.fromASM('OP_1');
 let release!:()=>void;const wait=new Promise<void>(r=>{release=r});let entered!:()=>void;const started=new Promise<void>(r=>{entered=r});
 const fetchFn=(async(u:unknown,i?:RequestInit)=>{entered();await wait;return h.fetchFn(u as string,i);}) as typeof fetch;
 const pending=h.run({inputIndex:1,fetchFn});await started;await expect(h.run({inputIndex:1})).rejects.toThrow('unresolved');release();
 const tx=Transaction.fromHex(await pending);expect(tx.inputs[0]!.unlockingScript!.toHex()).toBe('51');expect(tx.inputs[1]!.unlockingScript!.chunks[0]!.data!.at(-1)).toBe(0x41);expect(loadUsage(h.root,new Date(),'popnlocks').spentToday).toBe(1000);
 }finally{h.clean()}});
test('CLI emits only signed hex, strict decimal index; package ships module; MCP isolation',async()=>{const h=fixture();try{
 const preload=join(h.root,'preload.ts');writeFileSync(preload,`const m=new Map(${JSON.stringify([...h.responses])});globalThis.fetch=async(u,i)=>{if(i?.method!=='GET')throw Error('Network write forbidden');const k=String(u).replace('https://api.whatsonchain.com/v1/bsv/main','');if(!m.has(k))throw Error('Unexpected network');const v=m.get(k);return new Response(typeof v==='string'?v:JSON.stringify(v));};`);
 const run=(args:string[])=>Bun.spawnSync([process.execPath,'--preload',preload,'src/cli.ts','popnlocks-sign',...args],{cwd:join(import.meta.dir,'..'),env:{...process.env,DOGFOOD_WALLET_DIR:h.root}});
 for(const args of [[],[h.tx.toHex()],[h.tx.toHex(),'-1'],[h.tx.toHex(),'0x0'],[h.tx.toHex(),'0','extra']]){const r=run(args);expect(r.exitCode).not.toBe(0);expect(r.stderr.toString()).toContain('Usage: popnlocks-sign');}
 const r=run([h.tx.toHex(),'0']);expect(r.stderr.toString()).toBe('');expect(r.exitCode).toBe(0);expect(r.stdout.toString().trim()).toMatch(/^[a-f0-9]+$/);expect(Transaction.fromHex(r.stdout.toString().trim()).inputs[0]!.unlockingScript!.toHex()).not.toBe('');
 expect(JSON.parse(readFileSync(join(import.meta.dir,'../package.json'),'utf8')).files).toContain('src/popnlocks-sign.ts');
 const mcp=Bun.spawnSync([process.execPath,'src/test-support/gryd-post-mcp.ts'],{cwd:join(import.meta.dir,'..'),env:{...process.env,DOGFOOD_WALLET_DIR:h.root}});expect(mcp.exitCode).toBe(0);
 }finally{h.clean()}},30000);
