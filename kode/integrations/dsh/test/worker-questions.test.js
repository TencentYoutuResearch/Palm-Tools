import test from 'node:test'
import assert from 'node:assert/strict'
import { workerQuestions } from '../src/worker-questions.js'
test('native app-server question schema keeps flags and normalizes nullable options', () => {
 const input = [{ id: 'scope:1', header: '', question: 'Which scope?', isOther: true, isSecret: false, options: null }]
 const result = workerQuestions(input)
 assert.deepEqual(result, [{ id: 'scope:1', header: '', question: 'Which scope?', isOther: true, isSecret: false }])
 assert.equal(input[0].options, null)
 assert.deepEqual(workerQuestions([{ id: 'scope', question: 'Scope?', options: [{ label: 'Current', description: '' }] }])[0].options, [{ label: 'Current', description: '' }])
})
test('Worker question data refuses authority fields, duplicate IDs and oversized content', () => {
 const question = { id: 'scope', question: 'Which scope?' }
 for (const input of [[{ ...question, permission: 'bypass' }], [question, question], [{ ...question, question: 'x'.repeat(4097) }], [], [{ ...question, isSecret: 'yes' }]]) {
  assert.throws(() => workerQuestions(input), /Invalid/)
 }
})
