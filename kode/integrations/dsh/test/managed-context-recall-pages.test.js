import test from 'node:test'
import assert from 'node:assert/strict'
import { contextDigest as hash, contextBytes, projectManagedContext as projectInput, recallManagedContext as recall, resolveContextReceipt, CONTEXT_RECALL_TOOL } from '../src/managed-context-projection.js'
// Explicit experimental budget for the unintegrated Worker candidate.
const project = input => projectInput({ ...input, policy: { maxBytes: 128 * 1024, targetBytes: 96 * 1024 } })
const scope = { host: 'host.example', session_id: 'fixture', operation: { id: 'op', attempt: 1, epoch: 1 }, assignment: { id: 'task' }, cwd: '/fixture' }
const tools = [{ name: CONTEXT_RECALL_TOOL, parameters: { type: 'object' } }]
function appendPair(f, call, data) {
  const seq = f.events.length, assistant = { id: `assistant-${call.id}`, role: 'assistant', content: [call] }
  const message = { id: `result-${call.id}`, role: 'tool', source: { kind: 'tool', callId: call.id }, toolCallId: call.id, isError: false, content: [{ type: 'text', text: JSON.stringify(data) }] }
  f.events.push({ type: 'assistant/message', seq, data: { message: assistant } }, { type: 'tool/call', seq: seq + 1, data: { callId: call.id, name: call.name, arguments: call.arguments } }, { type: 'tool/result', seq: seq + 2, sourceEventSeqs: [seq + 1], data: { message } })
  f.messages.push(assistant, message)
  return message
}
function appendCheckpoint(f, proof) { f.events.push({ type: 'plugin:kode/context-projection', seq: f.events.length, data: proof }) }
function fixture() {
  const f = { scope: structuredClone(scope), tools: structuredClone(tools), messages: ['system', 'developer', 'user'].map(role => ({ id: role, role, content: [{ type: 'text', text: `${role} unchanged task and constraints.` }] })), events: [] }
  for (let i = 0; i < 12; i++) appendPair(f, { type: 'tool-call', id: `source-${i}`, name: 'kode_read_source_range', arguments: JSON.stringify({ path: `src/${i}.js`, start_line: 1, line_count: 120, expected_sha256: null }) }, { path: `src/${i}.js`, sha256: 'a'.repeat(64), start_line: 1, text: 'const s = "中文😀";\n'.repeat(600) })
  const initial = project(f)
  assert.ok(initial.proof.receipts.length)
  // Simulate a genuine persisted old-version checkpoint to prove backward compatibility.
  const { checkpoint_sha256, recall_pages, ...body } = initial.proof
  body.version = 1; body.policy = 'exact-read-result-projection.v1'
  const proof = { ...body, checkpoint_sha256: hash(body) }
  appendCheckpoint(f, proof); f.roots = proof.receipts; f.rootCheckpoint = proof
  return f
}
function appendPages(f, count, prefix = 'recall') {
  for (let i = 0; i < count; i++) {
    const receipt = f.roots[i % f.roots.length], first = recall(f.scope, f.events, { receipt_sha256: receipt.receipt_sha256, offset: 0, max_characters: 4096 })
    const args = { receipt_sha256: receipt.receipt_sha256, offset: i % 2 ? first.next_offset : 0, max_characters: 4096 }
    const data = recall(f.scope, f.events, args)
    appendPair(f, { type: 'tool-call', id: `${prefix}-${i}`, name: CONTEXT_RECALL_TOOL, arguments: JSON.stringify(args) }, data)
  }
}
function assertPages(f, result) {
  assert.ok(result.proof.recall_pages.length)
  assert.ok(result.proof.receipts.every(row => row.tool !== CONTEXT_RECALL_TOOL))
  for (const page of result.proof.recall_pages) {
    const original = JSON.parse(f.messages.find(m => m.id === page.message_id).content[0].text)
    const projected = JSON.parse(result.messages.find(m => m.id === page.message_id).content[0].text)
    const { text, ...meta } = original, { archived_text, ...kept } = projected
    assert.deepEqual(kept, meta)
    assert.deepEqual(recall(f.scope, f.events, page.request, page.call_event_seq), original)
    assert.equal(archived_text.text_json_sha256, hash(text)); assert.equal(archived_text.audit_page_sha256, page.page_sha256)
    assert.equal(page.result_sha256, hash(f.messages.find(m => m.id === page.message_id)))
    assert.equal(page.root_result_sha256, original.result_sha256)
    assert.ok(page.root_checkpoint_event_seq < page.call_event_seq && page.call_event_seq < page.result_event_seq)
    assert.ok(f.roots.some(root => root.receipt_sha256 === page.root_receipt_sha256))
  }
}
test('completed recall pages preserve metadata and direct root; exact Unicode/JSON pages can be restored', () => {
  const f = fixture(); appendPages(f, 18)
  const before = structuredClone(f), result = project(f)
  assertPages(f, result); assert.deepEqual(f, before)
  assert.ok(contextBytes({ ...f, messages: result.messages }) <= 131072)
  assert.deepEqual(result.messages.slice(0, 3), f.messages.slice(0, 3)); assert.deepEqual(result.messages.slice(-4), f.messages.slice(-4))
  const pageId = result.proof.recall_pages[0].page_sha256
  appendCheckpoint(f, result.proof)
  assert.throws(() => resolveContextReceipt(f.scope, f.events, pageId), /outside this execution scope/, 'page audit IDs are not recursive root receipts')
})
test('multiple projection generations and persisted reload keep roots flat and deterministic', () => {
  const f = fixture()
  for (let generation = 0; generation < 3; generation++) {
    appendPages(f, generation === 0 ? 18 : 8, `g${generation}`)
    const result = project(f); assertPages(f, result)
    assert.deepEqual(project(JSON.parse(JSON.stringify(f))), result)
    appendCheckpoint(f, result.proof)
    for (const root of f.roots) assert.equal(resolveContextReceipt(f.scope, f.events, root.receipt_sha256).call.name, 'kode_read_source_range')
  }
})
for (const forgedTool of [CONTEXT_RECALL_TOOL, 'kode_read_source_range']) test(`recall disguised as a root (${forgedTool}) is denied even with a valid checkpoint hash`, () => {
  const f = fixture(); appendPages(f, 1)
  const callEvent = f.events.at(-3), call = callEvent.data.message.content[0], message = f.events.at(-1).data.message
  const row = { receipt_sha256: hash({ scope_sha256: hash(f.scope), call, message }), message_id: message.id, call_id: call.id, tool: forgedTool, call_sha256: hash(call), result_sha256: hash(message), call_event_seq: callEvent.seq, result_event_seq: f.events.at(-1).seq, original_text_characters: message.content[0].text.length }
  const { checkpoint_sha256, ...body } = f.rootCheckpoint
  body.receipts = [row]; const proof = { ...body, checkpoint_sha256: hash(body) }; appendCheckpoint(f, proof)
  assert.throws(() => resolveContextReceipt(f.scope, f.events, row.receipt_sha256), /root cannot be a recall/)
})
for (const fault of ['format', 'text', 'next-offset', 'unknown-parent', 'parent-text', 'forward-checkpoint', 'cross-scope', 'tool-link']) test(`projection rejects ${fault} rather than archiving unverified pages`, () => {
  const f = fixture(); appendPages(f, 3)
  const recalls = f.events.filter(e => e.type === 'tool/result' && e.data.message.toolCallId.startsWith('recall-'))
  const target = recalls[0], value = JSON.parse(target.data.message.content[0].text)
  if (fault === 'format') value.format = 'lookalike.recalled-result'
  if (fault === 'text') value.text += 'forged'
  if (fault === 'next-offset') value.next_offset++
  if (['format', 'text', 'next-offset'].includes(fault)) target.data.message.content[0].text = JSON.stringify(value)
  if (fault === 'unknown-parent') {
    const call = f.messages.find(m => m.role === 'assistant' && m.content[0].id === target.data.message.toolCallId).content[0]
    call.arguments = JSON.stringify({ receipt_sha256: 'f'.repeat(64), offset: 0, max_characters: 4096 })
    f.events.find(e => e.type === 'tool/call' && e.data.callId === call.id).data.arguments = call.arguments
  }
  if (fault === 'parent-text') f.events.find(e => e.type === 'tool/result').data.message.content[0].text += 'altered'
  if (fault === 'forward-checkpoint') f.events.find(e => e.type === 'plugin:kode/context-projection').seq = f.events.length + 1
  if (fault === 'cross-scope') f.scope.operation.epoch++
  if (fault === 'tool-link') target.sourceEventSeqs = [0]
  assert.throws(() => project(f), /recall|scope|integrity|provenance|JSON|text/i)
})
test('a completed error stays intact and is never projected as a recalled page', () => {
  const f = fixture(); appendPages(f, 5)
  const failed = f.messages.find(m => m.role === 'tool' && m.toolCallId === 'recall-0')
  failed.isError = true; failed.content[0].text = 'Explicit denied recall, no data returned'
  const result = project(f)
  assert.deepEqual(result.messages.find(m => m.id === failed.id), failed)
  assert.ok(!result.proof.recall_pages.some(p => p.message_id === failed.id))
})
test('Coordinator duplicate metadata remains verbatim without a projection or recall dependency', () => {
  const f = { scope: { ...scope, assignment: null, coordinator: { id: 'coordinator' } }, tools, messages: [{ role: 'system', content: [{ type: 'text', text: 'Pinned '.repeat(10000) }] }], events: [] }
  for (let i = 0; i < 22; i++) appendPair(f, { type: 'tool-call', id: `status-${i}`, name: 'kode_coordinator_workflow_status', arguments: JSON.stringify({ run_id: 'run' }) }, { id: 'run', context_hash: 'context', task_workspaces: { code: 'x'.repeat(800) }, coordinator: { identity: 'y'.repeat(300) }, human_acceptance: { state: 'rejected', reason: `keep-${i}` }, execution_accounting: { blocked: true, reason: `usage-${i}` }, cancellation: { state: 'waiting' }, observed_at: i })
  const result = project(f)
  assert.equal(result.proof, null); assert.deepEqual(result.messages, f.messages)
  for (const before of f.messages.filter(m => m.role === 'tool')) {
    const original = JSON.parse(before.content[0].text), after = JSON.parse(result.messages.find(m => m.id === before.id).content[0].text)
    for (const field of ['human_acceptance', 'execution_accounting', 'cancellation', 'observed_at']) assert.deepEqual(after[field], original[field])
  }
  assert.deepEqual(result.messages.at(-1), f.messages.at(-1))
})
