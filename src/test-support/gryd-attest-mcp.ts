import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../mcp';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'agent-attest-mcp-'));
const client=new Client({name:'agent-attest-isolation',version:'1'}),server=createServer(root);
globalThis.fetch=(()=>{throw Error('Network forbidden in MCP isolation');}) as unknown as typeof fetch;
try{
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 const listed=await client.listTools();
 if(listed.tools.some(t=>/attest/i.test(t.name)))throw Error('Human-only tool exposed');
 for(const name of ['agent_attest','agent-attest','agent_attest_verify','agent-attest-verify']){
   const result=await client.callTool({name,arguments:{observation:{},txid:'00'.repeat(32)}});
   if(!result.isError)throw Error('Unexpected tool accepted');
 }
 if(readdirSync(root).length)throw Error('Isolation accessed vault');
 console.log(JSON.stringify({isolated:true,names:listed.tools.map(t=>t.name)}));
}finally{await client.close();await server.close();rmSync(root,{recursive:true,force:true});}
