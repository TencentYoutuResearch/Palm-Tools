import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Session} from '@deepseek-ai/dsh-session'
import {AcpSession} from '../src/acp-session.js'
import {CodexSession} from '../src/codex-session.js'
import {snapshotTeamRolePrompt} from '../src/team-role-prompts.js'
import {createNativeRolePromptResolver} from '../src/native-role-prompt.js'
const snapshot=()=>snapshotTeamRolePrompt({home_hub:'home',team_id:'team',team_revision:1,spec:{coordinator_prompt:'ONLY_ROLE_A',workers:[{id:'b',role_prompt:'FOREIGN_ROLE_B'}]}})
test('legacy null restore is read-only and rejects null-to-text between authority reads',async()=>{
 for(const mode of ['restore','check']){
  const session=Session.create('legacy'),before=session.snapshotEvents();let reads=0
  const resolve=createNativeRolePromptResolver({session,resolve:async()=>{reads++;return null},flush:async()=>{throw Error('must not write')},validateIdentity:async value=>assert.equal(value,null)})
  assert.equal(await resolve({mode}),null);assert.equal(reads,2);assert.deepEqual(session.snapshotEvents(),before)
 }
 const session=Session.create('legacy-race');let reads=0
 const resolve=createNativeRolePromptResolver({session,resolve:async()=>++reads===1?null:snapshot(),flush:async()=>{throw Error('must not write')},validateIdentity:async()=>{}})
 await assert.rejects(resolve({mode:'restore'}),/changed/)
 assert.equal(session.snapshotEvents().length,0)
})
test('durable real Session snapshot rejects changes and missing cold restore',async()=>{
 const session=Session.create('owned');let value=snapshot(),flushes=0
 const make=()=>createNativeRolePromptResolver({session,resolve:async()=>value,flush:async()=>{flushes++;return true},validateIdentity:async v=>{assert.equal(v.team_id,'team')}})
 await make()({mode:'fresh'});await make()({mode:'restore'});assert.equal(flushes,2)
 value={...value,team_revision:2};await assert.rejects(make()({mode:'check'}),/changed/)
 await assert.rejects(createNativeRolePromptResolver({session:Session.create('other'),resolve:async()=>snapshot(),flush:async()=>true,validateIdentity:async()=>{}})({mode:'restore'}),/Missing/)
})
for(const type of ['cursor','codex'])test(`${type} native append survives cold restore and refuses revision drift`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kode-role-wire-')),log=join(dir,'wire.jsonl'),sessions=[];let value=snapshot()
 const resolver=createNativeRolePromptResolver({session:Session.create('owned'),resolve:async()=>value,flush:async()=>true,validateIdentity:async v=>{assert.equal(v.team_id,'team')}})
 const make=()=>{
  const profile={type,executable:process.execPath,args:[fileURLToPath(new URL(type==='codex'?'./fixture-codex-server.js':'./fixture-acp-server.js',import.meta.url))],env:{KODE_ACP_ROLE_PROMPT:'1',KODE_ACP_FIXTURE_LOG:log,KODE_FIXTURE_RPC_LOG:log}}
  const s=new (type==='codex'?CodexSession:AcpSession)(profile,dir,{resolveRolePrompt:resolver,policy:()=>({mode:'read-only'})});sessions.push(s);return s
 }
 try{
  const a=make();await a.open({},[]);const id=a.threadId;await a.close()
  const b=make();await b.open({threadId:id},[])
  const wire=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)
  const opens=wire.filter(r=>['session/new','session/load','thread/start','thread/resume'].includes(r.method));assert.equal(opens.length,2)
  for(const row of opens){const text=type==='codex'?row.params.developerInstructions:row.params.systemPrompt.content[0].text;assert.match(text,/ONLY_ROLE_A/);assert.doesNotMatch(text,/FOREIGN_ROLE_B/);if(type==='codex')assert.match(text,/This conversation is presented in Kode/);else assert.equal(row.params.systemPrompt.mode,'append')}
  value={...value,team_revision:2}
  await assert.rejects(async()=>{for await(const e of b.turn([{type:'text',text:'do not send'}],{model:type==='codex'?'fixture-model':'fixture-fast'})){}},/changed/)
  assert.doesNotMatch(await readFile(log,'utf8'),/"method":"(?:session\/prompt|turn\/start)"/)
 }finally{await Promise.all(sessions.map(s=>s.close()));await rm(dir,{recursive:true,force:true})}
})
test('ACP refuses unadvertised role append before creating session',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kode-role-deny-')),log=join(dir,'wire.jsonl')
 const s=new AcpSession({type:'cursor',executable:process.execPath,args:[fileURLToPath(new URL('./fixture-acp-server.js',import.meta.url))],env:{KODE_ACP_FIXTURE_LOG:log}},dir,{resolveRolePrompt:async()=>snapshot()})
 try{await assert.rejects(s.open({},[]),/does not advertise/);assert.doesNotMatch(await readFile(log,'utf8'),/session\/new/)}finally{await s.close();await rm(dir,{recursive:true,force:true})}
})
test('real Claude SDK append retains native preset instead of replacing system prompt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kode-role-claude-')),log=join(dir,'wire.jsonl')
 const s=new AcpSession({type:'claude',executable:process.execPath,args:[fileURLToPath(new URL('./fixture-claude-stream-json.js',import.meta.url))],env:{KODE_CLAUDE_FIXTURE_LOG:log,CLAUDE_CONFIG_DIR:dir}},dir,{resolveRolePrompt:async()=>snapshot(),policy:()=>({mode:'read-only'})})
 try{await s.open({},[]);const records=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse),args=records.find(r=>r.type==='fixture-argv').args
  const initialization=records.find(r=>r.request?.subtype==='initialize').request
  assert.match(initialization.appendSystemPrompt,/ONLY_ROLE_A/)
  assert.equal(initialization.systemPrompt,undefined)
  assert.ok(!args.includes('--system-prompt'));assert.doesNotMatch(JSON.stringify(records),/FOREIGN_ROLE_B/)
 }finally{await s.close();await rm(dir,{recursive:true,force:true})}
})
