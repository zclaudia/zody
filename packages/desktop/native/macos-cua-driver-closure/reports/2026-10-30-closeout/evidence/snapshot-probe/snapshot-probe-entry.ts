import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile,readFile,writeFile,rename,unlink,mkdir} from 'node:fs/promises';
import {createSubprocessNodeReplExecutor as oldExecutor} from './snapshot-probe/opening-src/subprocess-executor.js';
import {createSubprocessNodeReplExecutor} from '../../apps/zcode-cli/packages/node-repl-host/src/subprocess-executor.js';
import {readSealedResourceSnapshot} from '../../apps/zcode-cli/packages/node-repl-host/src/sealed-resource.js';
const root=process.argv[2];
const source=await readFile(root+'/server.mjs');const hash=createHash('sha256').update(source).digest('hex');
const path=root+'/resource.mjs';await copyFile(root+'/server.mjs',path);
const snapshot=await readSealedResourceSnapshot({path,expectedSha256:hash,maxBytes:64*1024*1024});
const old=oldExecutor({serverPath:path,jitless:true});
const fixed=createSubprocessNodeReplExecutor({serverPath:path,sourceSnapshot:snapshot.source});
const input=()=>({code:'({answer:6*7,pid:process.pid,argv:process.argv,execArgv:process.execArgv})',requestMeta:{session_id:'controller-snapshot-probe',workspace_path:process.cwd()},signal:AbortSignal.timeout(15000),syncTimeoutMs:5000});
const outcomes:any[]=[];
await rename(path,path+'.renamed');await writeFile(path,'throw new Error("CONTROLLER_UNVERIFIED_RESOURCE_EXECUTED");\n',{mode:0o600});
try{await old(input());throw Error('opening executor did not expose replacement');}catch(e){assert.match(String(e),/CONTROLLER_UNVERIFIED_RESOURCE_EXECUTED/);outcomes.push({mode:'opening-path',replacement:'rename',observed:'unverified replacement executed (regression red)'});}
for(const replacement of ['rename','in-place','unlink']){
 if(replacement==='in-place')await writeFile(path,'throw new Error("SECOND_UNVERIFIED_RESOURCE");\n');
 if(replacement==='unlink')await unlink(path);
 const result=await fixed(input());const value=JSON.parse(result.result!);assert.equal(value.answer,42);assert.equal(value.argv[1],'-');assert(value.execArgv.includes('--jitless'));assert(value.execArgv.includes('--input-type=module'));outcomes.push({mode:'fixed-snapshot',replacement,observed:'original verified server executed',value});
}
const report={node:process.execPath,nodeVersion:process.version,sourceSha256:hash,sourceBytes:source.length,outcomes,claim:'real bundled server + signed Node cell execution; no native capture/authority or full D06 claim'};
await writeFile(root+'/result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
