import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import * as guards from './payment-guard';
const roots:string[]=[];function root(){const r=mkdtempSync(join(tmpdir(),'bridge-transition-'));roots.push(r);return r;}
afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
test('parked bridge exposure releases only execution lock, owner reconcile exclusively resumes same identity',async()=>{
 const r=root();let id='';
 await guards.withPaymentGuard(r,'bridge-funded',async(g:any)=>{id=g.id;g.reserve({asset:'bsv',amount:1,to:'0x'+'1'.repeat(40)});g.park();});
 expect(existsSync(join(r,'payment.lock'))).toBe(false);expect(guards.inspectPaymentHold(r).blocked).toBe(true);
 await expect(guards.withPaymentGuard(r,'send',async()=>{})).rejects.toThrow();
 await (guards as any).withBridgeReconciliation(r,id,async(g:any)=>{
  expect(g.id).toBe(id);
  await expect((guards as any).withBridgeReconciliation(r,id,async()=>{})).rejects.toThrow();
  g.complete();
 });
 expect(guards.inspectPaymentHold(r).blocked).toBe(false);
});
test('reconciliation never unlinks a live funding lock even when pending and parked evidence exists',async()=>{
 const r=root();
 await guards.withPaymentGuard(r,'bridge-funded',async(g:any)=>{g.reserve({asset:'bsv',amount:1,to:'0x'+'1'.repeat(40)});g.park();
  const before=readFileSync(join(r,'payment.lock'),'utf8');
  await expect((guards as any).withBridgeReconciliation(r,g.id,async()=>{})).rejects.toThrow();
  expect(readFileSync(join(r,'payment.lock'),'utf8')).toBe(before);
 });
});
test('wrong intent cannot consume parked state; failed reconciliation keeps hold',async()=>{
 const r=root();let id='';
 await guards.withPaymentGuard(r,'bridge-funded',async(g:any)=>{id=g.id;g.reserve({asset:'bsv',amount:1,to:'0x'+'1'.repeat(40)});g.park();});
 await expect((guards as any).withBridgeReconciliation(r,'wrong',async()=>{})).rejects.toThrow();
 await expect((guards as any).withBridgeReconciliation(r,id,async()=>{throw new Error('unconfirmed');})).rejects.toThrow();
 expect(guards.inspectPaymentHold(r).blocked).toBe(true);
 expect(existsSync(join(r,'payment.lock'))).toBe(false);
});

test('orphan parked marker is visibly blocked and cannot be ignored by a spender',async()=>{
 const r=root();writeFileSync(join(r,'payment.bridge-parked.json'),'corrupt');
 expect(guards.inspectPaymentHold(r).blocked).toBe(true);
 await expect(guards.withPaymentGuard(r,'send',async()=>{})).rejects.toThrow();
});

test('second process cannot reconcile while first transition owns execution',async()=>{
 const r=root();let id='';await guards.withPaymentGuard(r,'bridge-funded',async(g:any)=>{id=g.id;g.reserve({asset:'bsv',amount:1,to:'0x'+'1'.repeat(40)});g.park();});
 await (guards as any).withBridgeReconciliation(r,id,async()=>{
  const before=readFileSync(join(r,'payment.lock'),'utf8');
  const code=`import {withBridgeReconciliation} from ${JSON.stringify(new URL('./payment-guard.ts',import.meta.url).href)};try{await withBridgeReconciliation(${JSON.stringify(r)},${JSON.stringify(id)},async()=>{});process.exit(2)}catch(e){console.log(e.code)}`;
  const child=Bun.spawnSync([process.execPath,'-e',code],{env:{PATH:process.env.PATH!,SystemRoot:process.env.SystemRoot!,TEMP:tmpdir(),TMP:tmpdir(),TMPDIR:tmpdir()},stdout:'pipe',stderr:'pipe'});
  expect(child.exitCode).toBe(0);expect(child.stdout.toString()).toContain('PAYMENT_HELD');expect(readFileSync(join(r,'payment.lock'),'utf8')).toBe(before);
 });
});
