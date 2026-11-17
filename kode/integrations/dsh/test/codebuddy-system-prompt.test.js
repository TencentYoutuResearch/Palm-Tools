import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {AcpSession} from '../src/acp-session.js'
import {codebuddySystemPromptArgs} from '../src/codebuddy-system-prompt.js'
import {BUILDER_PLANNING_PROMPT} from '../src/builder-planning-prompt.js'
const fixture=fileURLToPath(new URL('./fixture-codebuddy-prompt.js',import.meta.url))
const role={version:1,home_hub:'home',team_id:'team',team_revision:1,role:{kind:'coordinator'},text:'ROLE_CANARY',sha256:createHash('sha256').update('ROLE_CANARY').digest('hex')}
test('preserves existing base and append, rejects ambiguous flags',()=>{
 assert.deepEqual(codebuddySystemPromptArgs(['--system-prompt','BASE','--append-system-prompt=USER'],'FIXED'),['--system-prompt','BASE','--append-system-prompt','USER\n\nFIXED'])
 assert.throws(()=>codebuddySystemPromptArgs(['--append-system-prompt','a','--append-system-prompt=b'],'FIXED'))
 assert.throws(()=>codebuddySystemPromptArgs(['--'],'FIXED'))
})
for(const restore of [false,true])test('CodeBuddy original argv append without ACP capability '+(restore?'restore':'fresh'),async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kode-cb-prompt-wire-')),argv=join(dir,'argv.json'),wire=join(dir,'wire.jsonl');let checks=0;const modes=[]
 const session=new AcpSession({type:'codebuddy',executable:process.execPath,args:[fixture,'--append-system-prompt','OWNER_CONFIG'],env:{KODE_CODEBUDDY_ARGV_LOG:argv,KODE_ACP_FIXTURE_LOG:wire}},dir,{nativePlanning:true,bindNativeSystemPrompt:async()=>{},resolveRolePrompt:async({mode})=>{modes.push(mode);return role},checkPlanningContext:async()=>{checks++}})
 try{
  await session.open(restore?{threadId:'fixture-session'}:{},[])
  for await(const e of session.turn([{type:'text',text:'original user goal'}],{model:'fixture-fast'})){}
  const args=JSON.parse(await readFile(argv,'utf8')),i=args.indexOf('--append-system-prompt'),text=args[i+1]
  assert.equal(args.filter(x=>x==='--append-system-prompt').length,1)
  assert.ok(text.startsWith('OWNER_CONFIG\n\n'));assert.ok(text.includes(BUILDER_PLANNING_PROMPT));assert.ok(text.includes('ROLE_CANARY'))
  assert.equal(text.split(BUILDER_PLANNING_PROMPT).length,2);assert.ok(args.includes('--acp'));assert.ok(checks>=2)
  assert.equal(modes[0],restore?'restore':'fresh')
  const rows=(await readFile(wire,'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(rows.filter(r=>['session/new','session/load'].includes(r.method)).every(r=>!r.params.systemPrompt))
  assert.deepEqual(rows.find(r=>r.method==='session/prompt').params.prompt,[{type:'text',text:'original user goal'}])
 }finally{await session.close();await rm(dir,{recursive:true,force:true})}
})
test('revoked planning context fails before CLI startup',async()=>{
 const session=new AcpSession({type:'codebuddy',executable:'/must-not-run'},tmpdir(),{nativePlanning:true,bindNativeSystemPrompt:async()=>{},checkPlanningContext:async()=>{throw Error('revoked')}})
 await assert.rejects(session.open({},[]),/revoked/);assert.equal(session.process,undefined)
})

test('custom agent targeting is rejected, ordinary argv stays untouched',()=>{
 assert.throws(()=>codebuddySystemPromptArgs(['--agent','custom'],'FIXED'),/default CodeBuddy agent/)
 assert.deepEqual(codebuddySystemPromptArgs(['--agent','custom'],''),['--agent','custom'])
})
test('changed role is rejected before spawn, not appended silently',async()=>{
 let reads=0
 const other={...role,text:'changed',sha256:createHash('sha256').update('changed').digest('hex')}
 const session=new AcpSession({type:'codebuddy',executable:'/must-not-run'},tmpdir(),{bindNativeSystemPrompt:async()=>{},resolveRolePrompt:async()=>++reads===1?role:other})
 await assert.rejects(session.open({},[]),/Role prompt changed/);assert.equal(session.process,undefined)
})
import {Session} from '@deepseek-ai/dsh-session'
import {createNativeSystemPromptBinder,NATIVE_SYSTEM_PROMPT_RECORD} from '../src/native-system-prompt-snapshot.js'
test('effective combination frozen in real Session, cold restore exact and no duplicate',async()=>{
 const session=Session.create('owned');let allowed=true
 const bind=createNativeSystemPromptBinder({session,canInitialize:()=>allowed,flush:async()=>true})
 const text='OWNER\n'+BUILDER_PLANNING_PROMPT+'\nROLE'
 await bind({text,mode:'fresh'});allowed=false
 const restored=Session.create('owned',JSON.parse(JSON.stringify(session.snapshotEvents())),session.header)
 const cold=createNativeSystemPromptBinder({session:restored,canInitialize:()=>false,flush:async()=>true})
 await cold({text,mode:'restore'})
 assert.equal(restored.snapshotEvents().filter(e=>e.type===NATIVE_SYSTEM_PROMPT_RECORD).length,1)
 await assert.rejects(cold({text:text+' changed builtin',mode:'restore'}),/changed/)
 await assert.rejects(createNativeSystemPromptBinder({session:Session.create('old'),canInitialize:()=>false,flush:async()=>true})({text,mode:'restore'}),/lacks/)
 await assert.rejects(createNativeSystemPromptBinder({session:Session.create('failed'),canInitialize:()=>true,flush:async()=>false})({text,mode:'fresh'}),/durable/)
})
test('required option values retain flag-looking literal text and cannot become agent/append flags',()=>{
 for(const value of ['--append-system-prompt=literal base text','--agent=literal base text','--agents','--','--append-system-prompt']){
  const args=['--system-prompt',value]
  assert.deepEqual(codebuddySystemPromptArgs(args,'TRUSTED'),[...args,'--append-system-prompt','TRUSTED'])
 }
 assert.deepEqual(codebuddySystemPromptArgs(['--settings','--agent=x','--system-prompt-file','--append-system-prompt=y'],'T'),['--settings','--agent=x','--system-prompt-file','--append-system-prompt=y','--append-system-prompt','T'])
 assert.deepEqual(codebuddySystemPromptArgs(['--append-system-prompt','--agent=literal'],'T'),['--append-system-prompt','--agent=literal\n\nT'])
 assert.deepEqual(codebuddySystemPromptArgs(['--system-prompt=--append-system-prompt=literal'],'T'),['--system-prompt=--append-system-prompt=literal','--append-system-prompt','T'])
})
test('actual targeting and duplicates remain blocked; optional arguments do not swallow flags',()=>{
 for(const args of [['--system-prompt','--agent=literal','--agent','real'],['--debug','--agent=real'],['--resume','--agents={}'],['--multitask']])assert.throws(()=>codebuddySystemPromptArgs(args,'T'),/default CodeBuddy agent/)
 assert.throws(()=>codebuddySystemPromptArgs(['--system-prompt','--append-system-prompt=literal','--append-system-prompt=a','--append-system-prompt=b'],'T'),/duplicate/)
 assert.throws(()=>codebuddySystemPromptArgs(['--future-option','--agent=ambiguous'],'T'),/Unsupported/)
 assert.throws(()=>codebuddySystemPromptArgs(['--system-prompt'],'T'),/Missing/)
})
