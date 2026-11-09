import test from 'node:test'
import assert from 'node:assert/strict'
import { installManagedSessionCommandGuard, installManagedSessionGatewayGuard, managedSessionBinding, registerManagedSessionAccess } from '../src/managed-session-access.js'
test('managed public Session writes are refused before resolution and preserve ordinary method contracts', async () => {
  const rows = new Map([['worker', { managedOperation: { id: 'operation', home_node: 'home' }, managedAssignment: { id: 'assignment' } }]])
  const profiles = { binding: id => rows.get(id) }, calls = []
  const prototype = {}
  for (const method of ['prompt', 'updateQueue', 'cancel', 'selectModel', 'rename', 'fork', 'inspect', 'promote']) {
    prototype[method] = function (...args) { calls.push({ method, receiver: this, args }); return method }
  }
  const controller = Object.create(prototype), before = Object.getOwnPropertyDescriptors(controller)
  const dispose = installManagedSessionCommandGuard(controller, profiles)
  for (const method of ['prompt', 'updateQueue', 'cancel', 'selectModel', 'rename', 'fork']) {
    assert.throws(() => controller[method]({ sessionId: 'worker' }), /协作流程管理/)
    const signal = new AbortController().signal, request = { sessionId: 'ordinary' }
    assert.equal(controller[method](request, signal), method)
    assert.equal(calls.at(-1).receiver, controller); assert.deepEqual(calls.at(-1).args, [request, signal])
  }
  assert.equal(controller.inspect('worker'), 'inspect')
  assert.equal(calls.length, 7)
  dispose(); assert.deepEqual(Object.getOwnPropertyDescriptors(controller), before)
  assert.equal(controller.prompt({ sessionId: 'worker' }), 'prompt')
})
test('guard disposal preserves a later integration and malformed managed bindings stay fenced', () => {
  const profiles = { binding: () => ({ managedOperation: {} }) }, controller = { prompt() { throw Error('original must not run') }, promote() {} }
  const dispose = installManagedSessionCommandGuard(controller, profiles)
  assert.throws(() => controller.prompt({ sessionId: 'bound' }), /协作流程管理/)
  const later = () => {}; controller.prompt = later; dispose(); assert.equal(controller.prompt, later)
  assert.equal(managedSessionBinding(profiles, 'bound').role, 'operation')
})
test('managed cold history releases its observation without activating an Agent', () => {
  let promoted = 0, disposed = 0
  const controller = { prompt() {}, promote(observation) { promoted++; observation[Symbol.dispose]() } }
  const profiles = { binding: id => id === 'worker' ? { managedOperation: { id: 'operation' } } : undefined }
  const dispose = installManagedSessionCommandGuard(controller, profiles)
  const observation = id => ({ header: { id }, [Symbol.dispose]() { disposed++ } })
  controller.promote(observation('worker'))
  assert.equal(promoted, 0); assert.equal(disposed, 1)
  controller.promote(observation('ordinary'))
  assert.equal(promoted, 1); assert.equal(disposed, 2)
  dispose(); controller.promote(observation('worker'))
  assert.equal(promoted, 2); assert.equal(disposed, 3)
})
test('Gateway refuses managed scoped APIs before resolving a Context or lookup', () => {
  let resolutions = 0
  const prototype = {
    resolveReceiverContext() { resolutions++; return this },
    resolveParameter() { resolutions++; return this },
  }
  const gateway = Object.create(prototype), profiles = { binding: id => id === 'worker' ? { managedOperation: { id: 'operation' } } : undefined }
  const dispose = installManagedSessionGatewayGuard(gateway, profiles)
  const context = { invocation: { kind: 'context', context: 'agent', wire: 'agentId' } }
  const lookup = { source: 'lookup', lookup: 'session', wire: 'sessionId' }
  assert.throws(() => gateway.resolveReceiverContext(context, { agentId: 'worker' }), /协作流程管理/)
  assert.throws(() => gateway.resolveParameter(lookup, { sessionId: 'worker' }), /协作流程管理/)
  assert.equal(resolutions, 0)
  assert.equal(gateway.resolveReceiverContext(context, { agentId: 'ordinary' }), gateway)
  assert.equal(gateway.resolveParameter(lookup, { sessionId: 'ordinary' }), gateway)
  assert.equal(gateway.resolveReceiverContext({ invocation: { kind: 'direct' } }, { sessionId: 'worker' }), gateway)
  assert.equal(gateway.resolveParameter({ source: 'json', wire: 'request' }, { request: { sessionId: 'worker' } }), gateway)
  assert.equal(resolutions, 4)
  dispose(); assert.deepEqual(Object.keys(gateway), [])
  gateway.resolveReceiverContext(context, { agentId: 'worker' }); assert.equal(resolutions, 5)
})
test('ownership route is owner-only and returns bounded binding facts without Agent activation', async () => {
  let route, status, result, reads = 0, principal = 'owner'
  const profiles = { binding(id) { reads++; assert.equal(id, 'worker'); return { managedOperation: { id: 'operation' }, managedAssignment: { id: 'assignment' }, profile: { env: { private: 'fixture-only' } } } } }
  registerManagedSessionAccess({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind: principal } } }) } }, { profiles }, 'local')
  const response = { writeHead: value => { status = value }, end: body => { result = JSON.parse(body) } }
  const request = url => ({ method: 'GET', url })
  principal = 'agent'; await route.handler(request('/api/kode/managed-session?session_id=worker'), response); assert.equal(status, 403); assert.equal(reads, 0)
  principal = 'owner'
  for (const query of ['session_id=../outside', 'session_id=worker&home_hub=other', 'session_id=worker&session_id=other']) {
    await route.handler(request('/api/kode/managed-session?' + query), response); assert.equal(status, 400); assert.equal(reads, 0)
  }
  await route.handler(request('/api/kode/managed-session?session_id=worker'), response)
  assert.equal(status, 200); assert.equal(reads, 1); assert.equal(result.read_only, true)
  assert.equal(result.managed.assignment_id, 'assignment'); assert.equal(result.home_hub, 'local')
  assert.ok(!JSON.stringify(result).includes('fixture-only'))
})
