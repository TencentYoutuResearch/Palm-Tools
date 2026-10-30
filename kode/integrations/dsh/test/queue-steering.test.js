import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeAgentDriver } from '../src/native-agent-driver.js'
import { installQueueSteering } from '../src/queue-steering.js'

function fixture(supported = true) {
  const message = { id: 'queued', source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep this input' }] }
  const rows = [message], nextStep = [], events = []
  const agent = {
    status: 'running', runtime: { adapter: { supportsSteering: () => supported } },
    assertSteeringAvailable: NativeAgentDriver.prototype.assertSteeringAvailable,
    steer: NativeAgentDriver.prototype.steer,
    send(input, target) { nextStep.push(input); events.push('accepted') },
    scheduleSteering() {},
    inbox: { nextTurn: rows, nextStep, splice(target, index, count) { events.push('removed'); rows.splice(index, count) } },
  }
  const controller = { calls: 0, async updateQueue() { this.calls++; return { upstream: true } } }
  const original = controller.updateQueue
  const dispose = installQueueSteering({ agents: { get: () => agent } }, controller)
  return { message, agent, controller, original, dispose, events, request: { sessionId: 'session', itemId: 'queued', action: { kind: 'steer' } } }
}

test('unsupported native steering retains the exact queued message without cancellation', async () => {
  const f = fixture(false)
  await assert.rejects(f.controller.updateQueue(f.request), /不支持原生中途插入/)
  assert.equal(f.agent.inbox.nextTurn[0], f.message)
  assert.equal(f.agent.inbox.nextStep.length, 0)
  assert.deepEqual(f.events, [])
  assert.equal(f.controller.calls, 0)
})

test('successful steering admits once before removing the queue occurrence', async () => {
  const f = fixture()
  assert.deepEqual(await f.controller.updateQueue(f.request), { accepted: true })
  assert.deepEqual(f.events, ['accepted', 'removed'])
  assert.equal(f.agent.inbox.nextTurn.length, 0)
  assert.deepEqual(f.agent.inbox.nextStep, [f.message])
  await f.controller.updateQueue(f.request)
  assert.equal(f.agent.inbox.nextStep.length, 1)
  assert.equal(f.controller.calls, 1)
})

test('a native admission exception keeps the original queue order and content', async () => {
  const f = fixture()
  f.agent.steer = () => { throw new Error('admission failed') }
  await assert.rejects(f.controller.updateQueue(f.request), /admission failed/)
  assert.deepEqual(f.agent.inbox.nextTurn, [f.message])
  assert.deepEqual(f.events, [])
})

test('other queue operations and idle agents retain upstream admission checks and teardown restores the controller', async () => {
  const f = fixture()
  await f.controller.updateQueue({ ...f.request, action: { kind: 'remove' } })
  f.agent.status = 'idle'
  await f.controller.updateQueue(f.request)
  assert.equal(f.controller.calls, 2)
  f.dispose()
  assert.equal(f.controller.updateQueue, f.original)
})
