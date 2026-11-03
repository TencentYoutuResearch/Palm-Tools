/** Preserve a misplaced harness system prompt without treating it as native CLI history. */
export function repairNativeSystemHeads(events) {
  let surface = false, protectedHead = false, provider, native = false
  const changes = []
  const repaired = events.map(event => {
    if (event.type === 'model/selection') provider = event.data?.provider
    if (event.type === 'request/header') provider = event.data?.header?.config?.provider
    if (event.type === 'plugin:kode/native-event') native = true
    if (!event.surfaceOp) return event
    if (event.type === 'system/message' && surface && !protectedHead && native && provider?.startsWith('kode-agent-') && event.surfaceOp === 'append' && event.data?.message?.source?.kind === 'system-prompt') {
      changes.push({ seq: event.seq, action: 'preserve-misplaced-native-system-head' })
      const result = { ...event, type: 'plugin:kode/system-head-repair', ignorable: true, data: { originalEvent: structuredClone(event) } }
      delete result.surfaceOp
      return result
    }
    if (!surface) protectedHead = event.type === 'system/message'
    surface = true
    return event
  })
  return { events: changes.length ? repaired : events, changes }
}
