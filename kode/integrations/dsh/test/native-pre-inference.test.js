import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {AcpSession} from '../src/acp-session.js'
import {CodexSession} from '../src/codex-session.js'
const collect=async stream=>{for await(const e of stream){}}
for(const [mode,type] of [...['allow','deny','revoke','replay','wrong-model'].map(mode=>[mode,'cursor']),['allow','claude'],['deny','claude']])test(`ACP original ${type} protocol pre-inference ${mode}`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kode-prehook-')),log=join(dir,'wire.jsonl'),controller=new AbortController()
  const model=type==='claude'?'fixture-claude':'fixture-fast'
  const s=new AcpSession({type,executable:process.execPath,args:[fileURLToPath(new URL(type==='claude'?'./fixture-claude-stream-json.js':'./fixture-acp-server.js',import.meta.url))],env:{KODE_ACP_FIXTURE_LOG:log,KODE_CLAUDE_FIXTURE_LOG:log,CLAUDE_CONFIG_DIR:dir}},dir,{policy:()=>({mode:'read-only'})})
  try{
    await s.open({},[])
    let called=0
    const beforeInference=async proof=>{
      called++;assert.equal(proof.threadId,s.threadId);assert.equal(proof.selection.model.observed,model)
      const wire=await readFile(log,'utf8');assert.doesNotMatch(wire,/"method":"session\/prompt"/)
      assert.match(wire,type==='claude'?/control_request/:/session\/set_config_option/)
      if(type==='claude')assert.doesNotMatch(wire,/"type":"user"/)
      assert.deepEqual(proof.input,[{type:'text',text:'SCOPE_A_ONLY'}])
      proof.input[0].text='FOREIGN_MUTATION'
      if(mode==='deny')throw Error('server denies source')
      if(mode==='revoke')controller.abort(Error('revoked'))
      return {admission_id:'owned-admission',new_admission:mode!=='replay',dispatch_allowed:true,state:'admitted'}
    }
    const task=collect(s.turn([{type:'text',text:'SCOPE_A_ONLY'}],{model:mode==='wrong-model'?'unknown-model':model,signal:controller.signal,beforeInference}))
    if(mode==='allow')await task;else await assert.rejects(task)
    assert.equal(called,mode==='wrong-model'?0:1)
    const wire=await readFile(log,'utf8'),prompts=wire.trim().split('\n').map(JSON.parse).filter(e=>type==='claude'?e.type==='user':e.method==='session/prompt')
    assert.equal(prompts.length,mode==='allow'?1:0)
    if(prompts.length){assert.match(JSON.stringify(prompts),/SCOPE_A_ONLY/);assert.doesNotMatch(JSON.stringify(prompts),/FOREIGN_MUTATION/)}
  }finally{await s.close();await rm(dir,{recursive:true,force:true})}
})
test('Codex guarded path refuses unconfirmed pre-turn selection before turn/start',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kode-codex-prehook-')),log=join(dir,'wire.jsonl')
  const s=new CodexSession({executable:process.execPath,args:[fileURLToPath(new URL('./fixture-codex-server.js',import.meta.url))],env:{KODE_FIXTURE_RPC_LOG:log}},dir)
  try{await s.open({},[]);await assert.rejects(collect(s.turn([{type:'text',text:'OWNED'}],{model:'fixture-model',beforeInference:()=>{throw Error('must not call')}})),{code:'selection_confirmation_unsupported'})
    assert.doesNotMatch(await readFile(log,'utf8'),/"method":"turn\/start"/)
  }finally{await s.close();await rm(dir,{recursive:true,force:true})}
})
