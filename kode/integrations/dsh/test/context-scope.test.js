import test from 'node:test'
import assert from 'node:assert/strict'
import { validateContextScope, discussionScopeId, contextScopeKey, contextIsolation,
  assertLegacyCoordinatorContext, assertScopedHistory } from '../src/context-scope.js'
import { coordinatorInput } from '../src/coordinator-input.js'
import { prepareCoordinatorDispatch } from '../src/coordinator-preparation.js'
import { mountCoordinatorContext } from '../src/coordinator-context.js'
import { resumeCoordinator } from '../src/coordinator-resume.js'
import { startCoordinator } from '../src/coordinator-start.js'
import { coordinatorBootstrapInput, coordinatorRecoveryInput } from '../src/coordinator-bootstrap.js'
import { OfficialDispatch } from '../src/official-dispatch.js'

const scope = (kind = 'discussion_thread', thread = 'a') => ({ version:2, home_hub:'home', team_id:'team', kind,
  scope_id:kind === 'discussion_thread' ? discussionScopeId('surface', thread) : 'private', context_epoch:1 })
const unsupported = { code:'CONTEXT_SCOPE_UNSUPPORTED' }

test('strict v2 scope identity includes home, team, kind, stable thread and epoch', () => {
  const a = scope(), reordered = Object.fromEntries(Object.entries(a).reverse())
  assert.deepEqual(validateContextScope(a), a)
  assert.equal(contextScopeKey(a), contextScopeKey(reordered))
  for (const other of [scope('discussion_thread','b'), scope('team_private'), {...a,home_hub:'other'}, {...a,team_id:'other'}]) {
    assert.notEqual(contextScopeKey(a), contextScopeKey(other))
  }
  assert.notEqual(discussionScopeId('ab','c'), discussionScopeId('a','bc'))
  for (const invalid of [null, {}, {...a,version:1}, {...a,context_epoch:2}, {...a,inherit:true}, {...a,scope_id:'thread-a'}]) {
    assert.throws(() => validateContextScope(invalid), {code:'CONTEXT_SCOPE_INVALID'})
  }
  assert.equal(contextIsolation(undefined), 'legacy_shared')
  assert.equal(contextIsolation(a), 'scoped_v2')
})

test('v2 golden hashes match the fixed UTF-8 JSON array wire contract', () => {
  const thread = discussionScopeId('surface','thread-a')
  assert.equal(thread,'6e8680193a309edd5ea2ddc7658a96f4655bf580dc3584ad712b8b1981e2bdc0')
  for (const [kind,scope_id,key] of [
    ['discussion_thread',thread,'f806668b15956c9551350039f6c07f29910690ff74498e13b4603d41cb1ae021'],
    ['team_private','private','af332ef4679034726d90dd1d85c5c4dec2eb6733cfb6cb5c959bea20fb553421'],
    ['builder_draft','draft-a','19a7c4ef5d91fc94f4b53010ad1789fa3d48ce9d3565dc14dd5bbad509960882'],
  ]) assert.equal(contextScopeKey({version:2,home_hub:'home',team_id:'team',kind,scope_id,context_epoch:1}),key)
})

test('every required field rejects missing/null and unsupported versions, kinds, epochs and identities', () => {
  for (const key of Object.keys(scope())) {
    const missing = scope(); delete missing[key]
    for (const invalid of [missing, {...scope(),[key]:null}, {...scope(),[key]:undefined}]) {
      assert.throws(()=>validateContextScope(invalid),{code:'CONTEXT_SCOPE_INVALID'})
    }
  }
  for (const delta of [{kind:'legacy_shared'},{kind:'thread'},{version:'2'},{context_epoch:'1'},
    {context_epoch:0},{context_epoch:-1},{context_epoch:1.5},{home_hub:''},{team_id:'a/b'},
    {home_hub:'h'.repeat(161)},{team_id:'团队'},{scope_id:'A'.repeat(64)},{extra:false}]) {
    assert.throws(()=>validateContextScope({...scope(),...delta}),{code:'CONTEXT_SCOPE_INVALID'})
  }
})

test('future history contract rejects private, foreign-thread, foreign-team and unscoped canaries before mock provider', () => {
  const a = scope(), b = scope('discussion_thread','b'), privateScope = scope('team_private')
  const row = (context_scope, text) => ({context_scope, content:text})
  const clean = () => ({context_scope:a, messages:[row(a,'THREAD_A')], toolHistory:[row(a,'TOOL_A')]})
  const providerCalls = []
  // Contract-level mock only. Production v2 remains unavailable, tested below.
  const provider = journal => { assertScopedHistory(a,journal); providerCalls.push(structuredClone(journal)) }
  provider(clean())
  for (const foreign of [b, privateScope, {...a,team_id:'other'}, undefined]) {
    for (const field of ['messages','toolHistory']) {
      const journal = clean(); journal[field].push(row(foreign,'FOREIGN_CANARY'))
      assert.throws(() => provider(journal), /Foreign or unscoped/)
    }
  }
  for (const extra of [{seeded:true}, {parent_session_id:'legacy'}, {inherited_session_id:'legacy'}, {context_scope:b}]) {
    assert.throws(() => provider({...clean(),...extra}), /ownership mismatch/)
  }
  assert.equal(providerCalls.length,1)
  assert.doesNotMatch(JSON.stringify(providerCalls), /FOREIGN_CANARY/)
})

test('v2 is rejected by every Coordinator entry before host/provider effects, without downgrade', async () => {
  const context_scope = scope(), coordinator = {team_id:'team',context_scope}
  let effects = 0
  const effect = () => { effects++; throw Error('unexpected external effect') }
  const binding = {managedCoordinator:coordinator}
  const runtime = {profiles:{binding:()=>binding},client:{call:effect}}
  const host = {execution:runtime,create:effect,resume:effect}
  await assert.rejects(coordinatorInput(runtime.client,binding,{},'input'),unsupported)
  await assert.rejects(prepareCoordinatorDispatch(runtime,{context_scope}),unsupported)
  await assert.rejects(mountCoordinatorContext({}, {id:'session'},runtime,coordinator),unsupported)
  await assert.rejects(resumeCoordinator(host,{session_id:'session',coordinator}),unsupported)
  await assert.rejects(startCoordinator(host,{start:{context_scope}}),unsupported)
  assert.throws(()=>new OfficialDispatch(host).dispatch({coordinator}),unsupported)
  assert.throws(()=>coordinatorBootstrapInput('home',{context_scope}),unsupported)
  assert.throws(()=>coordinatorRecoveryInput('home',{}, {context_scope}),unsupported)
  assert.equal(effects,0)
  assert.throws(()=>assertLegacyCoordinatorContext({context_scope:undefined}),{code:'CONTEXT_SCOPE_INVALID'})
})

test('legacy classifier leaves existing history and runtime untouched', () => {
  const binding = {managedCoordinator:{team_id:'team'},messages:['old-private'],toolHistory:['old-tool']}
  const before = structuredClone(binding)
  assert.equal(assertLegacyCoordinatorContext(binding,binding.managedCoordinator),'legacy_shared')
  assert.deepEqual(binding,before)
})
