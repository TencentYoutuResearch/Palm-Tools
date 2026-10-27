import test from 'node:test'
import assert from 'node:assert/strict'
import { askAcpForm } from '../src/acp-questions.js'
test('ACP forms preserve enum choices, multiple choices, typed values and Claude custom-answer companions', async () => {
  const request = { mode: 'form', message: 'Choose settings', requestedSchema: { type: 'object', required: ['count', 'enabled'], properties: {
    question_0: { type: 'string', oneOf: [{ const: 'one', title: 'First' }, { const: 'two', title: 'Second' }] }, question_0_custom: { type: 'string' },
    many: { type: 'array', items: { anyOf: [{ const: 'a' }, { const: 'b' }] } }, count: { type: 'integer', minimum: 1 }, enabled: { type: 'boolean' },
  } } }
  const result = await askAcpForm(request, async questions => {
    assert.equal(questions.questions.length, 4)
    assert.equal(questions.questions.find(q => q.id === 'many').multiSelect, true)
    return { answers: { question_0: { answers: ['First', 'additional note'], selected: ['First'], custom: 'additional note' }, many: { answers: ['a', 'b'] }, count: { answers: ['2'] }, enabled: { answers: ['true'] } } }
  })
  assert.equal(result.action, 'accept')
  assert.deepEqual({ ...result.content }, { question_0: 'one', question_0_custom: 'additional note', many: ['a', 'b'], count: 2, enabled: true })
})
test('invalid form answers and unsupported URL elicitation never become accepted input', async () => {
  const request = { mode: 'form', message: 'Count', requestedSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] } }
  assert.equal((await askAcpForm(request, async () => ({ answers: { count: { answers: ['invalid'] } } }))).action, 'cancel')
  assert.equal((await askAcpForm({ mode: 'url' }, async () => { throw new Error('must not open a URL') })).action, 'cancel')
})
