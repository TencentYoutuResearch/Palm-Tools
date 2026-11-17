/** Zero-provider checks. The runner is direct-invocation only and defaults to skip. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {nativeDiscussionEnvironment} from './support/native-discussion-runner.js'
import {nativeDiscussionSource} from './support/native-discussion-source.js'
import {assertDiscussionReply,nativeDiscussionOwnerText} from './support/native-discussion-pipeline.js'
const env={KODE_TEST_LIVE_NATIVE_DISCUSSION:'1',KODE_TEST_LIVE_FREE_WRAPPER:'1',KODE_TEST_HOST_NODE:'/node',KODE_TEST_MANAGED_CODEX_EXECUTABLE:'/engine',KODE_TEST_MANAGED_CODEX_WRAPPER:'/wrapper',KODE_TEST_WRAPPER_HOME:'/home',KODE_TEST_WRAPPER_PROVIDER:'example',KODE_TEST_NATIVE_MODEL:'example',KODE_TEST_LIVE_EVIDENCE_DIR:'/new-evidence',KODE_TEST_BACKEND_URL:'http://127.0.0.1:1'}
test('discussion runner requires both gates and explicit configuration, strips unrelated scenarios',()=>{
 for(const key of Object.keys(env)){const missing={...env};delete missing[key];assert.throws(()=>nativeDiscussionEnvironment(missing))}
 for(const key of ['HOST_NODE','MANAGED_CODEX_EXECUTABLE','MANAGED_CODEX_WRAPPER','WRAPPER_HOME','LIVE_EVIDENCE_DIR'])assert.throws(()=>nativeDiscussionEnvironment({...env,['KODE_TEST_'+key]:'relative'}))
 const result=nativeDiscussionEnvironment({...env,KODE_TEST_REMOTE_ANSWER:'1',KODE_TEST_LIVE_TASK_CLARIFICATION:'1',NODE_TEST_CONTEXT:'child'})
 assert.equal(result.KODE_TEST_REMOTE_ANSWER,undefined);assert.equal(result.KODE_TEST_LIVE_TASK_CLARIFICATION,undefined);assert.equal(result.NODE_TEST_CONTEXT,undefined)
})
test('native discussion runner skips with no gate without preparing evidence or launching a provider',async()=>{
 const clean=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('KODE_TEST_')&&k!=='NODE_TEST_CONTEXT'))
 const {stdout}=await promisify(execFile)(process.execPath,['test/support/native-discussion-runner.js'],{env:clean})
 assert.match(stdout,/SKIP native discussion/)
})
test('fixture source seam excludes legacy scenario and response-loss injection before dispatch',async()=>{
 const original=await readFile(new URL('./fixture-coordinator-pipeline.js',import.meta.url),'utf8'),source=nativeDiscussionSource(original)
 assert.ok(source.indexOf('await nativeDiscussionPipeline(')<source.indexOf('const plan=await host.planCoordinatorStart'))
 assert.ok(source.includes("throw Error('Controlled adapter forbidden"));assert.ok(source.includes('timeout:Infinity'))
 assert.ok(source.includes('let lostPublication=true'));assert.ok(source.includes('lostStart=true'))
 assert.throws(()=>nativeDiscussionSource(original.replace("  const automatic=",'  const removed=')))
})
test('only exact formal reply on originating surface/thread/source succeeds',()=>{
 const source={id:'source',surface_id:'surface',thread_id:'thread'},reply={in_reply_to:'source',surface_id:'surface',thread_id:'thread',content:'REQ-DISC-A',actor:{kind:'superagent'}}
 assertDiscussionReply(source,reply,'REQ-DISC-A')
 for(const field of ['in_reply_to','surface_id','thread_id','content'])assert.throws(()=>assertDiscussionReply(source,{...reply,[field]:'foreign'},'REQ-DISC-A'))
 assert.throws(()=>assertDiscussionReply(source,{...reply,actor:{kind:'human'}},'REQ-DISC-A'))
 assert.throws(()=>assertDiscussionReply(source,{type:'assistant/message',content:'REQ-DISC-A'},'REQ-DISC-A'))
})

test('owner discussion wording is natural and does not teach internal tool invocation',()=>{
 for(const name of ['A','B']){
  const content=nativeDiscussionOwnerText(name)
  assert.ok(content.includes('REQ-DISC-'+name))
  assert.match(content,/只讨论/);assert.match(content,/不要开始做任务/)
  assert.doesNotMatch(content,/kode_|publish|assistant|API|工具|source|Run/)
 }
 assert.match(nativeDiscussionOwnerText('B'),/另一个讨论串分开跟进/)
 assert.throws(()=>nativeDiscussionOwnerText('C'))
})
