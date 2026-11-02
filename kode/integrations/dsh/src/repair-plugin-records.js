/** Mark only known optional Kode records as ignorable; preserve payloads and IDs. */
const optionalRecordTypes = new Set(['plugin:kode/model-fast'])
export function repairOptionalPluginRecords(events) {
  const changes = []
  const repaired = events.map(event => {
    if (!optionalRecordTypes.has(event.type) || event.ignorable === true) return event
    changes.push({ seq: event.seq, action: 'mark-optional-plugin-record', type: event.type })
    return { ...event, ignorable: true }
  })
  return { events: changes.length ? repaired : events, changes }
}
