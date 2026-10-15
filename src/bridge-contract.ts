import { Utils } from '@bsv/sdk';
import { BridgeError, type BridgeOrder, type SwapQuote } from './bridge';
export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const orderId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v) && !['null','undefined'].includes(v);
export function bad(): never { throw new BridgeError('PROVIDER_SCHEMA', 'Provider evidence is missing, invalid or conflicting; do not fund or retry.'); }
export function units(v: unknown, decimals: number): number {
  if(typeof v === 'number') { if(!Number.isFinite(v) || v<=0) return bad(); const s=v.toFixed(decimals); if(Number(s)!==v) return bad(); v=s; }
  if(typeof v!=='string' || !/^\d+(?:\.\d+)?$/.test(v)) return bad();
  const [whole,fraction='']=v.split('.');
  if(fraction.length>decimals && /[1-9]/.test(fraction.slice(decimals))) return bad();
  const n=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.slice(0,decimals).padEnd(decimals,'0'));
  if(n<=0n || n>BigInt(Number.MAX_SAFE_INTEGER)) return bad(); return Number(n);
}
export function object(v: unknown): Record<string, any> { if(!v || typeof v!=='object' || Array.isArray(v)) return bad();return v as Record<string,any>; }
export function noMemo(v: unknown) { if(v!==undefined && v!==null && v!=='') bad(); }
export function hash(v: unknown, evm=false): string|undefined { if(v===null||v===undefined) return; if(typeof v!=='string'||!(evm?/^0x[0-9a-fA-F]{64}$/:/^[0-9a-f]{64}$/).test(v)) bad();return v; }
export function validateOrder(o: BridgeOrder): BridgeOrder {
  if(!orderId(o.id) || typeof o.payoutAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(o.payoutAddress) || !Number.isSafeInteger(o.depositAmountSats) || o.depositAmountSats <= 0 || !Number.isSafeInteger(o.payoutAmount) || o.payoutAmount <= 0 || !['waiting','pending','finished','failed'].includes(o.status)) bad();
  try { const a=Utils.fromBase58Check(o.depositAddress); if(a.prefix.length!==1||a.prefix[0]!==0||a.data.length!==20) bad(); } catch { bad(); }
  if(o.status==='finished' && (!o.depositHash||!o.payoutHash)) bad(); return o;
}
export function bindCreate(o: BridgeOrder,q:SwapQuote,address:string) {
  if(q.provider!==o.provider||q.fromAsset!=='bsv'||q.toAsset!=='usdc-base'||o.depositAmountSats!==q.fromAmountSats||o.payoutAddress.toLowerCase()!==address.toLowerCase()||o.status!=='waiting'||o.depositHash!==undefined||o.payoutHash!==undefined) bad();
  return o;
}
// Preserve only a sanitized candidate ID when parsing fails after POST. A
// candidate does not authorize funding or settlement.
export function parseEvidence(body:unknown, parse:(b:Record<string,any>)=>BridgeOrder):BridgeOrder {
 const b=object(body); try {return parse(b);} catch { const e=new BridgeError('PROVIDER_SCHEMA','Provider evidence is missing, invalid or conflicting; order remains quarantined.');if(orderId(b.id)) Object.assign(e,{candidateOrderId:b.id});throw e; }
}
