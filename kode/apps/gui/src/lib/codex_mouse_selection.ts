/** Distinguish Codex TUI clicks from terminal text selection drags. */
type MouseSelectionTerminal = {
  element: HTMLElement | null
  modes: { mouseTrackingMode: string }
  cols: number
  rows: number
  buffer: { active: { viewportY: number } }
  select: (column: number, row: number, length: number) => void
  _core?: {
    _mouseService?: {
      getCoords: (
        event: MouseEvent,
        element: HTMLElement,
        cols: number,
        rows: number,
        isSelection: boolean,
      ) => [number, number] | undefined
    }
  }
}

type Cell = { col: number; row: number }
const DRAG_DISTANCE_SQUARED = 25

export function installCodexMouseSelection(host: HTMLElement, term: MouseSelectionTerminal): () => void {
  const doc = host.ownerDocument
  let pending: { down: MouseEvent; target: Element; start: Cell; dragging: boolean } | null = null
  let replaying = false

  function cellAt(event: MouseEvent, selectionEnd: boolean): Cell | null {
    const element = term.element
    const coords = element && term._core?._mouseService?.getCoords(
      event, element, term.cols, term.rows, selectionEnd,
    )
    if (!coords) return null
    return { col: coords[0] - 1, row: term.buffer.active.viewportY + coords[1] - 1 }
  }

  function selectTo(event: MouseEvent, gesture: NonNullable<typeof pending>) {
    const end = cellAt(event, true)
    if (!end) return
    const startIndex = gesture.start.row * term.cols + gesture.start.col
    const endIndex = end.row * term.cols + end.col
    const first = Math.min(startIndex, endIndex)
    term.select(first % term.cols, Math.floor(first / term.cols), Math.max(1, Math.abs(endIndex - startIndex)))
  }

  function removeDocumentListeners() {
    doc.removeEventListener('mousemove', onMove, true)
    doc.removeEventListener('mouseup', onUp, true)
    doc.defaultView?.removeEventListener('blur', cancel)
  }

  function cancel() {
    pending = null
    removeDocumentListeners()
  }

  function replayClick(gesture: NonNullable<typeof pending>, up: MouseEvent) {
    const target = gesture.target.isConnected ? gesture.target : term.element
    if (!target) return
    replaying = true
    try {
      for (const [type, source, buttons] of [
        ['mousedown', gesture.down, 1],
        ['mouseup', up, 0],
      ] as const) {
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons,
          clientX: source.clientX,
          clientY: source.clientY,
          detail: source.detail,
        }))
      }
    } finally {
      replaying = false
    }
  }

  function onDown(event: MouseEvent) {
    if (replaying || event.button !== 0 || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
    if (term.modes.mouseTrackingMode === 'none' || !term.element?.contains(event.target as Node)) return
    const start = cellAt(event, false)
    if (!start || !(event.target instanceof Element)) return
    event.preventDefault()
    event.stopPropagation()
    pending = { down: event, target: event.target, start, dragging: false }
    doc.addEventListener('mousemove', onMove, true)
    doc.addEventListener('mouseup', onUp, true)
    doc.defaultView?.addEventListener('blur', cancel, { once: true })
  }

  function onMove(event: MouseEvent) {
    const gesture = pending
    if (!gesture) return
    if (event.buttons === 0) {
      cancel()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (!gesture.dragging) {
      const dx = event.clientX - gesture.down.clientX
      const dy = event.clientY - gesture.down.clientY
      if (dx * dx + dy * dy < DRAG_DISTANCE_SQUARED) return
      gesture.dragging = true
    }
    selectTo(event, gesture)
  }

  function onUp(event: MouseEvent) {
    const gesture = pending
    if (!gesture) return
    event.preventDefault()
    event.stopPropagation()
    cancel()
    if (gesture.dragging) selectTo(event, gesture)
    else replayClick(gesture, event)
  }

  host.addEventListener('mousedown', onDown, true)
  return () => {
    host.removeEventListener('mousedown', onDown, true)
    cancel()
  }
}
