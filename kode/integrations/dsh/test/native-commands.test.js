import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { AcpSession } from '../src/acp-session.js'
import { CodexSession } from '../src/codex-session.js'
import { nativeToolDescriptor, acpToolItem } from '../src/native-tools.js'
import { resolveAdvertisedModel } from '../src/model-alias.js'
import { commandDescriptors, humanInput, modeAllowed } from '../src/native-commands.js'
const collect = async stream => { const events=[]; for await(const event of stream)events.push(event); return events }
test('ACP Terminal operations expose real commands, late inputs, read paths and file diffs',()=>{
  const running=acpToolItem({id:'tool',type:'commandExecution'},{kind:'execute',title:'Terminal',rawInput:{command:'git status --short',cwd:'/srv/project'},status:'in_progress'})
  assert.deepEqual(nativeToolDescriptor(running),{name:'exec_command',args:{cmd:'git status --short',cwd:'/srv/project'}})
  const completed=acpToolItem(running,{status:'completed',rawOutput:{stdout:' M app.ts'}})
  assert.equal(completed.input.command,'git status --short');assert.match(completed.aggregatedOutput,/ M app.ts/)
  assert.equal(nativeToolDescriptor(acpToolItem({id:'read'},{kind:'read',title:'Read',rawInput:{file_path:'/srv/project/app.ts'}})).args.path,'/srv/project/app.ts')
  const edited=acpToolItem({id:'edit'},{kind:'edit',content:[{type:'diff',path:'/srv/project/app.ts',oldText:'before',newText:'after'}]})
  assert.equal(nativeToolDescriptor(edited).name,'apply_patch');assert.match(nativeToolDescriptor(edited).args.patch,/before\nafter/)
})
test('model aliases resolve only exact identities or unique advertised names',()=>{
  const models=[{id:'deepseek-v4.1-flash',name:'DeepSeek-V4.1-Flash'},{id:'another-model',name:'Other'}]
  assert.equal(resolveAdvertisedModel(models,'DeepSeek-V4.1-Flash'),'deepseek-v4.1-flash')
  assert.equal(resolveAdvertisedModel(models,' DEEPSEEK-V4.1-FLASH '),'deepseek-v4.1-flash')
  assert.throws(()=>resolveAdvertisedModel(models,'gpt-unsupported'),/未公布/)
  assert.throws(()=>resolveAdvertisedModel([{id:'a',name:'same'},{id:'b',name:'same'}],'same'),/多个/)
})
test('native command discovery includes namespaced skills and excludes CLI identity/window commands',()=>{
  const descriptors=commandDescriptors({commands:[{name:'team:review',description:'Project skill'},{name:'clear'},{name:'login'},{name:'context',description:'Native context'}]})
  assert.equal(descriptors.find(row=>row.name==='team-review').nativeName,'team:review')
  assert.ok(descriptors.some(row=>row.name==='context'));assert.ok(!descriptors.some(row=>row.name==='clear'||row.name==='login'))
  assert.equal(humanInput({source:{kind:'agent-message'},content:[{type:'text',text:'!rm anything'}]}),undefined)
  assert.equal(humanInput({source:{kind:'user'},content:[{type:'text',text:'!pwd'}]}),'!pwd')
  assert.equal(modeAllowed('bypassPermissions','workspace-write'),false);assert.equal(modeAllowed('acceptEdits','read-only'),false);assert.equal(modeAllowed('plan','read-only'),true)
})
for(const late of [false,true])test(`ACP discovers commands ${late?'after':'before'} setup and dispatches the original skill spelling`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'kode-acp-commands-')),log=join(root,'wire.jsonl')
  const session=new AcpSession({type:'custom',executable:process.execPath,args:[fileURLToPath(new URL('./fixture-acp-server.js',import.meta.url))],env:{KODE_ACP_FIXTURE_LOG:log,...(late?{KODE_ACP_LATE_COMMANDS:'1'}:{})}},root)
  try{
    await session.listModels(AbortSignal.timeout(5000))
    assert.ok(session.commands.some(row=>row.name==='fixture:skill'))
    const events=await collect(session.turn([{type:'text',text:'/fixture:skill review this'}],{model:'Large fixture',command:{name:'fixture:skill',input:'review this'}}))
    assert.match(events.find(event=>event.method==='item/agentMessage/delta').params.delta,/\/fixture:skill review this/)
    const rows=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(rows.some(row=>row.method==='session/set_config_option'&&row.params.value==='fixture-large'))
  }finally{await session.close();await rm(root,{recursive:true,force:true})}
})
test('Codex commands use native RPCs and $skills become typed inputs with discovered workspace paths',async()=>{
  const root=await mkdtemp(join(tmpdir(),'kode-codex-commands-')),log=join(root,'wire.jsonl')
  const session=new CodexSession({executable:process.execPath,args:[fileURLToPath(new URL('./fixture-codex-server.js',import.meta.url))],env:{KODE_FIXTURE_RPC_LOG:log}},root,{policy:()=>({mode:'read-only'})})
  try{
    await session.open({},[],AbortSignal.timeout(5000))
    for(const name of ['compact','review','mcp','skills']){
      const events=await collect(session.turn([{type:'text',text:`/${name}`}],{signal:AbortSignal.timeout(5000),command:{name,input:''}}))
      assert.ok(events.some(event=>event.method==='turn/completed'))
    }
    await collect(session.turn([{type:'text',text:'Use $fixture-skill to review'}],{skillNames:['fixture-skill'],signal:AbortSignal.timeout(5000)}))
    const rows=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows.filter(row=>row.method==='turn/start').length,1,'native control commands must not be ordinary model prompts')
    assert.ok(rows.some(row=>row.method==='thread/compact/start'));assert.ok(rows.some(row=>row.method==='review/start'&&row.params.delivery==='inline'))
    assert.deepEqual(rows.find(row=>row.method==='turn/start').params.input.at(-1),{type:'skill',name:'fixture-skill',path:join(root,'.agents/skills/fixture-skill/SKILL.md')})
  }finally{await session.close();await rm(root,{recursive:true,force:true})}
})
