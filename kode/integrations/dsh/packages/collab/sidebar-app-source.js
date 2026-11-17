/** Actual frontend panel registrations are navigation targets, not account or installation status. */
export const BASE_APPLICATION_PANELS = new Set(['plugins', 'kode-settings', 'schedules'])
export const APPLICATION_CONNECTION_NOTE = 'TAPD / Git 的连接状态尚未接入此列表。'
const SLOT = 'sidebar.panellist'
const EMPTY = Object.freeze([])

/** Keep the registry's order, including equal-order entries; never invent panels from package names. */
export function sidebarApplications(slots) {
  const entries = typeof slots?.entriesOfSlot === 'function' ? slots.entriesOfSlot(SLOT) : slots?.entries?.(SLOT) ?? EMPTY
  const seen = new Set()
  return entries.flatMap(entry => {
    const options = entry.options ?? entry
    const id = options.id
    if (typeof id !== 'string' || !id || BASE_APPLICATION_PANELS.has(id) || seen.has(id)) return []
    seen.add(id)
    let label
    try { label = typeof options.label === 'function' ? options.label() : options.label } catch {}
    return [{ id, order: Number.isFinite(options.order) ? options.order : 0,
      label: typeof label === 'string' && label.trim() ? label : id }]
  })
}

/** Native entriesOfSlot returns a fresh array; cache projected metadata for useSyncExternalStore. */
export function createSidebarAppsSource({ slots, locale }) {
  let snapshot = EMPTY
  const listeners = new Set()
  let disposeSlots, disposeLocale
  const read = () => {
    const next = sidebarApplications(slots)
    if (snapshot.length === next.length && snapshot.every((row, index) => row.id === next[index].id
      && row.label === next[index].label && row.order === next[index].order)) return snapshot
    snapshot = Object.freeze(next.map(row => Object.freeze(row)))
    return snapshot
  }
  const sync = () => {
    const before = snapshot
    read()
    if (before !== snapshot) for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: read,
    subscribe(listener) {
      if (!listeners.size) {
        disposeSlots = slots?.subscribe?.(SLOT, sync)
        disposeLocale = locale?.subscribe?.(sync)
      }
      listeners.add(listener)
      sync()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) { disposeSlots?.(); disposeLocale?.(); disposeSlots = disposeLocale = undefined }
      }
    },
  }
}

/** A registration disappearing between render and click must not open a stale or guessed panel. */
export function openSidebarApplication(ctx, id) {
  if (!sidebarApplications(ctx.slots).some(row => row.id === id)) return false
  if (typeof ctx.layout?.selectPanel !== 'function') return false
  ctx.layout.selectPanel(id)
  return true
}
export function openPluginManagement(ctx) {
  if (typeof ctx.layout?.selectPanel !== 'function') return false
  ctx.layout.selectPanel('plugins')
  return true
}
