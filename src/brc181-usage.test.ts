import {expect,test} from 'bun:test';
import {usageFromLog} from './policy';

test('signed BRC satoshi debit scope aggregates bridge and legacy BSV, fees exactly once, excludes other assets',()=>{
 const t=new Date().toISOString();
 const lines=[{amount:100,fee:20},{asset:'bsv',amount:200,fee:30},{asset:'bridge-bsv',kind:'bridge-out',amount:300,fee:40},{asset:'bridge-usdc-base',amount:900},{asset:'usdc-base',amount:900},{asset:'usdc-solana',amount:900},{asset:'bsv',kind:'split',amount:900},{asset:'bsv',kind:'sweep',amount:900},{kind:'allowance-sweep',amount:900},{kind:'allowance-fund',amount:50}].map(r=>JSON.stringify({t,...r}));
 expect(usageFromLog(lines,new Date(),'brc181-bsv').spentLifetime).toBe(740);
 expect(usageFromLog(lines).spentLifetime).toBe(350);
 expect(usageFromLog(lines,new Date(),'bridge-bsv').spentLifetime).toBe(300);
});

test('signed BRC USDC scopes aggregate their own payment asset only (no bridge arrivals, no fees, no cross-asset)',()=>{
 const t=new Date().toISOString();
 const lines=[{asset:'bsv',amount:200,fee:30},{asset:'bridge-bsv',amount:300,fee:40},{asset:'usdc-base',amount:900},{asset:'usdc-base',amount:100},{asset:'usdc-solana',amount:500},{asset:'bridge-usdc-base',amount:700},{asset:'usdc-base',kind:'sweep',amount:900}].map(r=>JSON.stringify({t,...r}));
 expect(usageFromLog(lines,new Date(),'brc181-usdc-base').spentLifetime).toBe(1000);
 expect(usageFromLog(lines,new Date(),'brc181-usdc-solana').spentLifetime).toBe(500);
});
