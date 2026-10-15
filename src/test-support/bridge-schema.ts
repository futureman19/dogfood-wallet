// Synthetic schema-derived fixtures; see docs/bridge-provider-contracts.md.
const pocket = '0x1111111111111111111111111111111111111111';
const payin = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export function fixture(name: string, done = false): any {
  return name === 'exolix' ? { id:'synthetic00001', amount:0.001, amountTo:1,
    coinFrom:{coinCode:'BSV',network:'BSV',contract:null}, coinTo:{coinCode:'USDC',network:'BASE',contract:usdc},
    depositAddress:payin,withdrawalAddress:pocket,status:done?'success':'wait',
    hashIn:{hash:done?'a'.repeat(64):null,link:null},hashOut:{hash:done?'0x'+'b'.repeat(64):null,link:null} }
    : {id:'synthetic00001',fromCurrency:'bsv',fromNetwork:'bsv',toCurrency:'usdc',toNetwork:'base',
      fromAmount:0.001,toAmount:1,flow:'standard',type:'direct',payinAddress:payin,payoutAddress:pocket,
      ...(done?{status:'finished',expectedAmountFrom:0.001,expectedAmountTo:1,amountFrom:0.001,amountTo:1,
        payinHash:'a'.repeat(64),payoutHash:'0x'+'b'.repeat(64)}:{})};
}
