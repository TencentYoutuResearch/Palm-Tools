/** Invoke directly with node; ordinary test discovery cannot start a provider. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {readFile,writeFile,mkdir,rm,appendFile} from 'node:fs/promises'
import {dirname,join,isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {nativeTaskClarificationSource} from './native-task-clarification-source.js'
export function nativeTaskEnvironment(input){
 assert.equal(input.KODE_TEST_LIVE_TASK_CLARIFICATION,'1');assert.equal(input.KODE_TEST_LIVE_FREE_WRAPPER,'1')
 const required=['HOST_NODE','MANAGED_CODEX_EXECUTABLE','MANAGED_CODEX_WRAPPER','WRAPPER_PROVIDER','WRAPPER_HOME','NATIVE_MODEL','LIVE_EVIDENCE_DIR','BACKEND_URL']
 const env=Object.fromEntries(Object.entries(input).filter(([key])=>!key.startsWith('KODE_TEST_')&&key!=='NODE_TEST_CONTEXT'))
 for(const name of required){const key='KODE_TEST_'+name;assert.ok(input[key],`Explicit ${key} required`);env[key]=input[key]}
 for(const name of ['HOST_NODE','MANAGED_CODEX_EXECUTABLE','MANAGED_CODEX_WRAPPER','WRAPPER_HOME','LIVE_EVIDENCE_DIR'])assert.ok(isAbsolute(env['KODE_TEST_'+name]),`${name} must be absolute`)
 assert.ok([undefined,'idle'].includes(input.KODE_TEST_NATIVE_TASK_ZERO_PROVIDER_FAILURE),'Unknown controlled cleanup case')
 return {...env,...(input.KODE_TEST_NATIVE_TASK_ZERO_PROVIDER_FAILURE?{KODE_TEST_NATIVE_TASK_ZERO_PROVIDER_FAILURE:input.KODE_TEST_NATIVE_TASK_ZERO_PROVIDER_FAILURE}:{}),KODE_TEST_LIVE_TASK_CLARIFICATION:'1',KODE_TEST_LIVE_FREE_WRAPPER:'1',KODE_TEST_LIVE_COORDINATOR:'1',KODE_TEST_NATIVE_TASK_SETUP_ONLY:input.KODE_TEST_NATIVE_TASK_SETUP_ONLY==='1'?'1':'0'}
}
export async function runNativeTask(input=process.env){
 const env=nativeTaskEnvironment(input),directory=env.KODE_TEST_LIVE_EVIDENCE_DIR
 // Must be a new evidence scene; never overwrite any prior acceptance evidence.
 await mkdir(directory,{recursive:false,mode:0o700})
 const here=dirname(fileURLToPath(import.meta.url)),script=join(here,'..','.native-task-'+randomUUID()+'.mjs')
 const source=nativeTaskClarificationSource(await readFile(join(here,'..','fixture-coordinator-pipeline.js'),'utf8'),{zeroProviderFailure:env.KODE_TEST_NATIVE_TASK_ZERO_PROVIDER_FAILURE==='idle'})
 await writeFile(script,source,{flag:'wx',mode:0o600})
 let pending=Promise.resolve(),buffer='',summary,retained,failure
 try{
  const child=spawn(env.KODE_TEST_HOST_NODE,['--test','--test-reporter=spec',script],{env,stdio:['ignore','pipe','pipe']})
  const output=chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);pending=pending.then(()=>appendFile(join(directory,'runner.log'),line+'\n',{mode:0o600}));const start=line.indexOf('{');if(start>=0){try{const value=JSON.parse(line.slice(start));if(value.native_task_summary)summary=value.native_task_summary;if(value.native_task_retained)retained=value.native_task_retained;if(value.native_task_failure)failure=value.native_task_failure}catch{}}}if(buffer.length>262144)buffer=buffer.slice(-262144)}
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',output);child.stderr.on('data',output)
  const [code,signal]=await once(child,'close');await pending
  if(code!==0){const error=new Error(failure?.original_error?.message??`Native task failed (${signal??code}); inspect private evidence runner.log`);error.cleanup=failure?.cleanup??{state:'unconfirmed'};error.original=failure?.original_error;throw error}
  assert.ok(summary&&retained)
  return {summary,retained}
 }finally{await pending;await rm(script,{force:true})}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 if(process.env.KODE_TEST_LIVE_TASK_CLARIFICATION!=='1'||process.env.KODE_TEST_LIVE_FREE_WRAPPER!=='1')console.log('SKIP native task: both explicit gates are required')
 else console.log(JSON.stringify(await runNativeTask()))
}
