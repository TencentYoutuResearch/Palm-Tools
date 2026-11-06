import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm,readdir,writeFile,symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VerificationRunners } from '../src/verification-runners.js'
import { registerVerificationDefinition } from '../src/verification-definition-route.js'
const definition=()=>({runner_id:'local',command_id:'check',revision:'1',executable:'/fixture/bin/check',executable_hash:'a'.repeat(64),args:['--check'],env:{FIXTURE:'value'},timeout_ms:1000,max_output_bytes:1024,scenario_ids:['smoke'],capabilities:['read'],network:false,tool_id:'kode_verify_output'})
test('owner immutable command registration survives reconstruction without executing or exposing definition data',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kode-verification-definitions-'));t.after(()=>rm(root,{recursive:true,force:true}))
 let runners=new VerificationRunners(root),runtime={host:'home',verificationRunners:runners},kind='agent',status,value
 const routes=new Map();registerVerificationDefinition({get:()=>({officialExecution:runtime}),webServer:{register:r=>{routes.set(r.path,r);return()=>{}}},connection:{admit:()=>({peer:{principal:{kind}}})}})
 const send=async(method,body,url='/api/kode/verification/definitions')=>routes.get('/api/kode/verification/definitions').handler({method,url,headers:{'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify(body)}},{writeHead:s=>{status=s},end:b=>{value=JSON.parse(b)}})
 const input={definition:definition()}
 await send('POST',input);assert.equal(status,403)
 kind='owner';await send('POST',input);assert.equal(status,200);assert.equal(value.execution_performed,false)
 const original=value;assert.equal(original.reference.id,'check');assert.equal(original.reference.environment_hash.length,64)
 assert.doesNotMatch(JSON.stringify(value),/FIXTURE|\/fixture\/bin|--check/)
 assert.equal(runners.pending.size,0)
 await runners.close()
 runners=await new VerificationRunners(root).open();runtime={host:'home',verificationRunners:runners}
 await send('GET',undefined,'/api/kode/verification/definitions?runner_id=local&command_id=check&revision=1')
 assert.equal(status,200);assert.deepEqual(value,original)
 await send('POST',input);assert.equal(status,200);assert.deepEqual(value,original)
 await send('POST',{definition:{...input.definition,args:['different']}});assert.equal(status,409)
 assert.deepEqual(runners.reference('local','check','1'),original.reference)
 assert.equal((await readdir(join(root,'definitions'))).filter(n=>n.endsWith('.json')).length,1)
 await runners.close()
})
test('competing registries cannot replace an immutable definition and corrupt persisted metadata fails closed',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kode-verification-race-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const first=await new VerificationRunners(root).open(),second=await new VerificationRunners(root).open()
 const outcomes=await Promise.allSettled([first.registerPersistent(definition()),second.registerPersistent({...definition(),args:['other']})])
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected').length,1)
 const reopened=await new VerificationRunners(root).open()
 assert.deepEqual(reopened.reference('local','check','1'),outcomes.find(r=>r.status==='fulfilled').value)
 await Promise.all([first.close(),second.close(),reopened.close()])
 const [name]=(await readdir(join(root,'definitions'))).filter(n=>n.endsWith('.json'))
 await writeFile(join(root,'definitions',name),'{}')
 await assert.rejects(new VerificationRunners(root).open(),/Invalid stored/)
 await rm(join(root,'definitions',name));await symlink(join(root,'absent'),join(root,'definitions',name))
 await assert.rejects(new VerificationRunners(root).open())
})
