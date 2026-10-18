import {expect,test,spyOn} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {P2PKH,LockingScript,Transaction,Utils} from '@bsv/sdk';
import {initVault,loadVault,allowDestination,killVault} from './vault';
import {propertyKey,GRYD_FUND} from './gryd-buy';
import {inspectPaymentHold} from './payment-guard';
import {AGENT_WRITE_ACTIONS} from './gryd-agent';
import * as post from './gryd-post';
const input=(body:Record<string,unknown>={},route:Record<string,unknown>={agentId:'object:7'})=>({route,body});
function fixture(){const root=mkdtempSync(join(tmpdir(),'agent-post-'));initVault(root);return {root,clean:()=>rmSync(root,{recursive:true,force:true})};}
test('nested executor and grant contracts fail closed before signing',()=>{
 const good=specs['agent.action.execute']![2];
 for(const changed of [{action:'area.sense'},{action:'pin.annotate'},{target:{lat:1,lng:2,radiusM:100}},{target:{type:'area',lat:91,lng:2,radiusM:1}}])expect(()=>post.planAgentPost('agent.action.execute',input({...good,...changed}))).toThrow();
 expect(()=>post.planAgentPost('agent.capability.grant',input({...specs['agent.capability.grant']![2],limits:{maxPerDay:1}}))).toThrow();
});
test('changed schedule response is not accepted even with HTTP200',async()=>{const f=fixture();try{await expect(post.postAgent({root:f.root,action:'agent.schedule.update',input:input({enabled:false},{agentId:'object:7',scheduleId:'s'}),fetchFn:(async()=>Response.json({schedule:{id:'other',enabled:true}})) as unknown as typeof fetch})).rejects.toThrow('mismatch');expect(inspectPaymentHold(f.root).blocked).toBe(true);}finally{f.clean();}});
test('real fund accepted credit is field-verified, accounted and releases hold',async()=>{const f=fixture();try{const tx=deposit(),identity=loadVault(f.root).key.toPublicKey().toString();allowDestination(f.root,GRYD_FUND);let n=0;const result=await post.postAgent({root:f.root,action:'agent.fund',input:input({txid:tx.id('hex'),vout:0}),fetchFn:(async(u:any,o:any)=>{if(String(u).includes('whatsonchain'))return new Response(tx.toHex());if(o.method==='POST'){expect(inspectPaymentHold(f.root).intent?.amount).toBe(100);return Response.json({success:true,credited:100,balance:150});}return Response.json({agent:{id:'object:7',ownerAddress:identity,balance:n++===0?50:150}});}) as typeof fetch});expect(result.status).toBe('verified');expect(inspectPaymentHold(f.root).blocked).toBe(false);expect(JSON.parse(readFileSync(join(f.root,'spends.jsonl'),'utf8')).amount).toBe(100);}finally{f.clean();}});
test('withdraw requires payout receipt binding not unrelated historic payment',async()=>{const f=fixture();try{const vault=loadVault(f.root),tx=new Transaction();tx.addOutput({satoshis:50,lockingScript:new P2PKH().lock(vault.address)});allowDestination(f.root,vault.address);let n=0;await expect(post.postAgent({root:f.root,action:'agent.withdraw',input:input({amount:50}),fetchFn:(async(u:any,o:any)=>{if(String(u).includes('whatsonchain'))return new Response(tx.toHex());if(o.method==='POST')return Response.json({success:true,payout_txid:tx.id('hex')});return Response.json({agent:{id:'object:7',ownerAddress:vault.key.toPublicKey().toString(),balance:n++===0?100:50}});}) as typeof fetch})).rejects.toThrow('payout binding');expect(inspectPaymentHold(f.root).blocked).toBe(true);}finally{f.clean();}});
test('MCP runtime is isolated and rejects human-only commands',()=>{const r=Bun.spawnSync([process.execPath,'src/test-support/gryd-post-mcp.ts'],{cwd:join(import.meta.dir,'..'),env:process.env});expect(r.exitCode).toBe(0);expect(JSON.parse(r.stdout.toString()).isolated).toBe(true);});
test('intent persistence failure never reaches HTTP and leaves hold',async()=>{const f=fixture();try{writeFileSync(join(f.root,'gryd-posts'),'blocked');let calls=0;await expect(post.postAgent({root:f.root,action:'agent.mine',input:input({},{}),fetchFn:(async()=>{calls++;throw Error('forbidden');}) as unknown as typeof fetch})).rejects.toThrow();expect(calls).toBe(0);expect(inspectPaymentHold(f.root).blocked).toBe(true);}finally{f.clean();}});
test('withdraw current payout receipt and balance delta verify actual amount',async()=>{const f=fixture();try{const vault=loadVault(f.root);allowDestination(f.root,vault.address);let n=0,raw='';const r=await post.postAgent({root:f.root,action:'agent.withdraw',input:input({amount:50,owner_address:vault.key.toPublicKey().toString()}),fetchFn:(async(u:any,o:any)=>{if(String(u).includes('whatsonchain'))return new Response(raw);if(o.method==='POST'){expect(inspectPaymentHold(f.root).intent?.amount).toBe(50);const e=JSON.parse(o.body),tx=new Transaction();tx.addOutput({satoshis:50,lockingScript:new P2PKH().lock(vault.address)});tx.addOutput({satoshis:0,lockingScript:new LockingScript().writeOpCode(0).writeOpCode(106).writeBin(Utils.toArray(JSON.stringify({p:'locus',v:3,op:'agent_payout',agent_id:'object:7',to:vault.address,amount:50,ts:e.payload.timestamp}),'utf8'))});raw=tx.toHex();return Response.json({success:true,payout_txid:tx.id('hex')});}return Response.json({agent:{id:'object:7',ownerAddress:vault.key.toPublicKey().toString(),balance:n++===0?100:50}});}) as typeof fetch});expect(r.status).toBe('verified');expect(inspectPaymentHold(f.root).blocked).toBe(false);}finally{f.clean();}});
test('HTTP timeout is exactly 30s, redirects error, body failure held without retry',async()=>{const f=fixture(),timeout=spyOn(AbortSignal,'timeout');try{let calls=0;await expect(post.postAgent({root:f.root,action:'agent.mine',input:input({},{}),fetchFn:(async(_u:any,o:any)=>{calls++;expect(o.redirect).toBe('error');expect(o.signal).toBeInstanceOf(AbortSignal);return new Response(new ReadableStream({start(c){c.error(Error('body timeout'));}}));}) as typeof fetch})).rejects.toThrow('body timeout');expect(timeout).toHaveBeenCalledWith(30000);expect(calls).toBe(1);expect(inspectPaymentHold(f.root).blocked).toBe(true);}finally{timeout.mockRestore();f.clean();}});
for(const cap of ['day','lifetime'])test('withdraw actual amount respects '+cap+' usage before signing',async()=>{const f=fixture();try{const v=loadVault(f.root);writeFileSync(join(f.root,'policy.json'),JSON.stringify({maxSatsPerTx:1000,maxSatsPerDay:cap==='day'?100:1000,maxSatsLifetime:cap==='lifetime'?100:1000,allowlist:[v.address]}));writeFileSync(join(f.root,'spends.jsonl'),JSON.stringify({t:new Date().toISOString(),asset:'bsv',amount:75})+'\n');await expect(post.postAgent({root:f.root,action:'agent.withdraw',input:input({amount:50}),noPost:true})).rejects.toThrow(cap==='day'?'daily cap':'lifetime cap');expect(inspectPaymentHold(f.root).blocked).toBe(false);}finally{f.clean();}});
const specs:Record<string,['POST'|'PUT'|'DELETE',string,Record<string,unknown>,Record<string,unknown>?]>={
 'agent.create':['POST','/api/v1/agents',{name:'Scout',lat:1,lng:2},{}],
 'agent.update':['PUT','/api/v1/agents/object%3A7',{name:'Scout'}],
 'agent.fund':['POST','/api/v1/agents/object%3A7/fund',{txid:'ab'.repeat(32),vout:0}],
 'agent.withdraw':['POST','/api/v1/agents/object%3A7/withdraw',{amount:100}],
 'agent.authorize':['POST','/api/v1/agents/object%3A7/authorize',{spending_policy:{}}],
 'agent.mine':['POST','/api/v1/agents/mine',{},{}],
 'agent.transactions':['POST','/api/v1/agents/object%3A7/transactions',{limit:5}],
 'agent.conversation':['POST','/api/v1/agents/object%3A7/conversation',{}],
 'agent.runs':['POST','/api/v1/agents/object%3A7/runs',{limit:5}],
 'agent.invoke':['POST','/api/v1/agents/object%3A7/invoke',{prompt:'Hello'}],
 'agent.approach':['POST','/api/v1/agents/object%3A7/approach',{lat:1,lng:2}],
 'agent.invoke_agent':['POST','/api/v1/agents/object%3A7/to/object%3A8/invoke',{prompt:'Hi'},{agentId:'object:7',targetId:'object:8'}],
 'agent.brain.read':['POST','/api/v1/agents/object%3A7/brain/full',{}],
 'agent.brain.update':['PUT','/api/v1/agents/object%3A7/brain',{domain:'maps'}],
 'agent.list':['POST','/api/v1/agents/object%3A7/list',{price_sats:5,listing_type:'sale',outpoint:'ab'.repeat(32)+'_0',list_txid:'ab'.repeat(32)}],
 'agent.cancel_listing':['POST','/api/v1/agents/object%3A7/listing/cancel',{cancel_txid:'ab'.repeat(32)}],
 'agent.buy':['POST','/api/v1/agents/object%3A7/listing/close',{close_txid:'ab'.repeat(32)}],
 'agent.capabilities.read':['POST','/api/v1/agents/object%3A7/capabilities/list',{}],
 'agent.capability.grant':['POST','/api/v1/agents/object%3A7/capabilities',{capability:'world.read_area',scope:{type:"radius",center:{lat:1,lng:2},radiusM:100},limits:{maxPerHour:1,maxPerDay:1},expiresAt:'2030-01-01T00:00:00Z'}],
 'agent.capability.revoke':['POST','/api/v1/agents/object%3A7/capabilities/g/revoke',{}, {agentId:'object:7',grantId:'g'}],
 'agent.action.dry_run':['POST','/api/v1/agents/object%3A7/actions/dry-run',{requestId:'r',action:'world.read_area',target:{type:"area",lat:1,lng:2,radiusM:100},params:{}}],
 'agent.action.execute':['POST','/api/v1/agents/object%3A7/actions',{requestId:'r',action:'world.read_area',target:{type:"area",lat:1,lng:2,radiusM:100},params:{}}],
 'agent.actions.read':['POST','/api/v1/agents/object%3A7/actions/list',{}],
 'agent.schedule.create':['POST','/api/v1/agents/object%3A7/schedules',{capability:'world.read_area',target:{type:"area",lat:1,lng:2,radiusM:100},params:{},cadence:'hourly'}],
 'agent.schedule.list':['POST','/api/v1/agents/object%3A7/schedules/list',{}],
 'agent.schedule.update':['POST','/api/v1/agents/object%3A7/schedules/s',{enabled:false},{agentId:'object:7',scheduleId:'s'}],
 'agent.schedule.delete':['POST','/api/v1/agents/object%3A7/schedules/s/delete',{}, {agentId:'object:7',scheduleId:'s'}],
};
test('every current action has exact current routing or explicit fail-closed disposition',()=>{
 expect(Object.keys(specs).concat(['agent.lock','agent.unlock']).sort()).toEqual([...AGENT_WRITE_ACTIONS].sort());
 for(const [action,[method,path,body,route]] of Object.entries(specs)){
  const plan=post.planAgentPost(action,input(body,route));expect(plan.method).toBe(method);expect(plan.path).toBe(path);expect(plan.signedPath).toBe(decodeURIComponent(path));expect(plan.body).toEqual(body);
 }
 for(const a of ['agent.lock','agent.unlock','ordinal.buy','pin.create','ghost.summon','heartbeat.submit'])expect(()=>post.planAgentPost(a,input())).toThrow('Unsupported');
});
test('invalid body and metadata rejected before vault access',async()=>{
 for(const value of [null,[],{},input({amount:0}),input({amount:-1}),input({amount:1.5}),input({amount:100,extra:1}),input({amount:100},{agentId:'../mine'}),input({amount:100},{agentId:'x/y'}),input({amount:100},{agentId:'x',path:'/evil'}),input({amount:100},{agentId:'x',signer:'other'})])await expect(post.postAgent({root:'MISSING',action:'agent.withdraw',input:value})).rejects.toThrow();
 await expect(post.postAgent({root:'MISSING',action:'agent.fund',input:input({amount:5})})).rejects.toThrow();
});
test('PUT exact body, property signer, nonce evidence before HTTP, checked readback and fresh attempts',async()=>{
 const f=fixture();try{
 const key=propertyKey(loadVault(f.root).key),address=key.toAddress(),owner=key.toPublicKey().toString(),nonces:string[]=[];
 const fetchFn=async(url:any,options:any)=>{
  expect(options.redirect).toBe('error');expect(options.signal).toBeInstanceOf(AbortSignal);
  if(options.method==='PUT'){
   const e=JSON.parse(options.body);expect(e.payload.path).toBe('/api/v1/agents/object:7');expect(e.payload.network).toBe('mainnet');expect(e.payload.audience).toBe('the-grid-api.fly.dev');expect(e.payload.body).toEqual({name:'Scout'});expect(e.address).toBeUndefined();
   const saved=JSON.parse(readFileSync(join(f.root,'gryd-posts',e.payload.nonce+'.intent.json'),'utf8'));expect(saved.envelope).toEqual(e);expect(saved.signerAddress).toBe(address);expect(inspectPaymentHold(f.root).blocked).toBe(true);nonces.push(e.payload.nonce);
  }
  expect(String(url)).toBe('https://the-grid-api.fly.dev/api/v1/agents/object%3A7');return Response.json({agent:{id:'object:7',ownerAddress:owner,name:'Scout'}});
 };
 for(let i=0;i<2;i++){const r=await post.postAgent({root:f.root,action:'agent.update',input:input({name:'Scout'},{agentId:'object:7',signer:'property'}),fetchFn:fetchFn as typeof fetch});expect(r.status).toBe('verified');expect(inspectPaymentHold(f.root).blocked).toBe(false);}
 expect(new Set(nonces).size).toBe(2);expect(readdirSync(join(f.root,'gryd-posts')).filter(x=>x.endsWith('.verified.json')).length).toBe(2);
 }finally{f.clean();}
});
for(const failure of ['transport','reject','malformed','mismatch'])test(`ambiguous ${failure} keeps shared hold and refuses retry`,async()=>{
 const f=fixture();try{let mutations=0;const fetchFn=async(_u:any,o:any)=>{if(o.method==='PUT'){mutations++;if(failure==='transport')throw Error('timeout');if(failure==='reject')return Response.json({error:'no'},{status:403});if(failure==='malformed')return new Response('bad');return Response.json({agent:{id:'object:7',name:'Scout'}});}return Response.json({agent:{id:'object:7',name:'wrong'}});};
 const opts={root:f.root,action:'agent.update',input:input({name:'Scout'}),fetchFn:fetchFn as typeof fetch};await expect(post.postAgent(opts)).rejects.toThrow();expect(inspectPaymentHold(f.root).blocked).toBe(true);await expect(post.postAgent(opts)).rejects.toThrow('Human forensic');expect(mutations).toBe(1);expect(readdirSync(join(f.root,'gryd-posts')).some(x=>x.endsWith('.failure.json'))).toBe(true);
 }finally{f.clean();}
});
test('no public schedule readback is explicitly unverified and held; no invented GET',async()=>{const f=fixture();try{let n=0;const r=await post.postAgent({root:f.root,action:'agent.schedule.update',input:input({enabled:false},{agentId:'object:7',scheduleId:'s'}),fetchFn:(async(_u:any,o:any)=>{n++;expect(o.method).toBe('POST');return Response.json({schedule:{id:'s',enabled:false}});}) as typeof fetch});expect(r.status).toBe('unverified');expect(r.reason).toContain('no public readback');expect(n).toBe(1);expect(inspectPaymentHold(f.root).blocked).toBe(true);}finally{f.clean();}});
test('no-post emits usable authorization only after durable hold, never HTTP; kill blocks',async()=>{const f=fixture();try{const r=await post.postAgent({root:f.root,action:'agent.mine',input:input({},{}),noPost:true,fetchFn:(()=>{throw Error('network forbidden');}) as any});expect(r.status).toBe('signed');expect(r.envelope?.payload.nonce).toBeTruthy();expect(inspectPaymentHold(f.root).blocked).toBe(true);}finally{f.clean();}const g=fixture();try{killVault(g.root);await expect(post.postAgent({root:g.root,action:'agent.mine',input:input({},{}),noPost:true})).rejects.toThrow('STOP_SPENDING');expect(inspectPaymentHold(g.root).blocked).toBe(false);}finally{g.clean();}});
function deposit(id='object:7',amount=100){const tx=new Transaction();tx.addOutput({satoshis:amount,lockingScript:new P2PKH().lock(GRYD_FUND)});tx.addOutput({satoshis:0,lockingScript:new LockingScript().writeOpCode(0).writeOpCode(106).writeBin(Utils.toArray(JSON.stringify({type:'agent_fund',agent_id:id}),'utf8'))});return tx;}
test('fund derives real chain output amount, not client claims, applies caps before signing',async()=>{const f=fixture();try{const tx=deposit('object:7',10001);allowDestination(f.root,GRYD_FUND);let mutations=0;await expect(post.postAgent({root:f.root,action:'agent.fund',input:input({txid:tx.id('hex'),vout:0}),fetchFn:(async(_u:any,o:any)=>{if(o.method!=='GET')mutations++;return new Response(tx.toHex());}) as typeof fetch})).rejects.toThrow('cap');expect(mutations).toBe(0);expect(inspectPaymentHold(f.root).blocked).toBe(false);}finally{f.clean();}});
test('fund binding mismatch fails before signing; final kill check follows chain read',async()=>{for(const killed of [false,true]){const f=fixture();try{allowDestination(f.root,GRYD_FUND);const tx=deposit(killed?'object:7':'object:8');await expect(post.postAgent({root:f.root,action:'agent.fund',input:input({txid:tx.id('hex'),vout:0}),noPost:true,fetchFn:(async()=>{if(killed)killVault(f.root);return new Response(tx.toHex());}) as unknown as typeof fetch})).rejects.toThrow(killed?'STOP_SPENDING':'binding');expect(inspectPaymentHold(f.root).blocked).toBe(false);}finally{f.clean();}}});
test('withdraw reserves actual amount and enforces installed BRC181 and local allowlist',async()=>{const f=fixture();try{const address=loadVault(f.root).address;await expect(post.postAgent({root:f.root,action:'agent.withdraw',input:input({amount:50}),noPost:true})).rejects.toThrow('Allowlist');allowDestination(f.root,address);writeFileSync(join(f.root,'brc181.json'),'{}');await expect(post.postAgent({root:f.root,action:'agent.withdraw',input:input({amount:50}),noPost:true})).rejects.toThrow('brc181');rmSync(join(f.root,'brc181.json'));const r=await post.postAgent({root:f.root,action:'agent.withdraw',input:input({amount:50}),noPost:true});expect(r.status).toBe('signed');expect(inspectPaymentHold(f.root).intent?.amount).toBe(50);}finally{f.clean();}});
test('CLI validates, package includes sender, MCP does not expose sender',()=>{const f=fixture();try{const run=(args:string[])=>Bun.spawnSync([process.execPath,'src/cli.ts','agent-post',...args],{cwd:join(import.meta.dir,'..'),env:{...process.env,DOGFOOD_WALLET_DIR:f.root}});for(const args of [[],['agent.mine','{}'],['agent.mine',JSON.stringify(input({},{})),'--bad'],['agent.mine',JSON.stringify(input({},{})),'--no-post','--no-post']])expect(run(args).exitCode).not.toBe(0);const r=run(['agent.mine',JSON.stringify(input({},{})),'--no-post']);expect(r.exitCode).toBe(0);expect(JSON.parse(r.stdout.toString()).status).toBe('signed');expect(JSON.parse(readFileSync(join(import.meta.dir,'../package.json'),'utf8')).files).toContain('src/gryd-post.ts');expect(readFileSync(join(import.meta.dir,'mcp.ts'),'utf8')).not.toMatch(/agent-post|gryd-post|postAgent/);}finally{f.clean();}});
