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
