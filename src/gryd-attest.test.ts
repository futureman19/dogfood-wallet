import { test, expect, spyOn } from 'bun:test';
import { PrivateKey, P2PKH, Script, Spend, Transaction } from '@bsv/sdk';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initVault, loadVault, killVault } from './vault';
import { propertyKey } from './gryd-buy';
import { inspectPaymentHold } from './payment-guard';
import { inscriptionScript } from './gryd-mint';
import * as attest from './gryd-attest';
test('maximum-depth valid observation remains verifiable inside wrapper',()=>{let p:any='leaf';for(let i=0;i<15;i++)p={nested:p};const o={...observation(),payload:p};attest.validateObservation(o);expect(attest.verifyAttestation(attest.signObservation(o,key))).toEqual(o);});
test('compact signature recovery header is authenticated',()=>{const s=attest.signObservation(observation(),key),b=Buffer.from(s.signature,'base64');b[0]=31+((b[0]!-31+1)%4);expect(()=>attest.verifyAttestation({...s,signature:b.toString('base64')})).toThrow();});
test('network deadline also bounds hung response body; redirects rejected',async()=>{
 const timeout=spyOn(AbortSignal,'timeout'),controller=new AbortController();timeout.mockReturnValue(controller.signal);
 try{const f=(async(_u:unknown)=>new Response(new ReadableStream({start(){}}))) as typeof fetch;
 const pending=attest.verifyAttestationTx('ab'.repeat(32),f);controller.abort();await expect(pending).rejects.toThrow('deadline');expect(timeout).toHaveBeenCalledWith(30000);
 }finally{timeout.mockRestore();}
 await expect(attest.verifyAttestationTx('ab'.repeat(32),(async(_u:unknown)=>new Response('',{status:302,headers:{Location:'https://evil.invalid'}})) as typeof fetch)).rejects.toThrow('Redirect');
});
for(const kind of ['value','hash','script','spent','kill','owner'])test('funding/signer refusal '+kind,async()=>{const h=harness();try{
 if(kind==='value')h.responses.set(`/address/${h.v.address}/unspent`,JSON.stringify([{tx_hash:h.small.id('hex'),tx_pos:0,value:5001}]));
 if(kind==='hash')h.responses.set(`/tx/${h.small.id('hex')}/hex`,h.large.toHex());
 if(kind==='script'){const wrong=source(new P2PKH().lock(key.toAddress()),5000);h.responses.set(`/address/${h.v.address}/unspent`,JSON.stringify([{tx_hash:wrong.id('hex'),tx_pos:0,value:5000}]));h.responses.set(`/tx/${wrong.id('hex')}/hex`,wrong.toHex());}
 if(kind==='kill')killVault(h.root);if(kind==='owner')h.o.agent.ownerAddress=h.v.address;
 let n=0;const fetchFn=(async(u:unknown,i?:RequestInit)=>{if(kind==='spent'&&String(u).includes('/unspent')&&++n===2)return Response.json([]);return h.fetchFn(u as string,i);})as typeof fetch;
 await expect(h.run({fetchFn})).rejects.toThrow();expect(h.broadcasts).toBe(0);expect(inspectPaymentHold(h.root).blocked).toBe(false);expect(existsSync(join(h.root,'gryd-attestations'))).toBe(false);
 }finally{h.clean()}});
test('evidence persistence failure blocks broadcast and holds',async()=>{const h=harness();try{writeFileSync(join(h.root,'gryd-attestations'),'blocked');await expect(h.run()).rejects.toThrow();expect(h.broadcasts).toBe(0);expect(inspectPaymentHold(h.root).blocked).toBe(true);}finally{h.clean()}});
test('evidence exclusive create never overwrites identical signed mint',async()=>{const h=harness();try{const r=await h.run();if(r.mode!=='broadcast')throw Error('mode');const path=join(h.root,'gryd-attestations',r.txid+'.json'),before=readFileSync(path,'utf8');await expect(h.run()).rejects.toThrow();expect(readFileSync(path,'utf8')).toBe(before);expect(h.broadcasts).toBe(1);expect(inspectPaymentHold(h.root).blocked).toBe(true);}finally{h.clean()}});
test('CLI default broadcast and preview with all HTTP mocked',async()=>{const h=harness();try{
 const preload=join(h.root,'cli-mock.ts');writeFileSync(preload,`import {Transaction} from ${JSON.stringify(join(import.meta.dir,'../node_modules/@bsv/sdk'))};import {readFileSync} from 'node:fs';const m=new Map(${JSON.stringify([...h.responses])});globalThis.fetch=async(u,i)=>{if(i.redirect!=='error'||!i.signal)throw Error('unbounded');if(i.method==='POST'){if(String(u)!=='https://arc.gorillapool.io/v1/tx')throw Error('Unexpected broadcast');const raw=JSON.parse(i.body).rawTx,id=Transaction.fromHex(raw).id('hex');if(JSON.parse(readFileSync(${JSON.stringify(join(h.root,'gryd-attestations'))}+'/'+id+'.json','utf8')).rawTx!==raw)throw Error('missing evidence');return Response.json({txid:id,txStatus:'SEEN_ON_NETWORK'});}const k=String(u).replace('https://api.whatsonchain.com/v1/bsv/main','');if(i.method!=='GET'||!m.has(k))throw Error('unexpected read');return new Response(m.get(k));};`);
 const run=(args:string[])=>Bun.spawnSync([process.execPath,'--preload',preload,'src/cli.ts','agent-attest',JSON.stringify(h.o),...args],{cwd:join(import.meta.dir,'..'),env:{...process.env,DOGFOOD_WALLET_DIR:h.root}});
 const preview=run(['--no-broadcast']);expect(preview.exitCode).toBe(0);expect(JSON.parse(preview.stdout.toString()).mode).toBe('preview');expect(existsSync(join(h.root,'gryd-attestations'))).toBe(false);
 const minted=run([]);expect(minted.exitCode).toBe(0);expect(JSON.parse(minted.stdout.toString()).mode).toBe('broadcast');expect(inspectPaymentHold(h.root).blocked).toBe(false);
 }finally{h.clean()}});
const key=PrivateKey.fromString('1'.padStart(64,'0'),16);
test('frozen vectors executed from pinned git-show protocol source',()=>{
 const fixture=JSON.parse(readFileSync(join(import.meta.dir,'../testdata/gryd-attest-vectors.json'),'utf8'));
 expect(fixture.sourceCommit).toBe('e6763c71f75a12acf8df3529e4ccc3fd50b16d80');
 for(const v of fixture.vectors){expect(attest.canonicalAttestationMessage(v.observation)).toBe(v.message);expect(Buffer.from(v.message).toString('hex')).toBe(v.utf8Hex);expect(attest.signObservation(v.observation,key)).toEqual(v.signed);expect(attest.verifyAttestation(v.signed)).toEqual(v.observation);}
});
test('real MCP discovery and calls exclude attestation commands',()=>{
 const r=Bun.spawnSync([process.execPath,'src/test-support/gryd-attest-mcp.ts'],{cwd:join(import.meta.dir,'..'),env:process.env});expect(r.exitCode).toBe(0);expect(JSON.parse(r.stdout.toString()).isolated).toBe(true);
});
function observation(address=key.toAddress()):any {return {type:'weather.reading',lat:12.5,lng:-20,observedAt:'2026-01-02T03:04:05.000Z',source:{kind:'sensor',ref:'station:synthetic-1'},payload:{'2':'two','10':'ten',temperatureC:21,unicode:'雪'},agent:{id:'synthetic:scout',ownerAddress:address}};}
function source(script:Script,value:number){const t=new Transaction();t.addInput({sourceTXID:'00'.repeat(32),sourceOutputIndex:0xffffffff,unlockingScript:Script.fromASM('OP_0')});t.addOutput({satoshis:value,lockingScript:script});return t;}
function harness(){
 const root=mkdtempSync(join(tmpdir(),'gryd-attest-'));initVault(root);const v=loadVault(root),property=propertyKey(v.key),o=observation(property.toAddress());
 const small=source(new P2PKH().lock(v.address),5000),large=source(new P2PKH().lock(v.address),20000),dust=source(new P2PKH().lock(v.address),1);
 const rows=[large,dust,small].map(t=>({tx_hash:t.id('hex'),tx_pos:0,value:t.outputs[0]!.satoshis}));
 const responses=new Map<string,string>([[`/address/${v.address}/unspent`,JSON.stringify(rows)],...[small,large].map(t=>[`/tx/${t.id('hex')}/hex`,t.toHex()] as [string,string])]);
 let raw='',broadcasts=0;const calls:string[]=[];
 const fetchFn=(async(u:unknown,i?:RequestInit)=>{expect(i?.redirect).toBe('error');expect(i?.signal).toBeDefined();expect(i?.method).toBe('GET');const k=String(u).replace('https://api.whatsonchain.com/v1/bsv/main','');calls.push(k);if(!responses.has(k))throw Error('Unexpected network '+k);return new Response(responses.get(k));}) as typeof fetch;
 const broadcast=async(r:string)=>{broadcasts++;raw=r;const t=Transaction.fromHex(r),id=t.id('hex');const evidence=JSON.parse(readFileSync(join(root,'gryd-attestations',id+'.json'),'utf8'));expect(evidence.rawTx).toBe(r);expect(inspectPaymentHold(root).blocked).toBe(true);responses.set(`/tx/${id}/hex`,r);return {txid:id};};
 const run=(extra:Record<string,unknown>={})=>attest.attestAgent({root,observation:o,fetchFn,broadcast,...extra});
 return {root,v,property,o,small,large,responses,fetchFn,calls,run,get raw(){return raw},get broadcasts(){return broadcasts},clean(){rmSync(root,{recursive:true,force:true})}};
}
test('canonical observation uses protocol lexicographic keys and distinct domain',()=>{
 const m=attest.canonicalAttestationMessage(observation());expect(m.startsWith('Dogfood Attestation v1\n')).toBe(true);expect(m).toContain('"10":"ten","2":"two"');expect(m).not.toContain('Locus Signed Write');
 const signed=attest.signObservation(observation(),key);expect(attest.verifyAttestation(signed)).toEqual(observation());
 expect(signed).toEqual(attest.signObservation(observation(),key));
});
for(const type of ['weather.reading','presence.attestation','event.report','custom.new_type'])test('extensible type '+type,()=>{const o=observation();o.type=type;expect(attest.verifyAttestation(attest.signObservation(o,key)).type).toBe(type);});
for(const field of ['type','lat','lng','observedAt','source.kind','source.ref','payload','agent.id','agent.ownerAddress','signature','pubkey'])test('tamper rejected '+field,()=>{
 const s:any=attest.signObservation(observation(),key);
 switch(field){case 'type':s.observation.type='event.report';break;case 'lat':s.observation.lat++;break;case 'lng':s.observation.lng++;break;case 'observedAt':s.observation.observedAt='2026-01-03T03:04:05.000Z';break;case 'source.kind':s.observation.source.kind='human';break;case 'source.ref':s.observation.source.ref='other';break;case 'payload':s.observation.payload.temperatureC++;break;case 'agent.id':s.observation.agent.id='other';break;case 'agent.ownerAddress':s.observation.agent.ownerAddress=PrivateKey.fromString('2'.padStart(64,'0'),16).toAddress();break;case 'signature':s.signature='A'.repeat(88);break;case 'pubkey':s.pubkey=PrivateKey.fromString('2'.padStart(64,'0'),16).toPublicKey().toString();break;}
 expect(()=>attest.verifyAttestation(s)).toThrow();
});
for(const bad of [{lat:NaN},{lng:Infinity},{lat:91},{lng:-181},{observedAt:'2026-02-30T00:00:00.000Z'},{observedAt:'2026-01-02T00:00:00+00:00'},{type:'weather'},{type:'Weather.reading'},{extra:true},{source:{kind:'web',ref:'x'}},{source:{kind:'api',ref:'x\nsecret'}},{payload:{bad:undefined}},{payload:{bad:()=>1}},{payload:{bad:'\ud800'}},{payload:{bad:'x'.repeat(33000)}}])test('invalid schema '+JSON.stringify(bad).slice(0,90),async()=>{
 const o={...observation(),...bad};expect(()=>attest.validateObservation(o)).toThrow();await expect(attest.attestAgent({root:'MISSING',observation:o})).rejects.toThrow('Invalid');
});
test('reject cycles, deep objects, accessors without running them, prototype keys',()=>{const o=observation();o.payload.loop=o;expect(()=>attest.validateObservation(o)).toThrow();let p:any={};for(let i=0;i<20;i++)p={p};expect(()=>attest.validateObservation({...observation(),payload:p})).toThrow();let read=false;const a={get value(){read=true;return 1}};expect(()=>attest.validateObservation({...observation(),payload:a})).toThrow();expect(read).toBe(false);expect(()=>attest.validateObservation({...observation(),payload:JSON.parse('{"__proto__":1}')})).toThrow();});
test('owner binding cannot assert a parent address, signer snapshot detached',()=>{const o=observation();expect(()=>attest.signObservation({...o,agent:{...o.agent,ownerAddress:PrivateKey.fromString('2'.padStart(64,'0'),16).toAddress()}},key)).toThrow();const signed=attest.signObservation(o,key);o.payload.temperatureC=99;expect(attest.verifyAttestation(signed).payload.temperatureC).toBe(21);});
test('mint exact Phase4 template, all Spend inputs, checked public verification and fee accounting',async()=>{const h=harness();try{
 const result=await h.run();if(result.mode!=='broadcast')throw Error('mode');const tx=Transaction.fromHex(h.raw),out=tx.outputs[0]!;expect(out.satoshis).toBe(1);const signed=JSON.parse(Buffer.from(out.lockingScript.chunks[6]!.data!).toString('utf8'));
 expect(out.lockingScript.toHex()).toBe(inscriptionScript(h.property.toAddress(),'application/json',JSON.stringify(signed)).toHex());expect(attest.verifyAttestation(signed)).toEqual(h.o);expect(signed.pubkey).toBe(h.property.toPublicKey().toString());expect(tx.inputs[0]!.sourceTXID).toBe(h.small.id('hex'));
 for(const [i,input]of tx.inputs.entries()){const prev=h.small.outputs[0]!;expect(new Spend({sourceTXID:input.sourceTXID!,sourceOutputIndex:input.sourceOutputIndex,sourceSatoshis:prev.satoshis!,lockingScript:prev.lockingScript,transactionVersion:tx.version,otherInputs:tx.inputs.filter((_,j)=>j!==i),inputIndex:i,unlockingScript:input.unlockingScript!,inputSequence:input.sequence!,outputs:tx.outputs,lockTime:tx.lockTime}).validate()).toBe(true);}
 expect(result.minerFee).toBe(5000-tx.outputs.reduce((a,o)=>a+o.satoshis!,0));expect(tx.outputs[1]!.lockingScript.toHex()).toBe(new P2PKH().lock(h.v.address).toHex());
 const verified=await attest.verifyAttestationTx(result.txid,h.fetchFn);expect(verified).toMatchObject({authentic:true,truthVerified:false,unspentChecked:false,observation:h.o,propertyAddress:h.property.toAddress()});expect(inspectPaymentHold(h.root).blocked).toBe(false);const log=readFileSync(join(h.root,'spends.jsonl'),'utf8');expect(JSON.parse(log.trim())).toMatchObject({kind:'agent-attest',amount:0,fee:result.minerFee});
 }finally{h.clean()}});
test('unsigned preview no signature/raw/evidence/hold and zero broadcasts',async()=>{const h=harness();try{const r=await h.run({noBroadcast:true});expect(r.mode).toBe('preview');expect(r.observation).toEqual(h.o);expect(JSON.stringify(r)).not.toMatch(/signature|rawTx|pubkey/);expect(h.broadcasts).toBe(0);expect(existsSync(join(h.root,'gryd-attestations'))).toBe(false);expect(inspectPaymentHold(h.root).blocked).toBe(false);}finally{h.clean()}});
for(const kind of ['timeout','wrong-id'])test('ambiguous '+kind+' retains durable hold and does not retry',async()=>{const h=harness();try{let n=0;await expect(h.run({broadcast:async()=>{n++;if(kind==='timeout')throw Error('timeout');return {txid:'00'.repeat(32)}}})).rejects.toThrow();expect(inspectPaymentHold(h.root)).toMatchObject({blocked:true,pending:'valid'});await expect(h.run()).rejects.toThrow();expect(n).toBe(1);}finally{h.clean()}});
test('kill recheck before any signature or reservation',async()=>{const h=harness();try{let n=0;const fetchFn=(async(u:unknown,i?:RequestInit)=>{const r=await h.fetchFn(u as string,i);if(String(u).includes('/unspent')&&++n===2)killVault(h.root);return r;})as typeof fetch;await expect(h.run({fetchFn})).rejects.toThrow('STOP_SPENDING');expect(h.broadcasts).toBe(0);expect(existsSync(join(h.root,'gryd-attestations'))).toBe(false);expect(inspectPaymentHold(h.root).blocked).toBe(false);}finally{h.clean()}});
for(const bad of ['destination','value','wrapper','content-type','extra-json','hash','oversize'])test('public verifier rejects '+bad,async()=>{const signed=attest.signObservation(observation(),key);let script=inscriptionScript(key.toAddress(),'application/json',JSON.stringify(signed));if(bad==='destination')script=inscriptionScript(PrivateKey.fromString('2'.padStart(64,'0'),16).toAddress(),'application/json',JSON.stringify(signed));if(bad==='wrapper')script=Script.fromHex('51'+script.toHex());if(bad==='content-type')script=inscriptionScript(key.toAddress(),'text/plain',JSON.stringify(signed));if(bad==='extra-json')script=inscriptionScript(key.toAddress(),'application/json',JSON.stringify({...signed,extra:1}));const t=source(script,bad==='value'?2:1);const f=(async(_u:unknown)=>new Response(bad==='oversize'?'0'.repeat(2097153):t.toHex()))as typeof fetch;await expect(attest.verifyAttestationTx(bad==='hash'?'ab'.repeat(32):t.id('hex'),f)).rejects.toThrow();});
test('CLI strict validation before vault access and public verify without vault',async()=>{const h=harness();try{
 const preload=join(h.root,'preload.ts');const signed=attest.signObservation(observation(),key),tx=source(inscriptionScript(key.toAddress(),'application/json',JSON.stringify(signed)),1);writeFileSync(preload,`globalThis.fetch=async(u,i)=>{if(String(u)!==${JSON.stringify('https://api.whatsonchain.com/v1/bsv/main/tx/'+tx.id('hex')+'/hex')}||i.method!=='GET'||i.redirect!=='error')throw Error('unexpected network');return new Response(${JSON.stringify(tx.toHex())});};`);
 const run=(args:string[])=>Bun.spawnSync([process.execPath,'--preload',preload,'src/cli.ts',...args],{cwd:join(import.meta.dir,'..'),env:{...process.env,DOGFOOD_WALLET_DIR:join(h.root,'missing')}});
 for(const args of [['agent-attest','{}'],['agent-attest',JSON.stringify(observation()),'--bad'],['agent-attest',JSON.stringify(observation()),'--no-broadcast','--no-broadcast'],['agent-attest-verify','BAD'],['agent-attest-verify',tx.id('hex'),'--bad']]){const r=run(args);expect(r.exitCode).not.toBe(0);expect(r.stderr.toString()).not.toMatch(/initialized|wif|wrap.key/);}
 const r=run(['agent-attest-verify',tx.id('hex')]);expect(r.exitCode).toBe(0);expect(JSON.parse(r.stdout.toString()).authentic).toBe(true);expect(existsSync(join(h.root,'missing'))).toBe(false);
 expect(readFileSync(join(import.meta.dir,'mcp.ts'),'utf8')).not.toMatch(/gryd-attest|agent-attest|attestAgent/);expect(JSON.parse(readFileSync(join(import.meta.dir,'../package.json'),'utf8')).files).toContain('src/gryd-attest.ts');
 }finally{h.clean()}});
