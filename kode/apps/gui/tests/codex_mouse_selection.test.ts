import assert from 'node:assert/strict'
import test from 'node:test'
import { installCodexMouseSelection, supportsCodexMouseSelection } from '../src/lib/codex_mouse_selection.ts'

class FakeMouseEvent extends Event {
  button: number
  buttons: number
  clientX: number
  clientY: number
  detail: number
  altKey = false
  metaKey = false
  ctrlKey = false
  shiftKey = false

  constructor(type: string, props: { clientX: number; clientY: number; button?: number; buttons?: number; detail?: number }) {
    super(type, { bubbles: true, cancelable: true })
    this.button = props.button ?? 0
    this.buttons = props.buttons ?? 0
    this.clientX = props.clientX
    this.clientY = props.clientY
    this.detail = props.detail ?? 1
  }
}

class FakeElement extends EventTarget {
  isConnected = true
  ownerDocument = Object.assign(new EventTarget(), { defaultView: new EventTarget() })
  contains(target: EventTarget) { return target === this }
}

Object.assign(globalThis, { Element: FakeElement, MouseEvent: FakeMouseEvent })

function setup() {
  const host = new FakeElement()
  const selections: Array<[number, number, number]> = []
  const lineSelections: Array<[number, number]> = []
  let wordSelections = 0
  const terminal = {
    element: host,
    modes: { mouseTrackingMode: 'drag' },
    cols: 80,
    rows: 24,
    buffer: { active: { viewportY: 0 } },
    select: (col: number, row: number, length: number) => selections.push([col, row, length]),
    selectLines: (start: number, end: number) => lineSelections.push([start, end]),
    _core: {
      _selectionService: {
        _selectWordAtCursor: () => {
          wordSelections++
          return true
        },
      },
      _mouseService: { getCoords: (event: FakeMouseEvent) => [Math.floor(event.clientX / 10) + 1, Math.floor(event.clientY / 10) + 1] as [number, number] },
    },
  }
  const dispose = installCodexMouseSelection(host as unknown as HTMLElement, terminal as any)
  return { host, selections, lineSelections, getWordSelections: () => wordSelections, dispose }
}

test('short mouse gesture replays a CLI click without selecting text', () => {
  const { host, selections, dispose } = setup()
  let downs = 0
  let ups = 0
  host.addEventListener('mousedown', () => downs++)
  host.addEventListener('mouseup', () => ups++)
  host.dispatchEvent(new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10, buttons: 1 }))
  host.ownerDocument.dispatchEvent(new FakeMouseEvent('mouseup', { clientX: 11, clientY: 10 }))
  assert.equal(downs, 1)
  assert.equal(ups, 1)
  assert.deepEqual(selections, [])
  dispose()
})

test('drag selects terminal text and does not replay a CLI click', () => {
  const { host, selections, dispose } = setup()
  let downs = 0
  host.addEventListener('mousedown', () => downs++)
  host.dispatchEvent(new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10, buttons: 1 }))
  const shortMove = new FakeMouseEvent('mousemove', { clientX: 12, clientY: 10, buttons: 1 })
  host.ownerDocument.dispatchEvent(shortMove)
  assert.deepEqual(selections, [])
  assert.equal(shortMove.defaultPrevented, true)
  assert.equal(shortMove.cancelBubble, true)
  const dragMove = new FakeMouseEvent('mousemove', { clientX: 40, clientY: 10, buttons: 1 })
  host.ownerDocument.dispatchEvent(dragMove)
  const up = new FakeMouseEvent('mouseup', { clientX: 40, clientY: 10 })
  host.ownerDocument.dispatchEvent(up)
  assert.equal(downs, 0)
  assert.equal(dragMove.defaultPrevented, true)
  assert.equal(dragMove.cancelBubble, true)
  assert.equal(up.defaultPrevented, true)
  assert.equal(up.cancelBubble, true)
  assert.deepEqual(selections.at(-1), [1, 1, 3])
  dispose()
})

test('double-click selects a word locally without replaying terminal mouse input', () => {
  const { host, selections, getWordSelections, dispose } = setup()
  let downs = 0
  let ups = 0
  host.addEventListener('mousedown', () => downs++)
  host.addEventListener('mouseup', () => ups++)
  host.dispatchEvent(new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10, buttons: 1, detail: 2 }))
  host.ownerDocument.dispatchEvent(new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10, detail: 2 }))
  assert.equal(getWordSelections(), 1)
  assert.equal(downs, 0)
  assert.equal(ups, 0)
  assert.deepEqual(selections, [])
  dispose()
})

test('triple-click selects the line locally without replaying terminal mouse input', () => {
  const { host, lineSelections, dispose } = setup()
  let downs = 0
  let ups = 0
  host.addEventListener('mousedown', () => downs++)
  host.addEventListener('mouseup', () => ups++)
  host.dispatchEvent(new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10, buttons: 1, detail: 3 }))
  host.ownerDocument.dispatchEvent(new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10, detail: 3 }))
  assert.deepEqual(lineSelections, [[1, 1]])
  assert.equal(downs, 0)
  assert.equal(ups, 0)
  dispose()
})

test('a lost mouseup cancels the gesture before the next click', () => {
  const { host, selections, dispose } = setup()
  host.dispatchEvent(new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10, buttons: 1 }))
  host.ownerDocument.dispatchEvent(new FakeMouseEvent('mousemove', { clientX: 40, clientY: 10, buttons: 0 }))
  assert.deepEqual(selections, [])
  dispose()
})

test('tcodex uses the Codex click-versus-drag behavior', () => {
  assert.equal(supportsCodexMouseSelection('codex'), true)
  assert.equal(supportsCodexMouseSelection('tcodex'), true)
  assert.equal(supportsCodexMouseSelection('claude'), false)
})
