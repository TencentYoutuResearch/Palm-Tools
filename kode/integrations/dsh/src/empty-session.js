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
export async function classifyEmptySessions(controller, items) {
  if (!controller.inspect) return items
  const result = []
  // Bound cold reads; never activate an Agent and never hide a failed read.
  for (let offset = 0; offset < items.length; offset += 4) result.push(...await Promise.all(items.slice(offset, offset + 4).map(async row => {
    if (!needsEmptySessionCheck(row)) return row
    try { return setupOnlySession(await controller.inspect(row.sessionId)) ? { ...row, blank: true } : row }
    catch { return row }
  })))
  return result
}
