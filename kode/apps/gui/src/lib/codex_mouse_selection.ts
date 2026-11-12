/** Distinguish Codex TUI clicks from terminal text selection drags. */
type MouseSelectionTerminal = {
  element: HTMLElement | null
  modes: { mouseTrackingMode: string }
  cols: number
  rows: number
  buffer: { active: { viewportY: number } }
  select: (column: number, row: number, length: number) => void
  selectLines: (start: number, end: number) => void
  clearSelection: () => void
  _core?: {
    _selectionService?: {
      _selectWordAtCursor: (event: MouseEvent, allowWhitespaceOnlySelection: boolean) => boolean
    }
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
type Gesture = { down: MouseEvent; target: Element; start: Cell; detail: number; dragging: boolean }
type Scheduler = {
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}
type InstallOptions = {
  now?: () => number
  scheduler?: Scheduler
  forwardSingleClicks?: boolean
  getBackendKey?: () => string
  safeMouseMode?: boolean
  deferSingleClickMs?: number
}
const DRAG_DISTANCE_SQUARED = 25
export const CODEX_MULTI_CLICK_MS = 500
const MULTI_CLICK_MS = CODEX_MULTI_CLICK_MS
const MULTI_CLICK_DISTANCE_SQUARED = 16
const SINGLE_CLICK_FORWARD_DELAY_MS = CODEX_MULTI_CLICK_MS + 50
const defaultScheduler: Scheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function isTcodexMouseBackend(backendKey: string): boolean {
  const normalized = backendKey.trim().toLowerCase()
  return normalized === 'tcodex' || normalized.endsWith(':tcodex')
}

export function supportsCodexMouseSelection(backendKey: string): boolean {
  const normalized = backendKey.trim().toLowerCase()
  return normalized === 'codex' || normalized.endsWith(':codex') || isTcodexMouseBackend(normalized)
}

export function installCodexMouseSelection(
  host: HTMLElement,
  term: MouseSelectionTerminal,
  options: InstallOptions = {},
): () => void {
  const {
    now = () => performance.now(),
    scheduler = defaultScheduler,
    forwardSingleClicks = true,
    getBackendKey,
    safeMouseMode = false,
    deferSingleClickMs = SINGLE_CLICK_FORWARD_DELAY_MS,
  } = options
  const doc = host.ownerDocument
  let pending: Gesture | null = null
  let deferredClick: { gesture: Gesture; up: MouseEvent; timer: unknown } | null = null
  let replaying = false
  let lastClick: { at: number; x: number; y: number; detail: number } | null = null

  function currentBackendKey(): string | null {
    const key = getBackendKey?.().trim()
    return key ? key : null
  }

  function currentBackendSupportsSelection(): boolean {
    const key = currentBackendKey()
    return key === null || supportsCodexMouseSelection(key)
  }

  function currentBackendForwardsSingleClicks(): boolean {
    const key = currentBackendKey()
    return forwardSingleClicks
      && (!safeMouseMode || key === null || !isTcodexMouseBackend(key))
  }

  function clickDetail(event: MouseEvent): number {
    const previous = lastClick
    if (previous) {
      const dx = event.clientX - previous.x
      const dy = event.clientY - previous.y
      const elapsed = now() - previous.at
      if (
        elapsed >= 0
        && elapsed <= CODEX_MULTI_CLICK_MS
        && dx * dx + dy * dy <= MULTI_CLICK_DISTANCE_SQUARED
      ) {
        return Math.max(2, Math.min(3, previous.detail + 1), event.detail)
      }
    }
    return Math.max(1, event.detail)
  }

  function cellAt(event: MouseEvent, selectionEnd: boolean): Cell | null {
    const element = term.element
    const coords = element && term._core?._mouseService?.getCoords(
      event, element, term.cols, term.rows, selectionEnd,
    )
    if (!coords) return null
    return { col: coords[0] - 1, row: term.buffer.active.viewportY + coords[1] - 1 }
  }

  function selectTo(event: MouseEvent, gesture: Gesture) {
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
    clearDeferredClick()
    removeDocumentListeners()
  }

  function replayClick(gesture: Gesture, up: MouseEvent) {
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

  function clearDeferredClick() {
    if (!deferredClick) return
    scheduler.clearTimeout(deferredClick.timer)
    deferredClick = null
  }

  function flushDeferredClick() {
    const deferred = deferredClick
    if (!deferred) return
    scheduler.clearTimeout(deferred.timer)
    deferredClick = null
    replayClick(deferred.gesture, deferred.up)
  }

  function deferSingleClick(gesture: Gesture, up: MouseEvent) {
    clearDeferredClick()
    if (deferSingleClickMs <= 0) {
      replayClick(gesture, up)
      return
    }
    const deferred: NonNullable<typeof deferredClick> = {
      gesture,
      up,
      timer: undefined,
    }
    deferredClick = deferred
    deferred.timer = scheduler.setTimeout(() => {
      if (deferredClick !== deferred) return
      deferredClick = null
      replayClick(gesture, up)
    }, SINGLE_CLICK_FORWARD_DELAY_MS)
  }

  function selectClickIntent(gesture: Gesture) {
    if (gesture.detail >= 3) {
      term.selectLines(gesture.start.row, gesture.start.row)
      return
    }
    if (gesture.detail === 2 && term._core?._selectionService?._selectWordAtCursor(
      gesture.down,
      true,
    )) {
      return
    }
    term.select(gesture.start.col, gesture.start.row, 1)
  }

  function onDown(event: MouseEvent) {
    if (replaying || event.button !== 0 || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
    if (!currentBackendSupportsSelection()) return
    if (term.modes.mouseTrackingMode === 'none' || !term.element?.contains(event.target as Node)) return
    const detail = clickDetail(event)
    const start = cellAt(event, false)
    if (!start || !(event.target instanceof Element)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (detail > 1) clearDeferredClick()
    else flushDeferredClick()
    pending = { down: event, target: event.target, start, detail, dragging: false }
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
    event.stopImmediatePropagation()
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
    event.stopImmediatePropagation()
    cancel()
    if (gesture.dragging) {
      lastClick = null
      selectTo(event, gesture)
      return
    }
    if (gesture.detail > 1) selectClickIntent(gesture)
    else if (currentBackendForwardsSingleClicks()) deferSingleClick(gesture, event)
    else term.clearSelection()
    lastClick = {
      at: now(),
      x: event.clientX,
      y: event.clientY,
      detail: Math.min(3, gesture.detail),
    }
  }

  function suppressTcodexBrowserMultiClick(event: MouseEvent) {
    if (!safeMouseMode) return
    const backendKey = currentBackendKey()
    if (replaying || !backendKey || !isTcodexMouseBackend(backendKey)) return
    if (!term.element?.contains(event.target as Node)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  host.addEventListener('mousedown', onDown, true)
  host.addEventListener('click', suppressTcodexBrowserMultiClick, true)
  host.addEventListener('dblclick', suppressTcodexBrowserMultiClick, true)
  return () => {
    host.removeEventListener('mousedown', onDown, true)
    host.removeEventListener('click', suppressTcodexBrowserMultiClick, true)
    host.removeEventListener('dblclick', suppressTcodexBrowserMultiClick, true)
    clearDeferredClick()
    cancel()
  }
}
