import test from 'node:test'
import assert from 'node:assert/strict'
import { projectManagedContext as projectInput, recallManagedContext, contextDigest, contextBytes, contextScope, CONTEXT_RECALL_TOOL, assertManagedContext as assertInput } from '../src/managed-context-projection.js'
import { prepareContextContinuation } from '../src/managed-context-continuation.js'
import { assertContextCallInput } from '../src/managed-context-continuation.js'
// Unintegrated candidate tests. This experimental byte policy is not a provider token limit.
const policy = { maxBytes: 128 * 1024, targetBytes: 96 * 1024 }
const projectManagedContext = input => projectInput({ ...input, policy })
const assertManagedContext = input => assertInput(input, true, policy)
const scope = { version: 1, host: 'test.example', session_id: 'worker', cwd: '/fixture', operation: { id: 'operation', attempt: 1, epoch: 1 }, profile_revision: 'profile', assignment: { id: 'assignment' }, coordinator: null, builder: null }
const tools = [{ name: CONTEXT_RECALL_TOOL, parameters: { type: 'object' } }]
function fixture({ count = 12, length = 14000, path = 'src/worker.js', tool = 'kode_read_source_range', payload } = {}) {
  const messages = ['system', 'developer', 'user'].map(role => ({ id: role, role, content: [{ type: 'text', text: `${role}: original constraints, permission boundaries and accepted task.` }] })), events = []
  for (let i = 0; i < count; i++) {
    const call = { type: 'tool-call', id: `call-${i}`, name: tool, arguments: JSON.stringify({ path }) }
    const assistant = { id: `assistant-${i}`, role: 'assistant', content: [call] }, seq = events.length + 1
    const result = { id: `result-${i}`, role: 'tool', source: { kind: 'tool', callId: call.id }, toolCallId: call.id, isError: false,
      content: [{ type: 'text', text: JSON.stringify(payload?.(i) ?? { path, sha256: 'a'.repeat(64), start_line: i + 1, next_start_line: i + 2, text: `${i}:` + '中文😀abcdefgh'.repeat(Math.ceil(length / 18)).slice(0, length) }) }] }
    messages.push(assistant, result)
    events.push({ type: 'assistant/message', seq, data: { message: assistant } }, { type: 'tool/call', seq: seq + 1, data: { callId: call.id, name: call.name, arguments: call.arguments } },
      { type: 'tool/result', seq: seq + 2, sourceEventSeqs: [seq + 1], data: { message: result } })
  }
  return { messages, tools: structuredClone(tools), scope: structuredClone(scope), events }
}
const checkpoint = (data, result) => [...data.events, { type: 'plugin:kode/context-projection', seq: data.events.length + 1, data: result.proof }]
test('bounded projection preserves authority, calls, recent code and exact byte budget without mutating originals', () => {
  const data = fixture(), original = structuredClone(data), result = projectManagedContext(data)
  assert.ok(result.proof); assert.ok(contextBytes({ ...data, messages: result.messages }) <= 131072)
  assert.deepEqual(data, original); assert.deepEqual(result.messages.slice(0, 3), data.messages.slice(0, 3))
  assert.deepEqual(result.messages.filter(m => m.role === 'assistant'), data.messages.filter(m => m.role === 'assistant'))
  assert.deepEqual(result.messages.slice(-4), data.messages.slice(-4)); assert.equal(result.proof.pinned_inputs_sha256, contextDigest(data.messages.slice(0, 3)))
})
test('checkpoint can be reprojected after restart and exact original text recalled page by page', () => {
  const data = fixture(), result = projectManagedContext(data), restored = JSON.parse(JSON.stringify(data))
  assert.deepEqual(projectManagedContext(restored), result)
  const receipt = result.proof.receipts[0], events = JSON.parse(JSON.stringify(checkpoint(data, result)))
  let offset = 0, text = ''
  do { const page = recallManagedContext(scope, events, { receipt_sha256: receipt.receipt_sha256, offset, max_characters: 41 }); text += page.text; offset = page.next_offset } while (offset !== null)
  assert.equal(text, data.messages.find(m => m.id === receipt.message_id).content[0].text)
})
for (const changed of ['host', 'session_id', 'cwd', 'operation', 'assignment', 'coordinator', 'profile_revision']) test(`recall rejects different ${changed} scope`, () => {
  const data = fixture(), result = projectManagedContext(data), other = { ...scope, [changed]: { unrelated: true } }
  assert.throws(() => recallManagedContext(other, checkpoint(data, result), { receipt_sha256: result.proof.receipts[0].receipt_sha256, offset: 0, max_characters: 10 }), /outside/)
})
for (const altered of ['checkpoint', 'result', 'call', 'link']) test(`recall rejects corrupted ${altered}`, () => {
  const data = fixture(), result = projectManagedContext(data), events = structuredClone(checkpoint(data, result)), args = { receipt_sha256: result.proof.receipts[0].receipt_sha256, offset: 0, max_characters: 20 }
  if (altered === 'checkpoint') events.at(-1).data.original_bytes++
  else if (altered === 'result') events[2].data.message.content[0].text += 'corrupt'
  else if (altered === 'call') events[0].data.message.content[0].arguments = '{}'
  else events[2].sourceEventSeqs = [99]
  assert.throws(() => recallManagedContext(scope, events, args), /integrity|provenance|differs/)
})
for (const mode of ['incomplete', 'duplicate', 'orphan']) test(`${mode} tool pairs rejected even below projection threshold`, () => {
  const data = fixture({ count: 1, length: 10 })
  if (mode === 'incomplete') data.messages.pop()
  else if (mode === 'duplicate') data.messages.push(data.messages.at(-1))
  else data.messages.splice(3, 1)
  assert.throws(() => projectManagedContext(data), /incomplete|duplicate|orphan/)
})
for (const path of ['AGENTS.md', 'docs/overview.md', 'src/CLAUDE.js', 'docs/policy.txt', 'config.json']) test(`never drops instructions/document ${path}`, () => {
  const data = fixture({ path })
  assert.throws(() => projectManagedContext(data), e => e.code === 'CONTEXT_BUDGET_EXCEEDED')
})
for (const tool of ['kode_patch_source', 'kode_write_source', 'kode_verify_output', 'kode_coordinator_publish_reply']) test(`never drops ${tool} result or input`, () => {
  const data = fixture({ tool }); assert.throws(() => projectManagedContext(data), e => e.code === 'CONTEXT_BUDGET_EXCEEDED')
})
test('error result remains exact and uncompressible', () => {
  const data = fixture(); for (const m of data.messages) if (m.role === 'tool') m.isError = true
  assert.throws(() => projectManagedContext(data), e => e.code === 'CONTEXT_BUDGET_EXCEEDED')
})
test('no recall grant means no implicit capability or truncation', () => {
  const data = fixture(); data.tools = []
  assert.throws(() => projectManagedContext(data), e => e.code === 'CONTEXT_BUDGET_EXCEEDED')
})
test('irreducible pinned input fails before any admission', async () => {
  const data = fixture({ count: 0 }); data.messages[2].content[0].text = 'x'.repeat(2 * 1024 * 1024 + 1)
  let admitted = 0, flush = 0
  const agent = { id: 'worker', session: { header: { cwd: '/fixture' }, snapshotEvents: () => data.events } }
  const runtime = { host: scope.host, ctx: { get: () => ({ flush: async () => { flush++; return true } }) } }
  await assert.rejects(async () => { await prepareContextContinuation(runtime, agent, { revision: 'profile', managedOperation: scope.operation, managedAssignment: scope.assignment }, data, async () => {}); admitted++ }, e => e.code === 'CONTEXT_BUDGET_EXCEEDED')
  assert.equal(admitted, 0); assert.equal(flush, 1)
})
test('failed persistence prevents checkpoint/admission', async () => {
  const data = fixture({ length: 400000 }), agent = { id: 'worker', session: { header: { cwd: '/fixture' }, snapshotEvents: () => data.events } }
  await assert.rejects(prepareContextContinuation({ host: scope.host, ctx: { get: () => ({ flush: async () => false }) } }, agent, {}, data, async () => {}), /persistence unavailable/)
})
test('Coordinator status metadata, guards and approvals remain entirely unprojected', () => {
  const data = fixture({ tool: 'kode_coordinator_workflow_status', count: 8, payload: i => ({ id: 'run', context_hash: 'fixed', inputs: { task: 'x'.repeat(21000) }, task_workspaces: { code: '/fixture' }, coordinator: {}, state: 'waiting', human_acceptance: { state: 'rejected', reason: `reason-${i}` }, execution_accounting: { blocked: true, reason: `pending-${i}` }, worker_clarification: { question: `question-${i}` }, revision: i }) })
  data.scope = { ...data.scope, assignment: null, coordinator: { id: 'coordinator' } }
  const projected = projectManagedContext(data)
  assert.equal(projected.proof, null); assert.deepEqual(projected.messages, data.messages)
  for (let i = 0; i < 8; i++) {
    const before = JSON.parse(data.messages[4 + i * 2].content[0].text), after = JSON.parse(projected.messages[4 + i * 2].content[0].text)
    for (const key of ['human_acceptance', 'execution_accounting', 'worker_clarification', 'state', 'revision']) assert.deepEqual(after[key], before[key])
  }
  assert.deepEqual(projected.messages.at(-1), data.messages.at(-1))
})
for (const mode of ['other-run', 'different-context', 'omitted-inputs']) test(`does not deduplicate across ${mode}`, () => {
  const data = fixture({ tool: 'kode_coordinator_workflow_status', count: 8, payload: i => ({ id: mode === 'other-run' ? `run-${i}` : 'run', context_hash: mode === 'different-context' ? `ctx-${i}` : 'ctx', inputs: i === 7 && mode === 'omitted-inputs' ? null : { task: 'x'.repeat(21000) } }) })
  assert.throws(() => projectManagedContext(data), e => e.code === 'CONTEXT_BUDGET_EXCEEDED')
})
test('pre-admission payload attestation rejects altered messages or schemas', () => {
  const data = fixture(), result = projectManagedContext(data), options = { messages: result.messages, tools }
  const proof = { input_sha256: contextDigest(options), input_bytes: contextBytes(options) }
  assertContextCallInput(proof, options)
  assert.throws(() => assertContextCallInput(proof, { ...options, tools: [] }), /changed/)
  const changed = structuredClone(options); changed.messages[2].content[0].text += 'changed'
  assert.throws(() => assertContextCallInput(proof, changed), /changed/)
})
test('all mandatory content and schemas counted even for small no-op projection', () => {
  const data = fixture({ count: 0 }); data.tools[0].description = 'x'.repeat(140000)
  assert.throws(() => assertManagedContext(data), e => e.code === 'CONTEXT_BUDGET_EXCEEDED')
})
