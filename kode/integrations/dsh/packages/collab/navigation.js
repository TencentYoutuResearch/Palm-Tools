/** Main-view navigation only. A unified sidebar never intercepts native Session creation. */
export function installCollabNavigation({ workspace, layout, view, panelId = 'kode-collab' }) {
  if (typeof workspace?.startSession !== 'function' || typeof layout?.selectPanel !== 'function') throw new Error('Collaboration navigation unavailable')
  let disposed = false
  const selectMode = (mode, { showPanel = true } = {}) => {
    if (disposed) throw new Error('Collaboration navigation disposed')
    if (!['im', 'session'].includes(mode)) throw new Error('Invalid view mode')
    // Kept as a compatibility verb for saved navigation and read-only Run deep links.
    // It selects the main view; it cannot hide a sidebar group or create a Session.
    if (showPanel) layout.selectPanel(mode === 'im' ? panelId : null)
    view.setMode(mode)
  }
  return { selectMode, dispose() { disposed = true } }
}
