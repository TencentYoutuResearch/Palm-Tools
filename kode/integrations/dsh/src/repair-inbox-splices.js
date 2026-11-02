/** Repair the old insert-before-remove queue transfer without changing event IDs. */
import { isDeepStrictEqual } from 'node:util'

export function repairNativeInboxSplices(events) {
  const queues = { 'next-turn': [], 'next-step': [] }, changes = []
  const repaired = events.map(event => structuredClone(event))
  for (let index = 0; index < repaired.length; index++) {
    const event = repaired[index]
    if (event.type !== 'agent/inbox/spliced') continue
    let data = event.data
    const source = queues['next-turn']
    const duplicate = data.target === 'next-step' && !data.removedCount && data.inserted.length === 1
      ? source.findIndex(message => message.id === data.inserted[0].id) : -1
    if (duplicate >= 0) {
      if (!isDeepStrictEqual(source[duplicate], data.inserted[0])) throw new Error('Duplicate pending messages have different content')
      const later = repaired.slice(index + 1).find(row => row.type === 'agent/inbox/spliced')
      if (later && later.data.target === 'next-turn' && later.data.start === duplicate && later.data.removedCount === 1 && !later.data.inserted.length && !later.data.outcome) {
        const insertion = data
        event.data = later.data; later.data = insertion; data = event.data
        changes.push({ seq: event.seq, removalSeq: later.seq, action: 'remove-before-insert' })
      } else if (!later && !repaired.slice(index + 1).some(row => row.type === 'user/message' && row.data.id === data.inserted[0].id)) {
        // Projection failure prevented transfer and admission. Retain the original
        // next-turn input, annotate the redundant insertion for audit.
        event.type = 'plugin:kode/inbox-splice-repair'; event.ignorable = true
        event.data = { originalType: 'agent/inbox/spliced', originalData: data, reason: 'duplicate-unclaimed-transfer' }
        changes.push({ seq: event.seq, action: 'retain-original-queue' })
        continue
      } else throw new Error('Ambiguous duplicate queue transfer; refusing automatic repair')
    }
    const rows = queues[data.target], count = data.removedCount ?? 0
    if (!rows || !Number.isSafeInteger(data.start) || data.start < 0 || data.start > rows.length || !Number.isSafeInteger(count) || count < 0 || data.start + count > rows.length) throw new Error(`Invalid inbox splice at ${event.seq}`)
    rows.splice(data.start, count, ...data.inserted)
    const ids = [...queues['next-turn'], ...queues['next-step']].map(message => message.id)
    if (new Set(ids).size !== ids.length) throw new Error(`Unrecognized duplicate inbox splice at ${event.seq}`)
  }
  return { events: changes.length ? repaired : events, changes }
}
