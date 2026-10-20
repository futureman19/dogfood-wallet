import type {PrivateKey} from '@bsv/sdk';
import {Address,OutScript,p2pkh} from '@scure/btc-signer';
import {compactSize} from './utxo-treasury';
export const DOGE_DOMAIN='dogfood/doge/v1';
// bech32 is required by the library's network type, NOT an accepted address format.
export const DOGE_NETWORK={pubKeyHash:0x1e,scriptHash:0x16,wif:0x9e,bech32:'doge'};
export function dogeKey(key:PrivateKey):PrivateKey{return key.deriveChild(key.toPublicKey(),DOGE_DOMAIN);}
export function dogeAddress(key:PrivateKey):string{return p2pkh(Uint8Array.from(dogeKey(key).toPublicKey().encode(true) as number[]),DOGE_NETWORK).address!;}
export function dogeDestination(address:string):{address:string;script:Uint8Array}{
  try{
    // Base58 alphabet and exact decoded type exclude ALL witness encodings.
    if(typeof address!=='string'||! /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{26,35}$/.test(address))throw Error();
    const decoded=Address(DOGE_NETWORK).decode(address);
    if(decoded.type!=='pkh'&&decoded.type!=='sh')throw Error();
    if(Address(DOGE_NETWORK).encode(decoded)!==address)throw Error();
    return {address,script:OutScript.encode(decoded)};
  }catch{throw Error('BAD_ADDRESS: invalid mainnet DOGE base58check P2PKH/P2SH destination');}
}
export function canonicalDogeDest(address:string):string{return 'doge:'+dogeDestination(address).address;}
/** Legacy compressed P2PKH: <=148 bytes/input with low-S DER SIGHASH_ALL.
 * Includes CompactSize counts and script lengths; no witness discount. */
export function p2pkhSize(inputs:number,outputs:number[]):number{
  if(!Number.isSafeInteger(inputs)||inputs<1||outputs.some(n=>!Number.isSafeInteger(n)||n<0))throw Error('Invalid transaction shape');
  return 8+compactSize(inputs)+compactSize(outputs.length)+148*inputs+outputs.reduce((n,l)=>n+8+compactSize(l)+l,0);
}
