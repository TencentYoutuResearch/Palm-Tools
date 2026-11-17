import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, readFile, writeFile, readdir, rm, symlink, link, chmod, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { validPatchRequest, patchAssignmentSource, executeAssignmentPatchTool } from '../src/assignment-patch-tool.js'
import { writeAssignmentSource } from '../src/assignment-write-tool.js'
import { installAssignmentTools } from '../src/assignment-tools.js'
import { OfficialToolPolicies } from '../src/official-grant-guard.js'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const request = (text, replacements, path='source.txt') => ({path,expected_sha256:hash(text),replacements})
const replace = (old_text,new_text) => ({old_text,new_text})
async function scope(t,text='old source') {
 const root=await realpath(await mkdtemp(join(tmpdir(),'kode-patch-')));t.after(()=>rm(root,{recursive:true,force:true}))
 await writeFile(join(root,'source.txt'),text);return {root,path:join(root,'source.txt'),patch:(args,signal,authorize=async()=>{})=>patchAssignmentSource(root,args,signal,authorize)}
}
test('small literal batch preserves all untouched bytes in a large UTF-8 source, including BOM and file mode',async t=>{
 const middle='中间😀\r\n'.repeat(14000),text='\uFEFFbefore-marker\n'+middle+'after-marker\n',f=await scope(t,text)
 await chmod(f.path,0o640)
 const result=await f.patch(request(text,[replace('before-marker','first $& [literal]'),replace('after-marker','last $1')]))
 const desired=Buffer.from('\uFEFFfirst $& [literal]\n'+middle+'last $1\n')
 assert.deepEqual(await readFile(f.path),desired);assert.equal(result.sha256,hash(desired));assert.equal(result.previous_sha256,hash(text));assert.equal(result.state,'written')
 assert.equal((await stat(f.path)).mode&0o777,0o640);assert.deepEqual(await readdir(f.root),['source.txt'])
})
test('hash mismatch, missing text, overlapping ambiguity and incomplete batches never write',async t=>{
 const text='alpha beta gamma aaab',f=await scope(t,text)
 for(const args of [
  {...request(text,[replace('alpha','changed')]),expected_sha256:'0'.repeat(64)},
  request(text,[replace('alpha','changed'),replace('missing','changed')]),
  request(text,[replace('aa','xx')]),
  request(text,[replace('absent','anything')]),
 ]){await assert.rejects(f.patch(args),/conflict|not found|ambiguous/);assert.equal(await readFile(f.path,'utf8'),text);assert.deepEqual(await readdir(f.root),['source.txt'])}
 await assert.rejects(f.patch(request(text,[replace('alpha','changed')],'missing.txt')),{code:'ENOENT'})
})
test('patch validation requires exact hash, unique nonempty UTF-8 fragments and bounded complete requests',()=>{
 const base=request('old',[replace('old','new')]);assert.equal(validPatchRequest(base),true)
 for(const change of [{expected_sha256:null},{expected_sha256:'a'.repeat(63)},{path:'../escape'},{path:'.git/config'},
  {replacements:[]},{replacements:Array.from({length:17},(_,i)=>replace(String(i),'x'))},
  {replacements:[replace('','x')]},{replacements:[replace('old','x'),replace('old','y')]},
  {replacements:[replace('\ud800','x')]},{replacements:[replace('old','\udfff')]},{replacements:[replace('old','\0')]},
  {replacements:[replace('old','界'.repeat(5462))]},{replacements:[replace('x'.repeat(16385),'')]},
  {replacements:Array.from({length:8},(_,i)=>replace(String(i)+'x'.repeat(5000),'y'.repeat(5000)))},
  {unexpected:true}])assert.equal(validPatchRequest({...base,...change}),false)
 assert.equal(validPatchRequest({...base,replacements:[{old_text:'old',new_text:'new',regex:true}]}),false)
})
test('bounded source read and final output size caps are unchanged',async t=>{
 const text='x'.repeat(256*1024-6)+'needle',f=await scope(t,text)
 await assert.rejects(f.patch(request(text,[replace('needle','y'.repeat(100))])),/output exceeds/);assert.equal((await readFile(f.path)).length,256*1024)
 await writeFile(f.path,text+'x');await assert.rejects(f.patch(request(text+'x',[replace('needle','y')])),/bounded/)
})
test('symlink and hardlink targets retain existing source protection',async t=>{
 const text='old source',f=await scope(t,text)
 await symlink('source.txt',join(f.root,'alias'));await assert.rejects(f.patch(request(text,[replace('old','new')],'alias')),/symlink/)
 await link(f.path,join(f.root,'hardlink'));await assert.rejects(f.patch(request(text,[replace('old','new')])),/hardlinks/)
 assert.equal(await readFile(f.path,'utf8'),text)
})
test('pre-abort and abort just before atomic replacement leave original bytes and no temporary files',async t=>{
 const text='old source',f=await scope(t,text),args=request(text,[replace('old','new')]),abort=new AbortController()
 abort.abort(Error('cancelled before patch'));await assert.rejects(f.patch(args,abort.signal),/cancelled before/)
 const during=new AbortController();await assert.rejects(f.patch(args,during.signal,async()=>{if((await readdir(f.root)).some(name=>name.startsWith('.kode-write-')))during.abort(Error('cancelled before replace'))}),/cancelled before replace/)
 assert.equal(await readFile(f.path,'utf8'),text);assert.deepEqual(await readdir(f.root),['source.txt'])
})
test('concurrent original write wins CAS without being overwritten by the calculated patch',async t=>{
 const text='old source',f=await scope(t,text);let edited=false
 await assert.rejects(f.patch(request(text,[replace('old','patched')]),undefined,async()=>{
  if(!edited&&(await readdir(f.root)).some(name=>name.startsWith('.kode-write-'))){edited=true;await writeAssignmentSource(f.root,{path:'source.txt',expected_sha256:hash(text),content:'concurrent original write'},undefined,async()=>{})}
 }),/conflict/)
 assert.equal(edited,true);assert.equal(await readFile(f.path,'utf8'),'concurrent original write');assert.deepEqual(await readdir(f.root),['source.txt'])
})
test('authorization revocation and mutable caller arguments cannot alter a validated batch',async t=>{
 const text='old source',f=await scope(t,text),args=request(text,[replace('old','new')])
 await assert.rejects(f.patch(args,undefined,async()=>{throw Error('revoked')}),/revoked/);assert.equal(await readFile(f.path,'utf8'),text)
 await f.patch(args,undefined,async()=>{args.replacements[0].new_text='caller mutation';args.path='../outside'})
 assert.equal(await readFile(f.path,'utf8'),'new source')
})
test('managed patch rejects foreign Assignment and frozen read-only workflow before any write',async t=>{
 const text='old source',f=await scope(t,text),operation={id:'op',attempt:1,epoch:1}
 const assignment={id:'assignment',run_id:'run',stage_id:'implement',stage_attempt:1,state:'prepared',worker:{session_id:'worker',node_id:'home'},dispatch:{command:{operation,cwd:f.root}},context_hash:'context',authorization_hash:'authority'}
 const run={
  stages:[{stage_id:'implement',assignment_id:'assignment',attempt:1}],context_hash:'context',authorization:{snapshot_hash:'authority'},
  context:{binding:{
   workflow:{pack:{stages:[{id:'implement',execution:{capabilities:['read'],repository_binding:'code'}}]}},
   project:{config:{spec:{repositories:{code:{}}}}},
  }},
 }
 const runtime={host:'home',client:{call:async path=>path.includes('work-assignments')?assignment:run}},binding={managedAssignment:{id:'assignment'},managedOperation:operation}
 await assert.rejects(executeAssignmentPatchTool(runtime,{id:'foreign'},binding,{root:f.root},request(text,[replace('old','new')]),undefined,async()=>{}),/ownership mismatch/)
 await assert.rejects(executeAssignmentPatchTool(runtime,{id:'worker'},binding,{root:f.root},request(text,[replace('old','new')]),undefined,async()=>{}),/frozen workspace scope/)
 run.context.binding.workflow.pack.stages[0].execution.capabilities.push('workspace_write')
 await assert.rejects(executeAssignmentPatchTool(runtime,{id:'worker'},binding,{root:f.root},request(text,[replace('old','new')]),undefined,async()=>{}),/task worktree ownership unavailable/)
 assert.equal(await readFile(f.path,'utf8'),text)
})
test('registration gives no patch permission to old allow lists and declares existing write capability only',()=>{
 const entries=new Map(),policies=new OfficialToolPolicies(),agent={},tools={register:definition=>{entries.set(definition.name,definition);return()=>entries.delete(definition.name)},get:name=>entries.get(name)},ctx={get:name=>name==='tools'?{forScope:()=>tools}:policies}
 const old=installAssignmentTools(ctx,agent,{},['kode_write_source']);assert.equal(entries.has('kode_patch_source'),false);old()
 const dispose=installAssignmentTools(ctx,agent,{},['kode_patch_source']);assert.deepEqual([...entries.keys()],['kode_patch_source'])
 const policy=policies.get('kode_patch_source',agent);assert.deepEqual(policy.capabilities,['read','workspace_write']);assert.equal(policy.network,false)
 assert.equal(policy.authorize({agent,arguments:request('old',[replace('old','new')])}),true)
 assert.equal(policy.authorize({agent:{},arguments:request('old',[replace('old','new')])}),false);dispose()
})
