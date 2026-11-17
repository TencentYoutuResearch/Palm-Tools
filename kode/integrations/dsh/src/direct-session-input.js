import { randomUUID } from 'node:crypto'
/** Interrupt-and-insert is not steering. Never replay an uncertain stop/insertion. */
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
const failure = (message, code) => Object.assign(new Error(message), { code })
export function assertDirectInsertAvailable(agent, owned = false) {
  const binding = agent.runtime?.profiles?.binding(agent.id)
  if (!agent.isKodeNativeAgent || agent.disposed || !owned && (agent.maintenance || agent.directInsertPending) || agent.directInsertBlocked
      || binding?.managedOperation || binding?.managedBuilder || binding?.managedCoordinator || binding?.managedAssignment
      || agent.runtime?.adapter?.stopBlocked?.(agent.id)) throw failure('Direct insertion is unavailable for this session; no input was submitted', 'DIRECT_INSERT_UNSUPPORTED')
}
export async function interruptAndInsert(agent, message, { signal, timeoutMs = 30000, beforeInsert, recordEvent = appendPluginRecord } = {}) {
  assertDirectInsertAvailable(agent)
  if (!message?.id) throw failure('Direct insertion requires a stable input identity', 'DIRECT_INSERT_UNSUPPORTED')
  signal?.throwIfAborted()
  const events = () => agent.session.snapshotEvents()
  const prior = events().findLast(e => e.type === 'plugin:kode/direct-insert' && e.data.inputId === message.id)
  if (prior) {
    if (prior.data.stage === 'inserted') return { state: 'inserted', replay: true, interrupted: prior.data.interrupted }
    throw failure('Earlier direct insertion has an uncertain outcome; inspect it before retrying', 'DIRECT_INSERT_UNCERTAIN')
  }
  let running = agent.status === 'running'
  agent.directInsertPending = true
  agent.maintenance = true // Hold existing queues while cancellation settles.
  let timer, admitted = false, inserted = false
  const record = (stage, extra = {}) => recordEvent(agent.session, 'plugin:kode/direct-insert', { inputId: message.id, stage, interrupted: running, ...extra })
  try {
    const intent = record('prepared')
    await agent.ctx.sessions.flush(agent.session)
    await beforeInsert?.() // Re-authorize immediately before any stop, not only before insertion.
    signal?.throwIfAborted()
    assertDirectInsertAvailable(agent, true)
    running = agent.status === 'running'
    if (running) {
      admitted = true
      agent.cancel({ kind: 'direct_insert', inputId: message.id }, { keepInbox: true })
      record('stop_requested')
      await agent.ctx.sessions.flush(agent.session)
      await Promise.race([agent.whenIdle(), new Promise((_, reject) => { timer = setTimeout(() => reject(failure('Direct insertion stop timed out; no replacement input submitted', 'DIRECT_INSERT_UNCERTAIN')), timeoutMs) })])
      const stopped = events().findLast(e => e.seq > (typeof intent === 'number' ? intent : intent.seq) && e.type === 'plugin:kode/native-event' && e.data.event?.method === 'kode/process_stop')?.data.event.params
      const boundary = events().findLast(e => e.type === 'turn/start' || e.type === 'turn/end')
      if (!stopped && boundary?.type === 'turn/end' && boundary.data.reason?.kind === 'completed') {
        running = false // The original turn finished naturally before cancellation took effect.
        record('completed_before_stop')
      } else {
        if (!stopped || stopped.stopBlocked || stopped.signal_failures?.length || stopped.spawned && (!stopped.leader_exited || stopped.signal_scope !== 'process_group' || stopped.process_group_empty !== true)) throw failure('Native process stop is unconfirmed; no replacement input submitted', 'DIRECT_INSERT_UNCERTAIN')
        record('stop_confirmed')
      }
    }
    if (agent.disposed || agent.runtime.adapter.stopBlocked?.(agent.id)) throw failure('Session became unavailable during direct insertion', 'DIRECT_INSERT_UNCERTAIN')
    await beforeInsert?.()
    signal?.throwIfAborted()
    assertDirectInsertAvailable(agent, true)
    // Priority applies to this one input only; keep every existing queue entry.
    inserted = true
    agent.inbox.prepend('next-turn', message)
    record('inserted')
    await agent.ctx.sessions.flush(agent.session)
    agent.parked = false
    return { state: 'inserted', interrupted: running }
  } catch (error) {
    if (!admitted && !inserted) {
      record('rejected', { reason: error.code ?? 'preparation_failed' })
      await agent.ctx.sessions.flush(agent.session).catch(() => {})
      throw error
    }
    agent.parked = true // A later followup must not clear an unconfirmed-stop fence.
    agent.directInsertBlocked = true
    if (typeof agent.runtime.profiles?.patchBinding === 'function') {
      try {
        const fenceId = randomUUID()
        await agent.runtime.profiles.patchBinding(agent.id, { stopBlocked: true, stopFenceId: fenceId, directInsertFenceId: fenceId })
      } catch { /* Keep the in-memory fence if persistence itself failed. */ }
    }
    record('uncertain', { reason: error.code ?? (admitted ? 'stop_or_insert_unconfirmed' : 'preparation_failed') })
    await agent.ctx.sessions.flush(agent.session).catch(() => {})
    if (error.code === 'DIRECT_INSERT_UNSUPPORTED') error.code = 'DIRECT_INSERT_UNCERTAIN'
    throw error
  } finally {
    clearTimeout(timer); agent.directInsertPending = false; agent.maintenance = false; agent.wake()
  }
}
