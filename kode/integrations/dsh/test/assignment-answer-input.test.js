import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { clarificationAnswerInput } from '../src/assignment-input.js'

test('Worker consumes only its immutable Home-bound answer with the original human reference', () => {
  const operation = { id: 'operation', attempt: 1, epoch: 1, home_node: 'home' }
  const worker = { node_id: 'execution', session_id: 'worker' }
  const source = { node_id: 'home', session_id: 'superagent' }
  const payload = { format: 'kode.assignment.clarification-answer.v1', assignment_id: 'assignment', run_id: 'run',
    team_id: 'team', worker, operation, context_hash: 'context', stage_attempt: 1,
    question_request_id: 'question', questions: [{ id: 'wording', question: 'Wording?' }],
    answer: { source_message_id: 'human', content: 'Use implemented.' } }
  const message = { id: 'delivery', target: worker, source, content: JSON.stringify(payload) }
  const receipt = { snapshot: 'assignment_answer_receipt.v1', assignment_id: 'assignment', run_id: 'run', team_id: 'team',
    worker, source, home_hub: 'home', operation, context_hash: 'context', stage_attempt: 1,
    question_request_id: 'question', source_message_id: 'human', message_id: message.id,
    state: 'queued', completion_authorized: false, content_hash: createHash('sha256').update(message.content).digest('hex') }
  const assignment = { id: 'assignment', run_id: 'run', team_id: 'team', worker, state: 'prepared',
    context_hash: 'context', stage_attempt: 1, clarification_answers: [receipt] }
  const binding = { managedAssignment: { id: 'assignment' }, managedOperation: operation }
  const input = clarificationAnswerInput(assignment, binding, message, 'input')
  assert.equal(input.source.kind, 'agent-message')
  assert.equal(input.source.senderSessionId, 'kode:home:superagent')
  assert.match(input.content[0].text, /Use implemented/)
  const reject = (a, b, m) => assert.throws(() => clarificationAnswerInput(a, b, m, 'input'), /binding mismatch/)
  reject({ ...assignment, clarification_answers: [] }, binding, message)
  for (const changes of [{ run_id: 'foreign' }, { team_id: 'foreign' }, { context_hash: 'foreign' },
    { home_hub: 'foreign' }, { completion_authorized: true }, { stage_attempt: 2 }]) {
    reject({ ...assignment, clarification_answers: [{ ...receipt, ...changes }] }, binding, message)
  }
  reject(assignment, { ...binding, managedOperation: { ...operation, epoch: 2 } }, message)
  reject(assignment, binding, { ...message, source: { ...source, session_id: 'peer' } })
  reject(assignment, binding, { ...message, content: message.content.replace('implemented.', 'forged.') })
  reject({ ...assignment, state: 'completed' }, binding, message)
})
