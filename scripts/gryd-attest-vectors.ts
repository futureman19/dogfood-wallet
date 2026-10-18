// Read-only protocol oracle. No checkout changes or vault/network access.
// bun scripts/gryd-attest-vectors.ts <grid-root> [commit]
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {BSM,PrivateKey,Utils} from '@bsv/sdk';
const root=process.argv[2];if(!root)throw Error('Read-only Gryd root required');
const sourceCommit=process.argv[3]??'e6763c71f75a12acf8df3529e4ccc3fd50b16d80';
if(!/^[a-f0-9]{40}$/.test(sourceCommit))throw Error('Full pinned commit required');
const sourcePath='packages/locus-protocol/src/signed-write.ts';
const source=execFileSync('git',['-C',root,'show',`${sourceCommit}:${sourcePath}`]);
const sourceSha256=createHash('sha256').update(source).digest('hex');
const scratch=mkdtempSync(join(tmpdir(),'attest-protocol-'));
try{
 const file=join(scratch,'signed-write.ts');writeFileSync(file,source);
 const protocol=await import(pathToFileURL(file).href);
 const key=PrivateKey.fromHex('1'.padStart(64,'0')); // public synthetic key, not a vault
 const base={type:'weather.reading',lat:12.5,lng:-20,observedAt:'2026-01-02T03:04:05.000Z',source:{kind:'sensor',ref:'station:synthetic-1'},payload:{},agent:{id:'synthetic:scout',ownerAddress:key.toAddress()}};
 const inputs=[{...base,payload:{'2':'two','10':'ten',temperatureC:21,unicode:'雪'}},{...base,type:'presence.attestation',source:{kind:'human',ref:'manual:synthetic'},payload:{z:[true,false,null,-0,1e-7,1e21],a:{'10':10,'2':2,'02':'02'},text:'Café 🌍\n"quoted"\\'}},{...base,type:'event.report',source:{kind:'api',ref:'https://example.invalid/not-fetched'},payload:{event:'synthetic',nested:{z:1,a:2}}}];
 const vectors=inputs.map(input=>{
   const canonical=protocol.canonicalJson(input),observation=JSON.parse(canonical),message='Dogfood Attestation v1\n'+canonical;
   return {observation,canonical,message,utf8Hex:Buffer.from(message).toString('hex'),signed:{observation,pubkey:key.toPublicKey().toString(),signature:BSM.sign(Utils.toArray(message,'utf8'),key,'base64')}};
 });
 writeFileSync(new URL('../testdata/gryd-attest-vectors.json',import.meta.url),JSON.stringify({sourceRef:'origin/dev',sourceCommit,sourcePath,sourceSha256,protocolPrefix:protocol.SIGNED_WRITE_MESSAGE_PREFIX,attestationPrefix:'Dogfood Attestation v1\n',syntheticKey:'public scalar 1 (never fund)',vectors},null,2)+'\n');
 console.log(JSON.stringify({sourceCommit,sourceSha256,vectors:vectors.length}));
}finally{rmSync(scratch,{recursive:true,force:true});}
