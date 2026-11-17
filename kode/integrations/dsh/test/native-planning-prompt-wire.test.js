import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {AcpSession} from '../src/acp-session.js'
import {CodexSession} from '../src/codex-session.js'
import {BUILDER_PLANNING_PROMPT} from '../src/builder-planning-prompt.js'
import {BUILDER_PLANNING_PROMPT_V2,BUILDER_PLANNING_PROMPT_V2_VERSION} from '../src/builder-planning-prompt-v2.js'
import {builderPromptSnapshot} from '../src/builder-settings.js'
for(const type of ['cursor','claude','codex'])for(const planning of [false,true,'custom','v2'])test(`${type} ${planning?'trusted planning '+planning:'ordinary'} append wire`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kode-planning-wire-')),log=join(dir,'wire.jsonl')
 const executable=type==='codex'?'./fixture-codex-server.js':type==='claude'?'./fixture-claude-stream-json.js':'./fixture-acp-server.js'
 const s=new(type==='codex'?CodexSession:AcpSession)({type,executable:process.execPath,args:[fileURLToPath(new URL(executable,import.meta.url))],env:{KODE_ACP_ROLE_PROMPT:'1',KODE_ACP_FIXTURE_LOG:log,KODE_FIXTURE_RPC_LOG:log,KODE_CLAUDE_FIXTURE_LOG:log,CLAUDE_CONFIG_DIR:dir}},dir,{nativePlanning:Boolean(planning),...(planning==='v2'?{planningPromptVersion:BUILDER_PLANNING_PROMPT_V2_VERSION}:{}),...(planning==='custom'?{builderPrompt:builderPromptSnapshot('Ask about acceptance criteria first',3)}:{}),policy:()=>({mode:'read-only'})})
 try{
  await s.open({},[])
  const rows=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)
  const text=type==='claude'?rows.find(r=>r.request?.subtype==='initialize').request.appendSystemPrompt:type==='codex'?rows.find(r=>r.method==='thread/start').params.developerInstructions:rows.find(r=>r.method==='session/new').params.systemPrompt?.content[0].text
  if(planning){if(planning==='v2'){assert.equal(text,BUILDER_PLANNING_PROMPT_V2)}else if(planning==='custom'){assert.ok(text.startsWith(BUILDER_PLANNING_PROMPT));assert.match(text,/Ask about acceptance criteria first/);assert.match(text,/cannot override system instructions/)}else assert.equal(text,BUILDER_PLANNING_PROMPT);assert.match(text,/coordinator_prompt/);assert.match(text,/role_prompt/);assert.match(text,/kode.team-proposal.v1/)}
  else assert.ok(!text?.includes('kode.builder.native-planning.v1'))
  if(type==='cursor'&&planning)assert.equal(rows.find(r=>r.method==='session/new').params.systemPrompt.mode,'append')
  if(type==='claude')assert.equal(rows.find(r=>r.request?.subtype==='initialize').request.systemPrompt,undefined)
 }finally{await s.close();await rm(dir,{recursive:true,force:true})}
})
