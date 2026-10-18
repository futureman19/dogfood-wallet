import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../mcp';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initVault} from '../vault';
const root=mkdtempSync(join(tmpdir(),'agent-post-mcp-'));
const client=new Client({name:'agent-post-isolation',version:'1'}),server=createServer(root);
globalThis.fetch=(()=>{throw Error('Network forbidden in MCP isolation');}) as unknown as typeof fetch;
try{
 initVault(root);
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 const listed=await client.listTools();
 if(listed.tools.some(t=>/agent.post|agent.call/i.test(t.name)))throw Error('Human-only tool exposed');
 for(const name of ['agent_post','agent-post','agent_call']){const result=await client.callTool({name,arguments:{action:'agent.mine',input:{route:{},body:{}}}});if(!result.isError)throw Error('Unexpected tool accepted');}
 console.log(JSON.stringify({isolated:true,names:listed.tools.map(t=>t.name)}));
}finally{await client.close();await server.close();rmSync(root,{recursive:true,force:true});}
