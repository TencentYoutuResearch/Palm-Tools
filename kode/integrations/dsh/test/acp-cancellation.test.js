import test from 'node:test'
import assert from 'node:assert/strict'
import { AcpSession, AcpTurnCancelledError } from '../src/acp-session.js'

const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events }

for (const stopReason of ['cancelled', 'max_tokens', 'refusal', 'end_turn']) test(`ACP distinguishes ${stopReason} from a failed or successful turn`, async () => {
  const session = new AcpSession({ type: 'codebuddy' }, '/tmp')
  session.threadId = 'native-session'
  session.info = { agentCapabilities: {} }
  session.configure = async () => {}
  session.request = async () => ({ stopReason })
  let closed = false
  session.close = async () => { closed = true }
  const task = collect(session.turn([{ type: 'text', text: 'Task' }]))
  if (stopReason === 'end_turn') {
    const events = await task
    assert.equal(events.at(-1).params.turn.status, 'completed')
    assert.equal(closed, false)
  } else {
    await assert.rejects(task, error => stopReason === 'cancelled' ? error instanceof AcpTurnCancelledError : !(error instanceof AcpTurnCancelledError) && error.message === `ACP turn stopped: ${stopReason}`)
    assert.equal(closed, true)
  }
  assert.equal(session.active, undefined)
})

test('a late response from an interrupted ACP prompt cannot end its replacement', async () => {
  const session = new AcpSession({ type: 'codebuddy' }, '/tmp')
  const requests = []
  session.request = () => new Promise((resolve, reject) => requests.push({ resolve, reject }))
  const active = { signal: new AbortController().signal, done: false, error: undefined, end(error) { active.done = true; active.error ??= error } }

  session.startPrompt(active, [{ type: 'text', text: 'Old task' }])
  session.startPrompt(active, [{ type: 'text', text: 'New task' }])
  requests[0].resolve({ stopReason: 'cancelled' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(active.done, false)

  requests[1].reject(new AcpTurnCancelledError())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(active.done, true)
  assert.ok(active.error instanceof AcpTurnCancelledError)
})
