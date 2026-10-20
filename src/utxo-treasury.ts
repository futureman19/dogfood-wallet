import {closeSync,fsyncSync,mkdirSync,openSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
export function compactSize(n:number):number{return n<253?1:n<=0xffff?3:n<=0xffffffff?5:9;}
export function treasuryEvidence(root:string,rail:string,id:string,value:unknown) {
  const dir=join(root,rail+'-sends');mkdirSync(dir,{recursive:true,mode:0o700});
  const fd=openSync(join(dir,id+'.json'),'wx',0o600);
  try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  if(process.platform!=='win32'){const d=openSync(dir,'r');try{fsyncSync(d);}finally{closeSync(d);}}
}
