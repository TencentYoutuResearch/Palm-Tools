/** Hide ConPTY's intermediate cursor inside a synchronized redraw.
 * ConPTY can send DECSET 25 before DECRST 2026, then restore the input
 * position in a later packet. Let xterm parse split CSI sequences itself.
 */
export function installConptyCursorGuard(term: any): () => void {
  let synchronized = false
  let suppressedShow = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const release = () => {
    cancel()
    if (!suppressedShow || disposed) return
    suppressedShow = false
    synchronized = false
    term.write('\x1b[?25h')
  }
  const armFallback = () => {
    cancel()
    // Some applications restore their cursor only inside the frame. Do not
    // leave it invisible forever if no post-frame restore arrives.
    timer = setTimeout(release, 250)
  }
  const set = term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params: number[]) => {
    if (params.includes(2026)) {
      synchronized = true
      if (suppressedShow) armFallback()
    }
    if (params.length === 1 && params[0] === 25) {
      if (synchronized) {
        suppressedShow = true
        armFallback()
        return true
      }
      cancel()
      suppressedShow = false
    }
    return false
  })
  const reset = term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params: number[]) => {
    if (params.includes(25)) {
      cancel()
      suppressedShow = false
    }
    if (params.includes(2026)) {
      synchronized = false
      if (suppressedShow) armFallback()
    }
    return false
  })
  return () => {
    disposed = true
    cancel()
    set.dispose()
    reset.dispose()
  }
}
