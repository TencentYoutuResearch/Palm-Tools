/** Install on the original Cordis target: traced method reads do not preserve identity. */
export function installCollabNavigation({ workspace, originalSymbol, layout, view, openBuilder, panelId = 'kode-collab' }) {
  const target = workspace?.[originalSymbol] ?? workspace
  if (!target || typeof target.startSession !== 'function' || typeof layout?.selectPanel !== 'function'
    || typeof openBuilder !== 'function') throw new Error('Collaboration navigation unavailable')
  const descriptor = Object.getOwnPropertyDescriptor(target, 'startSession')
  const original = target.startSession
  let disposed = false
  const selectMode = mode => {
    if (disposed) throw new Error('Collaboration navigation disposed')
    if (!['im', 'session'].includes(mode)) throw new Error('Invalid view mode')
    // A missing main registration must leave the previous mode intact.
    layout.selectPanel(mode === 'im' ? panelId : null)
    view.setMode(mode)
  }
  const wrapper = function (...args) {
    if (disposed || view.getSnapshot().mode !== 'im') return original.apply(this, args)
    if (args.every(arg => arg === undefined)) return openBuilder()
    // An explicit workspace/draft action still means a Session action. Preserve its payload.
    selectMode('session')
    return original.apply(this, args)
  }
  Object.defineProperty(target, 'startSession', { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false, value: wrapper })
  return {
    selectMode,
    dispose() {
      if (disposed) return
      disposed = true
      if (Object.getOwnPropertyDescriptor(target, 'startSession')?.value === wrapper) {
        if (descriptor) Object.defineProperty(target, 'startSession', descriptor)
        else delete target.startSession
      }
    },
  }
}
