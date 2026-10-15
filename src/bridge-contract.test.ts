import { expect, test } from 'bun:test';
import { exolixProvider } from './bridge-exolix';
import { changenowProvider } from './bridge-changenow';
import { fixture } from './test-support/bridge-schema';
const pocket = '0x1111111111111111111111111111111111111111';
for(const name of ['exolix','changenow']) {
 const make=(body:any, extra:any={})=> {const fetchFn=(async()=>Response.json(body)) as typeof fetch;return name==='exolix'?exolixProvider({fetchFn,...extra}):changenowProvider({apiKey: 'fixture-only', fetchFn,...extra});};
 const q={provider:name,fromAsset:'bsv' as const,toAsset:'usdc-base' as const,fromAmountSats:100000,toAmount:1000000};
 test(`${name} schema-derived create/status bind exact evidence`,async()=>{
  const created=await make(fixture(name)).create({quote:q,payoutAddress:pocket});
  expect(created).toMatchObject({id:'synthetic00001',depositAmountSats:100000,payoutAmount:1000000,status:'waiting'});
  const done=await make(fixture(name,true)).status('synthetic00001');
  expect(done).toMatchObject({depositAmountSats:100000,payoutAmount:1000000,status:'finished',depositHash:'a'.repeat(64),payoutHash:'0x'+'b'.repeat(64)});
 });
 test(`${name} status missing or conflicting ID rejects (never request fallback)`,async()=>{
  for(const id of [undefined,null,true,'other']) await expect(make({...fixture(name,true),id}).status('synthetic00001')).rejects.toThrow();
 });
 test(`${name} configured arbitrary network rejects before fetch`,async()=>{
  await expect(make({toAmount:1},{usdcNetwork:'eth'}).quote({fromAmountSats:100000})).rejects.toThrow();
 });
 test(`${name} conflicting route rejects create`,async()=>{
  const b=fixture(name); if(name==='exolix') b.coinTo.network='ETH';else b.toNetwork='eth';
  await expect(make(b).create({quote:q,payoutAddress:pocket})).rejects.toThrow();
 });
 test(`${name} unknown status cannot authorize settlement`,async()=>{
  await expect(make({...fixture(name,true),status:'invented'}).status('synthetic00001')).rejects.toThrow();
 });
 test(`${name} fractional base units, missing amount, booleans reject`,async()=>{
  for(const amount of [true,null,undefined,0.001000001]) {
   const b=fixture(name); b[name==='exolix'?'amount':'fromAmount']=amount;
   await expect(make(b).create({quote:q,payoutAddress:pocket})).rejects.toThrow();
  }
 });
 test(`${name} create binds requested amount and pocket`,async()=>{
  await expect(make(fixture(name)).create({quote:{...q,fromAmountSats:200000},payoutAddress:pocket})).rejects.toThrow();
  await expect(make(fixture(name)).create({quote:q,payoutAddress:'0x'+'2'.repeat(40)})).rejects.toThrow();
 });
}
test('ChangeNOW conflicting status amount aliases reject',async()=>{
 const b=fixture('changenow',true);b.toAmount=2;
 const p=changenowProvider({apiKey: 'fixture-only',fetchFn:(async()=>Response.json(b)) as typeof fetch});
 await expect(p.status(b.id)).rejects.toThrow();
});
test('Exolix quote cannot contradict the requested route',async()=>{
 const p=exolixProvider({fetchFn:(async()=>Response.json({toAmount:1,networkTo:'ETH'})) as typeof fetch});
 await expect(p.quote({fromAmountSats:100000})).rejects.toThrow();
});
test('Exolix uses documented transactions endpoint, networkFrom, api-key header',async()=>{
 let path='',data:any,headers:any;
 const p=exolixProvider({apiToken:'synthetic',fetchFn:(async(u,i)=>{path=String(u);data=JSON.parse(String(i?.body));headers=i?.headers;return Response.json(fixture('exolix'));}) as typeof fetch});
 await p.create({quote:{provider:'exolix',fromAsset:'bsv',toAsset:'usdc-base',fromAmountSats:100000,toAmount:1000000},payoutAddress:pocket});
 expect(path).toBe('https://exolix.com/api/v2/transactions');expect(data.networkFrom).toBe('BSV');expect(headers['api-key']).toBe('synthetic');expect(headers.Authorization).toBeUndefined();
});

test('create with an existing deposit hash cannot authorize another deposit',async()=>{
 const b=fixture('exolix');b.hashIn.hash='a'.repeat(64);
 const p=exolixProvider({fetchFn:(async()=>Response.json(b)) as typeof fetch});
 await expect(p.create({quote:{provider:'exolix',fromAsset:'bsv',toAsset:'usdc-base',fromAmountSats:100000,toAmount:1000000},payoutAddress:pocket})).rejects.toThrow();
});
