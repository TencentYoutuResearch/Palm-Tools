/** Opt-in private, selective evidence for disposable live tests; never archive credentials or prompts. */
import { mkdir, mkdtemp, writeFile, rename } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:[\]-]{1,256}$/.test(value) ? value : null
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const errorCode = value => typeof value === 'number' ? count(value) : identifier(value)
const bool = value => typeof value === 'boolean' ? value : null
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
const pick = (value, keys, normalize = identifier) => Object.fromEntries(keys.map(key => [key, normalize(value?.[key])]))
const outputMap = value => Object.fromEntries(Object.entries(value ?? {}).slice(0, 128)
  .filter(([key, sequence]) => identifier(key) && count(sequence) !== null))
const operation = value => ({ id: identifier(value?.id), attempt: count(value?.attempt), epoch: count(value?.epoch), home_node: identifier(value?.home_node) })
const usage = value => value == null ? null : pick(value,
  ['input_tokens', 'cached_input_tokens', 'output_tokens', 'cache_write_input_tokens'], count)
const stopped = value => value == null ? null : {
  ...pick(value, ['spawned', 'leader_exited', 'process_group_empty', 'descendants_confirmed'], bool),
  signal_scope: identifier(value.signal_scope), signal_failure_count: Array.isArray(value.signal_failures) ? value.signal_failures.length : null,
}
const failure = value => value == null ? null : ({
  name: ['Error', 'TypeError', 'AssertionError', 'AbortError', 'TimeoutError'].includes(value.name) ? value.name : 'Error',
  code: errorCode(value.code),
})
export function liveFailureDetails(value) {
  return value == null ? null : { ...pick(value, ['phase', 'transport_code', 'stream_failure_side']),
    upstream_status: count(value.upstream_status), ...pick(value, ['upstream_complete', 'downstream_complete', 'cancelled'], bool) }
}
function delivery(value) {
  if (!value) return null
  return { ...pick(value, ['run_id', 'basis', 'delivery_kind', 'integration_state']),
    ...pick(value, ['run_revision', 'at'], count), ...pick(value, ['completion_authorized', 'original_workspace_modified'], bool),
    context_hash: hash(value.context_hash), authorization_hash: hash(value.authorization_hash),
    outputs: outputMap(value.outputs),
    artifacts: Object.entries(value.artifacts ?? {}).slice(0, 128).filter(([name]) => identifier(name)).map(([name, row]) => ({
      name, repository_binding: identifier(row.repository_binding), sequence: count(row.sequence), archive_hash: hash(row.archive_hash), bytes: count(row.bytes),
    })),
  }
}
function runSummary(run) {
  return { ...pick(run, ['id', 'home_hub', 'team_id', 'state', 'waiting_reason']), revision: count(run.revision),
    context_hash: hash(run.context_hash), authorization_hash: hash(run.authorization?.snapshot_hash),
    completion_authorized: bool(run.completion_authorized), delivery: delivery(run.delivery),
    stages: (run.stages ?? []).slice(0, 128).map(stage => ({ ...pick(stage, ['stage_id', 'assignment_id', 'state']),
      attempt: count(stage.attempt), outputs: outputMap(stage.evidence?.outputs),
      completion: stage.completion ? { ...pick(stage.completion, ['stage_passed', 'resources_released', 'completion_authorized'], bool), at: count(stage.completion.at) } : null,
    })),
  }
}
function messageReceipt(message) {
  const content = typeof message.content === 'string' ? message.content : ''
  return { ...pick(message, ['id', 'home_hub', 'team_id', 'conversation_id', 'in_reply_to', 'prior_run_id']),
    sequence: count(message.sequence), created_at: count(message.created_at),
    actor: pick(message.actor, ['kind', 'id']),
    content_sha256: createHash('sha256').update(content).digest('hex'), content_bytes: Buffer.byteLength(content),
  }
}
function decisionRecord(record, event) {
  const data = record.data
  const configuration = data.configuration
  return { type: record.type, sequence: count(event.seq), time: count(event.time), call_id: identifier(data.call_id),
    operation: operation(data.operation),
    configuration: { model: identifier(configuration?.model), reasoning_effort: identifier(configuration?.reasoningEffort),
      native_thread_id: identifier(configuration?.native_thread_id), model_provider: identifier(configuration?.modelProvider),
      inference_verified: bool(configuration?.inference_verified) },
    ...(record.type === 'plugin:kode/managed-cli-decision' ? {
      outcome: identifier(data.outcome), terminal: identifier(data.terminal), usage: usage(data.usage), stop: stopped(data.stop),
      failure_code: errorCode(data.failure_code), transport_completion: identifier(data.transport_completion),
      failure_details: liveFailureDetails(data.failure_details),
    } : {}),
  }
}
function sessionSummary(session, binding, events, run) {
  const records = events.map(event => ({ event, record: pluginRecordOf(event) }))
    .filter(({ record }) => ['plugin:kode/managed-cli-start', 'plugin:kode/managed-cli-decision'].includes(record?.type))
  const stage = run?.stages?.find(row => row.assignment_id === binding.managedAssignment?.id)
  return { session_id: identifier(session), role: binding.managedCoordinator ? 'coordinator' : identifier(stage?.stage_id) ?? 'worker',
    assignment_id: identifier(binding.managedAssignment?.id), operation: operation(binding.managedOperation),
    operation_closed: bool(binding.operationClosed), stop_blocked: bool(binding.stopBlocked),
    assignment_stop: binding.assignmentStop ? { state: identifier(binding.assignmentStop.state), observed_at: count(binding.assignmentStop.observed_at) } : null,
    last_record_type: identifier(events.at(-1)?.type), event_count: events.length, events_may_be_truncated: events.length === 4096,
    records: records.map(({ record, event }) => decisionRecord(record, event)),
    tools: events.filter(event => event.type === 'tool/call').slice(0, 1024).map(event => ({
      sequence: count(event.seq), time: count(event.time), name: identifier(event.data?.name),
      arguments_sha256: createHash('sha256').update(typeof event.data?.arguments === 'string' ? event.data.arguments : '').digest('hex'),
    })),
    named_outputs: Object.entries(binding.assignmentOutputs?.outputs ?? {}).slice(0, 128)
      .filter(([name]) => identifier(name)).map(([name, row]) => ({ name, evidence_id: identifier(row.evidence_id), sequence: count(row.sequence) })),
    tool_states: Object.values(binding.officialTools ?? {}).slice(0, 512).map(row => ({
      tool: identifier(row.tool), status: identifier(row.status), reason: identifier(row.reason), home_reconciled: bool(row.home_reconciled),
    })),
    archives: Object.values(binding.artifactOutbox ?? {}).slice(0, 256).map(row => ({
      evidence_id: identifier(row.evidence?.id), kind: identifier(row.evidence?.payload?.kind),
      sequence: count(row.home_sequence), home_reconciled: bool(row.home_reconciled), home_archive_reconciled: bool(row.home_archive_reconciled),
      snapshot_hash: hash(row.evidence?.payload?.snapshot_hash),
    })),
  }
}

/** Capture failures return a diagnostic result; they must never replace the test's original exception. */
export function createLiveEvidenceRecorder({ directory, team, profiles, ctx, call, diagnostic = () => {} }) {
  if (!directory) return null
  let target, next = 0, runId, chain = Promise.resolve()
  const capture = async (phase, { run, error } = {}) => {
    const warnings = []
    const read = async (label, fn) => {
      let timer
      const abort = new AbortController()
      try { return await Promise.race([fn(abort.signal), new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error('Evidence read deadline'); abort.abort(error); reject(error) }, 2000) })]) }
      catch { warnings.push(label); return undefined }
      finally { clearTimeout(timer); abort.abort() }
    }
    try {
      if (!isAbsolute(directory)) throw new Error('Absolute evidence destination required')
      if (!target) { await mkdir(directory, { recursive: true, mode: 0o700 }); target = await mkdtemp(join(directory, 'live-evidence-')) }
      if (!identifier(phase) || next >= 128) throw new Error('Evidence checkpoint limit')
      if (run?.team_id === team.id) runId = run.id
      if (!runId) {
        const page = await read('run_directory_unavailable', signal => call('work-runs/active', undefined, signal))
        runId = page?.items?.find(row => row.team_id === team.id)?.id
      }
      const current = runId ? await read('run_unavailable', signal => call(`work-runs/${encodeURIComponent(runId)}`, undefined, signal)) : undefined
      if (current?.team_id === team.id && current.home_hub === team.home_hub) run = current
      else if (current) { warnings.push('run_scope_mismatch'); run = undefined }
      if (run && (run.team_id !== team.id || run.home_hub !== team.home_hub)) { warnings.push('run_scope_mismatch'); run = undefined }
      const runSource = run ? current === run ? 'home_read' : 'supplied_checkpoint' : 'unavailable'
      const messages = []
      let after = 0, conversationComplete = false
      for (let i = 0; i < 8; i++) {
        const page = await read('conversation_unavailable', signal => call(`conversations/${encodeURIComponent(team.conversation_id)}/messages?after=${after}&limit=50`, undefined, signal))
        if (!page) break
        if (page.home_hub !== team.home_hub || page.team_id !== team.id || page.conversation_id !== team.conversation_id || !Array.isArray(page.items)) { warnings.push('conversation_scope_mismatch'); break }
        const items = page.items.slice(0, 50)
        let previous = after
        const seen = new Set(messages.map(row => row.id))
        if (items.some(row => { const invalid = row.team_id !== team.id || row.conversation_id !== team.conversation_id || row.home_hub !== team.home_hub || !identifier(row.id) || seen.has(row.id) || count(row.sequence) === null || row.sequence <= previous; previous = row.sequence; seen.add(row.id); return invalid })) { warnings.push('message_scope_or_cursor_mismatch'); break }
        messages.push(...items.map(messageReceipt))
        if (!page.has_more) { conversationComplete = true; break }
        const cursor = items.at(-1)?.sequence
        if (!cursor || cursor <= after) { warnings.push('conversation_cursor_stalled'); break }
        after = cursor
      }
      const sessions = []
      for (const [session, binding] of Object.entries(profiles?.bindings ?? {})) {
        if (!binding.managedCoordinator && !binding.managedAssignment) continue
        if (binding.managedCoordinator && binding.managedCoordinator.team_id !== team.id) continue
        // Only this run's Workers belong in the evidence bundle.
        if (binding.managedAssignment && !run?.stages?.some(stage => stage.assignment_id === binding.managedAssignment.id)) continue
        const summary = await read('session_unavailable', async signal => {
          let reader
          try { reader = await ctx.sessionPersistence.open(session, 'read', { signal }); return sessionSummary(session, binding, (await reader.read(0, 4096, { signal })).events, run) }
          finally { await reader?.close() }
        })
        if (summary) sessions.push(summary)
      }
      const snapshot = { schema_version: 1, phase, captured_at: Date.now(), source: 'disposable_live_test_selective_evidence',
        team_id: identifier(team.id), home_hub: identifier(team.home_hub), conversation_id: identifier(team.conversation_id),
        original_failure: failure(error), run_snapshot_source: runSource, run: run ? runSummary(run) : null,
        conversation: { complete: conversationComplete, receipts: messages }, sessions, warnings,
        privacy: { prompts: false, message_content: false, tool_payloads: false, credentials: false, profile_environment: false } }
      const file = `${String(next++).padStart(3, '0')}-${phase}.json`, temp = join(target, '.' + file)
      await writeFile(temp, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      await rename(temp, join(target, file))
      const result = { saved: true, directory: target, file, phase, warning_count: warnings.length }
      diagnostic(JSON.stringify({ live_evidence: result }))
      return result
    } catch {
      const result = { saved: false, phase: identifier(phase), reason: 'evidence_capture_failed' }
      try { diagnostic(JSON.stringify({ live_evidence: result })) } catch {}
      return result
    }
  }
  return { capture(phase, state) {
    const result = chain.then(() => capture(phase, state))
    chain = result.catch(() => {})
    return result
  } }
}
