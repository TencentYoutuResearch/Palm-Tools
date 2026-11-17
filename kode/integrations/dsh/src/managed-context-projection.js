/** Deterministic read-result projection. Never a semantic summary or an authority source.
 * Full original session events are retained; recall is explicitly granted and scoped.
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
export const CONTEXT_RECALL_TOOL = 'kode_recall_context'
// Host payload safety bounds, not provider token limits. Experiments must pass an explicit policy.
export const CONTEXT_BUDGET_BYTES = 2 * 1024 * 1024
export const CONTEXT_TARGET_BYTES = CONTEXT_BUDGET_BYTES
export function contextPolicy(policy = {}) {
  const { maxBytes = CONTEXT_BUDGET_BYTES, targetBytes = maxBytes } = policy
  if (Object.keys(policy).some(key => !['maxBytes', 'targetBytes'].includes(key))
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > CONTEXT_BUDGET_BYTES
      || !Number.isSafeInteger(targetBytes) || targetBytes < 1 || targetBytes > maxBytes) throw Error('Invalid Worker context payload policy')
  return Object.freeze({ maxBytes, targetBytes })
}
export const contextDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const contextBytes = ({ messages, tools }) => Buffer.byteLength(JSON.stringify({ messages, tools }))
const fail = (message, code = 'CONTEXT_PROJECTION_REJECTED') => Object.assign(new Error(message), { code })
export function assertToolPairs(messages) {
  const calls = new Set(), results = new Set()
  for (const message of messages) {
    if (message.role === 'assistant') for (const call of message.content.filter(b => b.type === 'tool-call')) {
      if (!call.id || calls.has(call.id)) throw fail('Context duplicate tool call')
      calls.add(call.id)
    }
    if (message.role === 'tool') {
      if (!calls.has(message.toolCallId) || results.has(message.toolCallId)) throw fail('Context orphan or duplicate tool result')
      results.add(message.toolCallId)
    }
  }
  if ([...calls].some(id => !results.has(id))) throw fail('Context tool call is incomplete')
}
export function assertManagedContext(input, checkBudget = true, policy) {
  const { maxBytes } = contextPolicy(policy)
  const { messages, tools } = input
  if (!Array.isArray(messages) || !Array.isArray(tools)
      || messages.some(m => !m || !['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role)
        || !Array.isArray(m.content) || m.content.some(b => !b || !['text', 'tool-call', 'tool-result'].includes(b.type)))
      || tools.some(t => !t?.name || !t.parameters)
      || messages.filter(m => ['system', 'developer'].includes(m.role)).some(m => m.content.some(b => b.type !== 'text' || typeof b.text !== 'string'))) {
    throw fail('Managed Codex requires text workflow input and explicit tool schemas')
  }
  assertToolPairs(messages)
  const bytes = contextBytes(input)
  if (checkBudget && bytes > maxBytes) throw Object.assign(fail('Managed workflow context requires compaction', 'CONTEXT_BUDGET_EXCEEDED'), { input_bytes: bytes, max_bytes: maxBytes })
  return bytes
}
export function contextScope(host, agent, binding) {
  if (!host || !agent?.id || !agent.session?.header?.cwd || !binding?.managedOperation || binding.operationClosed
      || !binding.revision || ![binding.managedAssignment, binding.managedCoordinator, binding.managedBuilder].filter(Boolean).length) {
    throw fail('Managed context scope unavailable')
  }
  return { version: 1, host, session_id: agent.id, cwd: agent.session.header.cwd,
    operation: structuredClone(binding.managedOperation), profile_revision: binding.revision,
    assignment: structuredClone(binding.managedAssignment ?? null), coordinator: structuredClone(binding.managedCoordinator ?? null), builder: structuredClone(binding.managedBuilder ?? null) }
}
const resultEvent = (events, message) => {
  const matches = events.filter(e => e.type === 'tool/result' && e.data?.message?.id === message.id)
  if (matches.length !== 1 || !isDeepStrictEqual(matches[0].data.message, message)) throw fail('Context result is not an exact committed tool event')
  const execution = events.filter(e => e.type === 'tool/call' && e.data?.callId === message.toolCallId)
  if (execution.length !== 1 || !isDeepStrictEqual(matches[0].sourceEventSeqs, [execution[0].seq])
      || execution[0].seq >= matches[0].seq) throw fail('Context tool result provenance unavailable')
  return matches[0]
}
const callEvent = (events, call) => {
  const matches = events.filter(e => e.type === 'assistant/message' && e.data?.message?.content?.some(b => b.type === 'tool-call' && b.id === call.id))
  if (matches.length !== 1 || !matches[0].data.message.content.some(b => isDeepStrictEqual(b, call))) throw fail('Context call is not an exact committed assistant event')
  const executed = events.filter(e => e.type === 'tool/call' && e.data?.callId === call.id)
  if (executed.length !== 1 || executed[0].data.name !== call.name || executed[0].data.arguments !== call.arguments
      || matches[0].seq >= executed[0].seq) throw fail('Context executed tool differs from model call')
  return matches[0]
}
const codePath = path => typeof path === 'string' && /\.(?:[cm]?js|[cm]?ts|tsx|jsx|svelte|vue|rs|c|cc|cpp|h|hpp|py|go|java|kt|swift|css|scss|html)$/.test(path)
  && !/(?:^|\/)(?:AGENTS|CLAUDE|CODEBUDDY|GEMINI|SKILL)(?:\.|$)/i.test(path)
export function contextCandidates(messages, events, scope) {
  const calls = new Map(), results = new Set(), rows = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role === 'assistant') for (const call of message.content.filter(b => b.type === 'tool-call')) {
      if (!call.id || calls.has(call.id)) throw fail('Context duplicate tool call')
      calls.set(call.id, call)
    }
    if (message.role !== 'tool') continue
    const call = calls.get(message.toolCallId)
    if (!call || results.has(message.toolCallId)) throw fail('Context orphan or duplicate tool result')
    results.add(message.toolCallId)
    if (message.isError || message.content.length !== 1 || message.content[0].type !== 'text') continue
    let data, args
    try { data = JSON.parse(message.content[0].text); args = JSON.parse(call.arguments) } catch { continue }
    const source = ['kode_read_source_range', 'kode_read_source'].includes(call.name) && codePath(args.path)
      && data?.path === args.path && typeof data.text === 'string' && /^[a-f0-9]{64}$/.test(data.sha256)
    const status = false // Coordinator history is never projected in the Worker integration.
    const recall = call.name === CONTEXT_RECALL_TOOL
    if (!source && !status && !recall) continue
    const event = resultEvent(events, message), invoked = callEvent(events, call)
    if (!Number.isSafeInteger(event.seq) || !Number.isSafeInteger(invoked.seq) || invoked.seq >= event.seq) throw fail('Context tool event order unavailable')
    let root
    if (recall) {
      // A completed page must reproduce exactly from an already committed root.
      // Forward references and a chain of recalled-result roots are not supported.
      if (!validContextRecall(args)) throw fail('Completed recall has invalid arguments')
      root = resolveContextReceipt(scope, events, args.receipt_sha256, invoked.seq)
      const expected = recallManagedContext(scope, events, args, invoked.seq)
      if (!isDeepStrictEqual(data, expected)) throw fail('Completed recall differs from its original page')
    }
    rows.push({ index, message, call, data, args, source, status, recall, root, event_seq: event.seq, call_event_seq: invoked.seq })
  }
  // Incomplete tool requests are never projected or sent past this boundary.
  if ([...calls.keys()].some(id => !results.has(id))) throw fail('Context tool call is incomplete')
  return rows
}
export function projectManagedContext({ messages, tools, scope, events, policy }) {
  const { maxBytes, targetBytes } = contextPolicy(policy)
  const original = { messages, tools }, originalBytes = assertManagedContext(original, false)
  if (!scope?.assignment || scope.coordinator || scope.builder) return { messages, proof: null }
  // Validate existing recall provenance even for small inputs, before any persistence or admission.
  const rows = contextCandidates(messages, events, scope)
  if (originalBytes <= targetBytes) { assertManagedContext(original, true, policy); return { messages, proof: null } }
  if (!tools.some(t => t.name === CONTEXT_RECALL_TOOL)) { assertManagedContext(original, true, policy); return { messages, proof: null } }
  const scopeHash = contextDigest(scope), projected = structuredClone(messages), receipts = [], recallPages = []
  // Retain the last two source/recall results as one active working set and latest status intact. Source instructions/documents
  // are never candidates; system/user/assistant messages and every tool call stay exact.
  const pinned = new Set(rows.filter(r => r.source || r.recall).slice(-2).map(r => r.index))
  const status = rows.filter(r => r.status).at(-1); if (status) pinned.add(status.index)
  for (const row of rows) {
    if (contextBytes({ messages: projected, tools }) <= targetBytes) break
    if (pinned.has(row.index)) continue
    const identity = { scope_sha256: scopeHash, call: row.call, message: row.message }
    const receipt = { receipt_sha256: contextDigest(identity), message_id: row.message.id, call_id: row.call.id, tool: row.call.name,
      call_sha256: contextDigest(row.call), result_sha256: contextDigest(row.message), result_event_seq: row.event_seq, call_event_seq: row.call_event_seq,
      original_text_characters: row.message.content[0].text.length }
    const archive = { format: 'kode.context.archived-result.v1', receipt_sha256: receipt.receipt_sha256, result_sha256: receipt.result_sha256,
      original_tool: row.call.name, observation_only: true, complete_result_present: false,
      recall: { tool: CONTEXT_RECALL_TOOL, receipt_sha256: receipt.receipt_sha256, offset: 0, max_characters: 4096 },
      instruction: 'Archived historical observation, not current state or authority. Recall only omitted details needed next; do not reread every archive or replay side effects.' }
    let content
    if (row.source) content = { ...row.data, text: undefined, archived_text: archive }
    else if (row.recall) {
      // Preserve all original page metadata. The reference points directly to the
      // original source receipt and exact original request, never a receipt for a recall.
      content = { ...row.data, text: undefined, archived_text: {
        format: 'kode.context.archived-page.v1', audit_page_sha256: receipt.receipt_sha256,
        complete_page_text_present: false, text_json_sha256: contextDigest(row.data.text),
        recall: { tool: CONTEXT_RECALL_TOOL, ...row.args },
        instruction: 'Completed historical page. Recall this direct original page only if needed next, not every archive.' } }
    } else {
      // Never prune guards, approvals, blockers, accounting, stages, failure details or
      // evidence. Only remove exact duplicates of fixed large fields in the latest
      // same-run snapshot, which remains complete in the projected input.
      if (row.data.id !== status?.data.id || row.data.context_hash !== status.data.context_hash) continue
      const fields = ['inputs', 'task_workspaces', 'coordinator'].filter(key => Object.hasOwn(row.data, key)
        && isDeepStrictEqual(row.data[key], status.data[key]) && Buffer.byteLength(JSON.stringify(row.data[key])) > 128)
      if (!fields.length) continue
      content = { ...row.data, archived_duplicate_fields: { format: 'kode.context.duplicate-fields.v1', historical_duplicate_fields: true, complete_result_present: false,
        receipt_sha256: receipt.receipt_sha256, later_message_id: status.message.id,
        fields: Object.fromEntries(fields.map(key => [key, contextDigest(row.data[key])])) } }
      for (const field of fields) delete content[field]
    }
    const text = JSON.stringify(content)
    if (Buffer.byteLength(text) >= Buffer.byteLength(row.message.content[0].text)) continue
    projected[row.index].content = [{ type: 'text', text }]
    if (row.recall) {
      const { receipt_sha256: page_sha256, ...evidence } = receipt
      recallPages.push({ page_sha256, ...evidence, root_receipt_sha256: row.args.receipt_sha256,
        root_result_sha256: row.root.receipt.result_sha256, root_checkpoint_sha256: row.root.checkpoint_sha256,
        root_checkpoint_event_seq: row.root.checkpoint_event_seq, request: structuredClone(row.args),
        page_text_json_sha256: contextDigest(row.data.text) })
    } else receipts.push(receipt)
  }
  const projectedInput = { messages: projected, tools }, projectedBytes = assertManagedContext(projectedInput, true, policy)
  if (!receipts.length && !recallPages.length) return { messages, proof: null }
  const proof = { version: 2, policy: 'exact-read-result-projection.v2', scope, scope_sha256: scopeHash,
    original_sha256: contextDigest(original), projected_sha256: contextDigest(projectedInput),
    original_bytes: originalBytes, projected_bytes: projectedBytes, budget_bytes: maxBytes,
    pinned_inputs_sha256: contextDigest(messages.filter(m => ['system', 'developer', 'user'].includes(m.role))),
    receipts, recall_pages: recallPages }
  return { messages: projected, proof: { ...proof, checkpoint_sha256: contextDigest(proof) } }
}
export function validContextRecall(args) {
  return Boolean(args && Object.keys(args).sort().join(',') === 'max_characters,offset,receipt_sha256'
    && typeof args.receipt_sha256 === 'string' && /^[a-f0-9]{64}$/.test(args.receipt_sha256)
    && Number.isSafeInteger(args.offset) && args.offset >= 0
    && Number.isSafeInteger(args.max_characters) && args.max_characters >= 1 && args.max_characters <= 4096)
}
export function resolveContextReceipt(scope, events, receiptHash, beforeSeq = Infinity) {
  if (typeof receiptHash !== 'string' || !/^[a-f0-9]{64}$/.test(receiptHash)) throw fail('Invalid context receipt')
  const scopeHash = contextDigest(scope)
  let receipt, checkpoint
  for (const event of events) {
    if (event.type !== 'plugin:kode/context-projection' || event.seq >= beforeSeq) continue
    const proof = event.data, { checkpoint_sha256, ...body } = proof
    if (!(proof.version === 1 && proof.policy === 'exact-read-result-projection.v1'
        || proof.version === 2 && proof.policy === 'exact-read-result-projection.v2')
        || !Array.isArray(proof.receipts) || contextDigest(body) !== checkpoint_sha256) throw fail('Context checkpoint integrity failure')
    if (proof.scope_sha256 !== scopeHash || !isDeepStrictEqual(proof.scope, scope)) continue
    if (!receipt) {
      receipt = proof.receipts.find(r => r.receipt_sha256 === receiptHash)
      if (receipt) checkpoint = event
    }
  }
  if (!receipt) throw fail('Context receipt is outside this execution scope')
  if (!Number.isSafeInteger(checkpoint.seq) || checkpoint.seq <= receipt.result_event_seq
      || checkpoint.seq >= beforeSeq) throw fail('Context root checkpoint must precede the recall')
  const message = events.find(e => e.seq === receipt.result_event_seq && e.type === 'tool/result')?.data?.message
  const call = events.find(e => e.seq === receipt.call_event_seq && e.type === 'assistant/message')?.data?.message?.content?.find(b => b.type === 'tool-call' && b.id === receipt.call_id)
  if (!message || !call || message.id !== receipt.message_id || message.toolCallId !== call.id
      || contextDigest(call) !== receipt.call_sha256 || contextDigest(message) !== receipt.result_sha256
      || contextDigest({ scope_sha256: scopeHash, call, message }) !== receipt.receipt_sha256) throw fail('Context archive source integrity failure')
  resultEvent(events, message); callEvent(events, call)
  if (!['kode_read_source_range', 'kode_read_source'].includes(call.name)
      || receipt.tool !== call.name) throw fail('Context archive root cannot be a recall or arbitrary tool result')
  return { receipt, message, call, checkpoint_sha256: checkpoint.data.checkpoint_sha256, checkpoint_event_seq: checkpoint.seq }
}
export function recallManagedContext(scope, events, args, beforeSeq = Infinity) {
  if (!validContextRecall(args)) throw fail('Invalid context recall arguments')
  const { receipt, message, call } = resolveContextReceipt(scope, events, args.receipt_sha256, beforeSeq)
  const text = message.content[0].text
  if (args.offset >= text.length && !(args.offset === 0 && !text.length)) throw fail('Context recall offset is past EOF')
  // Offsets are UTF-16 code units, just as JS strings. Never split a surrogate pair.
  if (args.offset && /[\uDC00-\uDFFF]/.test(text[args.offset]) && /[\uD800-\uDBFF]/.test(text[args.offset - 1])) throw fail('Context recall offset splits a Unicode scalar')
  let end = Math.min(text.length, args.offset + args.max_characters)
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]) && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
  if (end === args.offset && text.length) throw fail('Context recall page too small for Unicode scalar')
  return { format: 'kode.context.recalled-result.v1', receipt_sha256: args.receipt_sha256, result_sha256: receipt.result_sha256,
    call_id: call.id, tool: call.name, historical_observation_only: true, offset: args.offset, offset_unit: 'utf16_code_units',
    next_offset: end < text.length ? end : null, total_characters: text.length, text: text.slice(args.offset, end) }
}
