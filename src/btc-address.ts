import type {PrivateKey} from '@bsv/sdk';
import {Address,OutScript,p2wpkh} from '@scure/btc-signer';

export const BTC_DOMAIN = 'dogfood/btc/v1';
/** Same SDK self-ECDH/Type42 derivation as gryd-buy.propertyKey; distinct invoice domain. */
export function btcKey(key:PrivateKey):PrivateKey { return key.deriveChild(key.toPublicKey(),BTC_DOMAIN); }
export function btcAddress(key:PrivateKey):string {
  return p2wpkh(Uint8Array.from(btcKey(key).toPublicKey().encode(true) as number[])).address!;
}
/** Library validates base58check, bech32/bech32m, witness versions and network. */
export function btcDestination(address:string):{address:string;script:Uint8Array} {
  if(typeof address!=='string'||address.trim()!==address) throw Error('BAD_ADDRESS: mainnet BTC address required');
  try {
    // Decode BEFORE normalizing: mixed-case bech32 must not be repaired.
    const decoded=Address().decode(address);
    if(!['pkh','sh','wpkh','wsh','tr'].includes(decoded.type)) throw Error('Unsupported BTC destination');
    const canonical=Address().encode(decoded);
    return {address:canonical,script:OutScript.encode(decoded)};
  } catch { throw Error('BAD_ADDRESS: invalid mainnet BTC address/checksum'); }
}
export function canonicalBtcDest(address:string):string { return 'btc:'+btcDestination(address).address; }
function compactSize(n:number):number { return n<253?1:n<=0xffff?3:n<=0xffffffff?5:9; }
/** Conservative low-S DER P2WPKH weight: stripped input 41 bytes, witness <=108.
 * Includes marker/flag, CompactSize input/output counts and script lengths. */
export function p2wpkhVsize(inputs:number,outputScriptLengths:number[]):number {
  if(!Number.isSafeInteger(inputs)||inputs<1||outputScriptLengths.some(n=>!Number.isSafeInteger(n)||n<0)) throw Error('Invalid transaction shape');
  const stripped=8+compactSize(inputs)+compactSize(outputScriptLengths.length)+41*inputs+outputScriptLengths.reduce((n,l)=>n+8+compactSize(l)+l,0);
  return Math.ceil((stripped*4+2+108*inputs)/4);
}
