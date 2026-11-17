/** Prepared opt-in acceptance. Normal test runs never load or call a provider. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {readFile,writeFile,appendFile,mkdir,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {dirname,join,isAbsolute} from 'node:path'
import {randomUUID} from 'node:crypto'
import {liveParallelFixtureSource} from './support/live-parallel-fixture-source.js'
const enabled=process.env.KODE_TEST_LIVE_PARALLEL_COORDINATOR==='1'&&process.env.KODE_TEST_LIVE_FREE_WRAPPER==='1'
test('actual free Hy4 Coordinator independently tracks two natural-language requirements', {skip:!enabled},async t=>{
 const required=['KODE_TEST_HOST_NODE','KODE_TEST_MANAGED_CODEX_EXECUTABLE','KODE_TEST_MANAGED_CODEX_WRAPPER','KODE_TEST_WRAPPER_PROVIDER','KODE_TEST_WRAPPER_HOME','KODE_TEST_NATIVE_MODEL','KODE_TEST_LIVE_EVIDENCE_DIR','KODE_TEST_BACKEND_URL']
 for(const key of required)assert.ok(process.env[key],`Explicit ${key} required`)
 const scenario=process.env.KODE_TEST_LIVE_PARALLEL_SCENARIO??'complete-both'
 assert.ok(['complete-both','cancel-a-before-dispatch'].includes(scenario));assert.ok(isAbsolute(process.env.KODE_TEST_LIVE_EVIDENCE_DIR))
 const here=dirname(fileURLToPath(import.meta.url)),script=join(here,'.parallel-live-'+randomUUID()+'.mjs'),directory=process.env.KODE_TEST_LIVE_EVIDENCE_DIR
 const source=liveParallelFixtureSource(await readFile(join(here,'fixture-coordinator-pipeline.js'),'utf8'))
 // Explicit test flags only. Unrelated caller scenarios must not change the acceptance path.
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('KODE_TEST_')&&key!=='NODE_TEST_CONTEXT'))
 for(const key of required)env[key]=process.env[key]
 Object.assign(env,{KODE_TEST_LIVE_FREE_WRAPPER:'1',KODE_TEST_LIVE_PARALLEL_COORDINATOR:'1',KODE_TEST_LIVE_PARALLEL_SCENARIO:scenario,KODE_TEST_LIVE_COORDINATOR:'1',KODE_TEST_LIVE_WORKER:'0',KODE_TEST_NATIVE_ANSWER:'0',KODE_TEST_REMOTE_ANSWER:'0'})
 await mkdir(directory,{recursive:true,mode:0o700});await writeFile(script,source,{flag:'wx',mode:0o600})
 let summary,retained,child,writing=Promise.resolve(),buffer=''
 const line=text=>{const index=text.indexOf('{');if(index<0)return;let value;try{value=JSON.parse(text.slice(index))}catch{return}
  if(value.live_parallel_summary){summary=value.live_parallel_summary;}
  else if(value.live_parallel_retained_hub){retained=value.live_parallel_retained_hub;}
  else if(value.live_parallel_failure||value.live_parallel_progress||value.live_evidence||value.managed_decision_summary){}
  else return
  writing=writing.then(()=>appendFile(join(directory,'parallel-metadata.jsonl'),JSON.stringify(value)+'\n',{mode:0o600}))
 }
 try{
  child=spawn(env.KODE_TEST_HOST_NODE,['--test','--test-reporter=spec',script],{env,stdio:['ignore','pipe','ignore']})
  // Stream selective metadata; neither duration nor stdout volume kills a progressing CLI.
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){line(buffer.slice(0,end));buffer=buffer.slice(end+1)}if(buffer.length>262144)buffer=buffer.slice(-262144)})
  const [code,signal]=await once(child,'close');await writing
  assert.equal(code,0,`Live acceptance failed (${signal??code}); retained Hub metadata and native evidence remain available`)
  assert.ok(summary&&retained,'successful acceptance requires final scoped proof plus retained scene metadata')
  t.diagnostic(JSON.stringify({live_parallel_summary:summary,retained_scene:retained}))
 }finally{await writing;await rm(script,{force:true})}
})
