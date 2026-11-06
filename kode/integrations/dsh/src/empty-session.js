/** Cold list cache misses are unknown, not proof of an existing conversation. */
const setupEvents = new Set(['permission/preset', 'sandbox/mode', 'approval/policy'])
export function needsEmptySessionCheck(row) {
  return row.blank === false && !row.running && !row.projections?.values?.sessionListMetadata
    && !row.title && !row.projections?.values?.title
}
export function setupOnlySession(inspection) {
  return inspection.inheritedEventCount === 0 && Array.isArray(inspection.events)
    && inspection.events.every(event => setupEvents.has(event.type)
      // A restored empty composer can be sealed without gaining any work.
      // Inherited seed markers still represent a branch and remain visible.
      || event.type === 'session/end-seed' && event.data?.inherited !== true)
}
/** New Hosts expose retained query observations instead of controller.inspect. */
export function sessionInspector(controller, query) {
  if (typeof controller?.inspect === 'function') return (id, signal) => controller.inspect(id, signal)
  if (typeof query?.observeSession !== 'function') return undefined
  return async (id, signal) => {
    const observation = await query.observeSession(id, { signal, projectionMode: 'none' })
    try {
      signal?.throwIfAborted()
      return { header: observation.header, inheritedEventCount: observation.inheritedEventCount, events: [...observation.events] }
    } finally { observation[Symbol.dispose]() }
  }
}
export async function classifyEmptySessions(controller, items, query) {
  const inspect = sessionInspector(controller, query)
  if (!inspect) return items
  const result = []
  // Bound cold reads; never activate an Agent and never hide a failed read.
  for (let offset = 0; offset < items.length; offset += 4) result.push(...await Promise.all(items.slice(offset, offset + 4).map(async row => {
    if (!needsEmptySessionCheck(row)) return row
    try { return setupOnlySession(await inspect(row.sessionId)) ? { ...row, blank: true } : row }
    catch { return row }
  })))
  return result
}
