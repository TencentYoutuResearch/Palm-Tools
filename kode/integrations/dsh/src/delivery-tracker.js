/** Durable message/input binding. Recovery observes history; it never resubmits input. */
import { createHash } from 'node:crypto'
const PREFIX = '/api/v1/messaging/'
export const deliveryInputId = messageId => `kode-message-${createHash('sha256').update(messageId).digest('hex')}`
export class DeliveryEvidenceUnavailable extends Error {
  constructor(readable) {
    super(readable ? 'Delivery evidence unavailable; submission outcome remains uncertain' : 'Approximate submission only: runtime event history unavailable; durable queue and consumption unverified')
    this.name = 'DeliveryEvidenceUnavailable'
  }
}
export function createDeliveryTracker(agent, client) {
  let offset = 0
  const queues = { 'next-turn': [], 'next-step': [] }, consumed = new Map()
  function evidence() {
    if (typeof agent.session.snapshotEvents !== 'function') return new Map()
    for (const event of agent.session.snapshotEvents(offset)) {
      offset = event.seq + 1
      if (event.type === 'agent/inbox/spliced' && queues[event.data.target]) {
        const data = event.data
        queues[data.target].splice(data.start, data.removedCount, ...data.inserted.map(m => m.id))
      }
      if (event.type === 'user/message' && event.data.id?.startsWith('kode-message-')) consumed.set(event.data.id, event.seq)
    }
    const result = new Map([...queues['next-turn'], ...queues['next-step']].filter(id => id.startsWith('kode-message-')).map(id => [id, { phase: 'queued', event_seq: null }]))
    for (const [id, event_seq] of consumed) result.set(id, { phase: 'consumed', event_seq })
    return result
  }
  const observe = (messageId, inputId, observation, signal) => client.call(`${PREFIX}messages/${encodeURIComponent(messageId)}/delivery`, {
    session_id: String(agent.id), input_id: inputId, ...observation,
  }, signal)
  return {
    prepare: (message, signal) => observe(message.id, deliveryInputId(message.id), { phase: 'prepared', event_seq: null }, signal),
    confirm: async (message, signal) => {
      const inputId = deliveryInputId(message.id)
      const found = evidence().get(inputId)
      // A readable log with no matching input is ambiguous (for example a
      // concurrent queue removal). Successful submission alone is not evidence.
      if (!found) throw new DeliveryEvidenceUnavailable(typeof agent.session.snapshotEvents === 'function')
      await agent.ctx.parallel('session/flush', agent.session)
      const result = await observe(message.id, inputId, found, signal)
      if (result.phase === 'consumed') consumed.delete(inputId)
      return result
    },
    async recover(signal) {
      const known = evidence()
      if (!known.size) return
      // Session events may be in memory ahead of disk; never publish them before flush.
      await agent.ctx.parallel('session/flush', agent.session)
      let after = ''
      do {
        const page = await client.call(`${PREFIX}sessions/${encodeURIComponent(agent.id)}/deliveries?after=${encodeURIComponent(after)}`, undefined, signal)
        for (const record of page.deliveries) {
          const found = known.get(record.input_id)
          if (found && (record.phase === 'prepared' || found.phase === 'consumed')) {
            const result = await observe(record.message_id, record.input_id, found, signal)
            if (result.phase === 'consumed') consumed.delete(record.input_id)
          }
        }
        after = page.next
      } while (after)
    },
  }
}
