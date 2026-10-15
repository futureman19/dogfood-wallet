import { bridgeAmount, BridgeError, type BridgeOrderStatus, type BridgeProvider } from './bridge';
import { BASE_USDC,bad,bindCreate,hash,noMemo,object,orderId,parseEvidence,units,validateOrder } from './bridge-contract';
// Schema source: docs/bridge-provider-contracts.md. No live compatibility claim.
const API='https://exolix.com/api/v2';
const states:Record<string,BridgeOrderStatus>={wait:'waiting',confirmation:'pending',confirmed:'pending',exchanging:'pending',sending:'pending',success:'finished',overdue:'failed',refund:'pending',refunded:'failed'};
export function exolixProvider(opts:{fetchFn?:typeof fetch;apiToken?:string;usdcNetwork?:string;rateType?:'float'|'fixed'}):BridgeProvider {
 const network=opts.usdcNetwork??'BASE',rateType=opts.rateType??'float';
 async function req(path:string,init?:RequestInit) {
  if(network!=='BASE'||!['float','fixed'].includes(rateType)) bad();
  const headers:Record<string,string>={'content-type':'application/json',accept:'application/json'};
  if(opts.apiToken) headers['api-key']=opts.apiToken;
  const res=await (opts.fetchFn??fetch)(API+path,{...init,headers,redirect:'error'});
  if(!res.ok) throw new Error(`Exolix request refused (HTTP ${res.status}); response body omitted.`);
  return object(await res.json());
 }
 function parse(body:unknown) { return parseEvidence(body,b=>{
  const from=object(b.coinFrom),to=object(b.coinTo);
  if(from.coinCode!=='BSV'||from.network!=='BSV'||from.contract!==null||to.coinCode!=='USDC'||to.network!=='BASE'||typeof to.contract!=='string'||to.contract.toLowerCase()!==BASE_USDC) bad();
  for(const key of ['deposit_address','toAmount','networkTo','networkFrom','payoutHash','hash_out']) if(key in b) bad();
  noMemo(b.depositExtraId);noMemo(b.withdrawalExtraId);
  if(typeof b.status!=='string'||!Object.hasOwn(states,b.status)) bad();
  return validateOrder({provider:'exolix',id:b.id,depositAddress:b.depositAddress,depositAmountSats:units(b.amount,8),payoutAddress:b.withdrawalAddress,payoutAmount:units(b.amountTo,6),status:states[b.status],depositHash:hash(object(b.hashIn).hash),payoutHash:hash(object(b.hashOut).hash,true)});
 });}
 return {name:'exolix',async quote({fromAmountSats}) {
  if(!Number.isSafeInteger(fromAmountSats)||fromAmountSats<=0) bad();
  const b=await req(`/rate?coinFrom=BSV&networkFrom=BSV&coinTo=USDC&networkTo=BASE&amount=${fromAmountSats/1e8}&rateType=${rateType}`);
  for(const [key,value] of Object.entries({coinFrom:'BSV',networkFrom:'BSV',coinTo:'USDC',networkTo:'BASE'}))if(b[key]!==undefined&&b[key]!==value)bad();
  const amount=bridgeAmount(b.toAmount);
  if(!Number.isFinite(amount)) {const min=bridgeAmount(b.minAmount);throw new BridgeError('BELOW_MIN',`REJECTED: below Exolix minimum${Number.isFinite(min)?` (${Math.ceil(min*1e8)} sats ≈ ${min} BSV)`:''}.`);}
  const toAmount=Math.floor(amount*1e6);if(!Number.isSafeInteger(toAmount)||toAmount<=0) bad();
  return {provider:'exolix',fromAsset:'bsv',toAsset:'usdc-base',fromAmountSats,toAmount};
 },async create({quote,payoutAddress}) {
  const body=await req('/transactions',{method:'POST',body:JSON.stringify({coinFrom:'BSV',networkFrom:'BSV',coinTo:'USDC',networkTo:'BASE',amount:quote.fromAmountSats/1e8,withdrawalAddress:payoutAddress,rateType})});
  return bindCreate(parse(body),quote,payoutAddress);
 },async status(id) {
  if(!orderId(id)) bad();const o=parse(await req(`/transactions/${encodeURIComponent(id)}`));if(o.id!==id) bad();return o;
 }};
}
