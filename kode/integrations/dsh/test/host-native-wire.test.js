import test from 'node:test'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {AcpSession} from '../src/acp-session.js'
import {createNativeContextInputClient} from '../src/native-context-input-client.js'
import {createScopedRolePromptResolver} from '../src/native-scoped-role-prompt.js'
const fixture=JSON.parse(await readFile(new URL('./support/runtime-source-authority.fixture.json',import.meta.url),'utf8'))
for(const mode of ['allow','duplicate','lost','unsupported'])test(`Host transport + true Hub source DTO + original ACP wire ${mode}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kode-host-wire-')),log=join(dir,'rpc.jsonl'),a=fixture.authority
 const frozen=fixture.host_binding.frozen
 const binding={context_key:a.context_key,session_id:a.session_id,journal_id:a.journal_id,host_binding_id:fixture.host_binding.binding_id,manifest_sha256:frozen.manifest_sha256,operation:{id:a.operation_id,attempt:a.attempt,epoch:a.epoch}}
 const text='SOURCE_ONLY_THIS_THREAD',source={authority:a,entry:{id:'entry',claim_id:'claim',state:'claimed',context_key:a.context_key,journal_id:a.journal_id,operation_id:a.operation_id,source_message_id:'message',source_content_sha256:createHash('sha256').update(text).digest('hex')},message:{id:'message',content:text}}
 fixture.team_snapshot.spec.coordinator_prompt='ROLE_ONLY_THIS_TEAM'
 fixture.team_snapshot.spec.workers=[{id:'other',role_prompt:'FOREIGN_ROLE_CANARY'}]
 let begins=0
 const transport=createNativeContextInputClient({binding,client:{async call(path,body){
  begins++;assert.ok(path.endsWith('/native-inputs'));assert.doesNotMatch(await readFile(log,'utf8'),/"method":"session\/prompt"/)
  if(mode==='lost')throw Error('lost response')
  return {admission_id:'admission',context_key:a.context_key,request_id:body.request_id,entry_id:'entry',claim_id:'claim',operation_id:a.operation_id,attempt:a.attempt,epoch:a.epoch,session_id:a.session_id,journal_id:a.journal_id,state:'admitted',new_admission:mode==='allow',dispatch_allowed:mode==='allow',profile_id:'conversation_reply_v1',tools:[]}
 }}})
 const resolve=createScopedRolePromptResolver({ownsAgent:agent=>agent.id===a.session_id,sourceAuthority:async()=>structuredClone(fixture),readTeam:async(id,rev)=>({id,home_hub:a.context_scope.home_hub,revision:rev,spec:{coordinator_prompt:'ROLE_ONLY_THIS_TEAM',workers:[{id:'other',role_prompt:'FOREIGN_ROLE_CANARY'}]}})})
 const s=new AcpSession({type:'cursor',executable:process.execPath,args:[fileURLToPath(new URL('./fixture-acp-server.js',import.meta.url))],env:{KODE_ACP_FIXTURE_LOG:log,KODE_ACP_ROLE_PROMPT:mode==='unsupported'?'0':'1'}},dir,{policy:()=>({mode:'read-only'}),resolveRolePrompt:({mode})=>resolve({id:a.session_id},{authority:a,mode})})
 try{
  if(mode==='unsupported'){await assert.rejects(s.open({},[]),/does not advertise/);assert.equal(begins,0);return}
  await s.open({},[])
  const run=async()=>{for await(const _ of s.turn([{type:'text',text}],{model:'fixture-fast',beforeInference:()=>transport.begin(source)})){}}
  if(mode==='allow')await run();else await assert.rejects(run())
  const wire=await readFile(log,'utf8'),rows=wire.trim().split('\n').map(JSON.parse)
  assert.equal(rows.filter(r=>r.method==='session/prompt').length,mode==='allow'?1:0);assert.equal(begins,1)
  assert.match(wire,/ROLE_ONLY_THIS_TEAM/);assert.doesNotMatch(wire,/FOREIGN_ROLE_CANARY/)
  await assert.rejects(transport.begin(source),/already attempted/)
 }finally{await s.close();await rm(dir,{recursive:true,force:true})}
})
