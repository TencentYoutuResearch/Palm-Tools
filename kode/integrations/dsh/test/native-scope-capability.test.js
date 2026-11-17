import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {CodexSession} from '../src/codex-session.js'
import {nativeScopeCapability} from '../src/native-scope-capability.js'
test('profile and grant self-assertions never upgrade native capability',()=>{
 for(const type of ['codex','claude','cursor','custom']){
  const proof=nativeScopeCapability({profile:{type,grant_enforcement:true,selection_verified:true,scopeReady:true},selection:{model:'fixture'},grant:{supported:true,read_scope_verified:true}})
  assert.equal(proof.supported,false);assert.equal(proof.tool_scope_verified,false)
 }
})
test('original Codex settings ACK gives no effective selection/read-scope proof and no inference',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kode-codex-capability-')),log=join(dir,'wire.jsonl')
 const s=new CodexSession({executable:process.execPath,args:[fileURLToPath(new URL('./fixture-codex-server.js',import.meta.url))],env:{KODE_FIXTURE_RPC_LOG:log}},dir,{policy:()=>({mode:'read-only'})})
 try{await s.open({},[]);const result=await s.inspectScopeCapability({model:'fixture-model',effort:'high'})
  assert.equal(result.configuration_acknowledged,true);assert.equal(result.selection_verified,false);assert.equal(result.dispatch_allowed,false)
  const rows=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse),settings=rows.find(r=>r.method==='thread/settings/update')
  assert.equal(settings.params.model,'fixture-model');assert.equal(settings.params.effort,'high');assert.deepEqual(settings.params.sandboxPolicy,{type:'readOnly'})
  assert.equal(rows.filter(r=>r.method==='turn/start').length,0)
 }finally{await s.close();await rm(dir,{recursive:true,force:true})}
})
