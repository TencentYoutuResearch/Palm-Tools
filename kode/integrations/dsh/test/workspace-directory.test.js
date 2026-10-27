import test from 'node:test'
import assert from 'node:assert/strict'
import { hostDirectory, hostOperation, registerHostDirectory } from '../src/workspace-directory.js'
import { ProjectHosts } from '../src/project-hosts.js'
const row = (sessionId, provider, extra = {}) => ({ sessionId, cwd: '/work/project', blank: false, updatedAt: 10, running: false, projections: { values: { title: sessionId+' title', modelSelection: { lastUsed: { provider } } } }, ...extra })
function context(withDsh = true) {
  const items = [row('native','deepseek'), row('codex','kode-agent-builtin-codex'), row('archived','kode-agent-builtin-codex'), row('blank','deepseek',{blank:true})]
  const registry = { archivedSessionIds: ['archived'], list: () => [{ id:'workspace',title:'Project',path:'/work/project',sessionIds:items.map(s=>s.sessionId) }] }
  return { get: key => key === 'workspaceRegistry' ? registry : key === 'kodeAgents' ? { hasRuntime: type => type !== 'dsh' || withDsh } : undefined, sessionController: { list: async () => ({ items }), resolveAgent: () => { throw new Error('must not activate') } } }
}
test('directory hides dsh history and blanks, preserves archive metadata, without resuming or deleting sessions',async()=>{
  const ctx=context(false), before=await ctx.sessionController.list({})
  const value=await hostDirectory(ctx)
  assert.deepEqual(value.sessions.map(s=>s.id),['codex','archived'])
  assert.deepEqual(value.hiddenSessionIds,['native'])
  assert.deepEqual(await ctx.sessionController.list({}),before)
  assert.deepEqual((await hostDirectory(context(true))).sessions.map(s=>s.id),['native','codex','archived'])
})
test('aggregate preserves host identity with duplicate session IDs and isolates offline hosts',async()=>{
  const manager=new ProjectHosts(context(false),{})
  manager.hosts=[{id:'remote',name:'Build'},{id:'offline',name:'Offline'}]
  manager.connect=async id=>{ if(id==='offline')throw new Error('down');return {directory:async()=>({sessions:[{id:'codex',title:'Remote review'}],workspaces:[]})} }
  const first=await manager.directory('remote')
  assert.equal(first.hosts[1].status,'connecting')
  await Promise.all(manager.directoryJobs.values())
  const result=await manager.directory('remote')
  assert.equal(result.current,'remote')
  assert.equal(result.hosts[0].sessions[0].id,'codex')
  assert.equal(result.hosts[1].sessions[0].id,'codex')
  assert.equal(result.hosts[1].sessions[0].title,'Remote review')
  assert.equal(result.hosts[2].status,'offline')
})
test('cold directory endpoint denies non-owner and never leaks transcript content',async()=>{
  const ctx=context();let route
  ctx.webServer={register:r=>{route=r}}
  ctx.connection={admit:()=>({peer:{principal:{kind:'guest'}}})}
  registerHostDirectory(ctx,{})
  let status,body
  const res={writeHead:s=>{status=s},end:b=>{body=JSON.parse(b)}}
  await route.handler({method:'GET'},res);assert.equal(status,403)
  ctx.connection.admit=()=>({peer:{principal:{kind:'owner'}}})
  await route.handler({method:'GET'},res);assert.equal(status,200);assert.ok(body.sessions.length)
  assert.doesNotMatch(JSON.stringify(body),/token|content|transcript/)
})

test('directory mutations route only allowlisted actions and never escalate archive permissions', async () => {
  const calls = [], ctx = { get: () => ({ archiveSession: input => calls.push(input), rename: input => calls.push(input) }) }
  await hostOperation(ctx, { operation: 'archive-session', args: { sessionId: 'remote', stopActivity: true } })
  await hostOperation(ctx, { operation: 'rename-workspace', args: { workspaceId: 'project', title: 'Renamed', path: '/unrelated' } })
  assert.deepEqual(calls, [{ sessionId: 'remote' }, { workspaceId: 'project', title: 'Renamed' }])
  await assert.rejects(hostOperation(ctx, { operation: 'destroy', args: {} }), /未知目录操作/)
})
