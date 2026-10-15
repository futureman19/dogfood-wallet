import { type BridgeOrderStatus, type BridgeProvider } from './bridge';
import { bad,bindCreate,hash,noMemo,object,orderId,parseEvidence,units,validateOrder } from './bridge-contract';
// Official v2 schema: docs/bridge-provider-contracts.md. No live compatibility claim.
const API='https://api.changenow.io/v2';
const states:Record<string,BridgeOrderStatus>={new:'waiting',waiting:'waiting',confirming:'pending',exchanging:'pending',sending:'pending',verifying:'pending',finished:'finished',failed:'failed',refunded:'failed'};
export function changenowProvider(opts:{apiKey:string;fetchFn?:typeof fetch;usdcCurrency?:string;usdcNetwork?:string}):BridgeProvider {
 async function req(path:string,init?:RequestInit) {
  if((opts.usdcCurrency??'usdc')!=='usdc'||(opts.usdcNetwork??'base')!=='base') bad();
  const res=await (opts.fetchFn??fetch)(API+path,{...init,redirect:'error',headers:{'content-type':'application/json','x-changenow-api-key':opts.apiKey}});
  if(!res.ok) throw new Error(`ChangeNOW request refused (HTTP ${res.status}); response body omitted.`);
  return object(await res.json());
 }
 function route(b:Record<string,any>) {
  if(b.fromCurrency!=='bsv'||b.fromNetwork!=='bsv'||b.toCurrency!=='usdc'||b.toNetwork!=='base') bad();
 }
 function parse(body:unknown,create=false) {return parseEvidence(body,b=>{
  route(b);noMemo(b.payinExtraId);noMemo(b.payoutExtraId);
  if(!orderId(b.id)||b.id.length!==14) bad();
  if(create && (b.flow!=='standard'||b.type!=='direct')) bad();
  if(!create && (typeof b.status!=='string'||!Object.hasOwn(states,b.status))) bad();
  if(create && b.status!==undefined && b.status!=='new' && b.status!=='waiting') bad();
  const finished=b.status==='finished';
  const amount=create?b.fromAmount:finished?b.amountFrom:b.expectedAmountFrom;
  const payout=create?b.toAmount:finished?b.amountTo:b.expectedAmountTo;
  if(!create){if(b.fromAmount!==undefined&&units(b.fromAmount,8)!==units(amount,8))bad();if(b.toAmount!==undefined&&units(b.toAmount,6)!==units(payout,6))bad();}
  return validateOrder({provider:'changenow',id:b.id,depositAddress:b.payinAddress,depositAmountSats:units(amount,8),payoutAddress:b.payoutAddress,payoutAmount:units(payout,6),status:create?'waiting':states[b.status],depositHash:hash(b.payinHash),payoutHash:hash(b.payoutHash,true)});
 });}
 return {name:'changenow',async quote({fromAmountSats}) {
  if(!Number.isSafeInteger(fromAmountSats)||fromAmountSats<=0) bad();
  const b=await req(`/exchange/estimated-amount?fromCurrency=bsv&toCurrency=usdc&fromNetwork=bsv&toNetwork=base&fromAmount=${fromAmountSats/1e8}&flow=standard&type=direct`);
  route(b);if(b.flow!=='standard'||b.type!=='direct'||units(b.fromAmount,8)!==fromAmountSats) bad();
  return {provider:'changenow',fromAsset:'bsv',toAsset:'usdc-base',fromAmountSats,toAmount:units(b.toAmount,6)};
 },async create({quote,payoutAddress}) {
  const b=await req('/exchange',{method:'POST',body:JSON.stringify({fromCurrency:'bsv',fromNetwork:'bsv',toCurrency:'usdc',toNetwork:'base',fromAmount:quote.fromAmountSats/1e8,address:payoutAddress,flow:'standard',type:'direct'})});
  return bindCreate(parse(b,true),quote,payoutAddress);
 },async status(id) {
  if(!orderId(id)||id.length!==14) bad();const o=parse(await req(`/exchange/by-id?id=${encodeURIComponent(id)}`));if(o.id!==id) bad();return o;
 }};
}
