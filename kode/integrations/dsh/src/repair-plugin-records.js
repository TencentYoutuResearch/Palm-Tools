/** Repair only known optional Kode metadata envelopes; event identity and payload stay intact. */
export function repairPluginRecordEnvelopes(events) {
  const changes = []
  const repaired = events.map(event => {
    if (event.ignorable === true) return event
    const data = event.data
    const fast = event.type === 'plugin:kode/model-fast' && typeof data?.provider === 'string' && typeof data?.model === 'string' && typeof data?.fast === 'boolean'
    const interaction = event.type === 'plugin:kode/shared-interaction' && typeof data?.id === 'string' && data?.kind === 'ask_user_question' && ['open', 'closed'].includes(data?.state)
    if (!fast && !interaction) return event
    changes.push({ seq: event.seq, type: event.type })
    return { ...event, ignorable: true }
  })
  return { events: changes.length ? repaired : events, changes }
}
