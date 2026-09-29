import assert from 'node:assert/strict'
import test from 'node:test'
import { installCodexMouseSelection } from '../src/lib/codex_mouse_selection.ts'

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
  const terminal = {
    element: host,
    modes: { mouseTrackingMode: 'drag' },
    cols: 80,
    rows: 24,
    buffer: { active: { viewportY: 0 } },
    select: (col: number, row: number, length: number) => selections.push([col, row, length]),
    _core: { _mouseService: { getCoords: (event: FakeMouseEvent) => [Math.floor(event.clientX / 10) + 1, Math.floor(event.clientY / 10) + 1] as [number, number] } },
  }
  const dispose = installCodexMouseSelection(host as unknown as HTMLElement, terminal as any)
  return { host, selections, dispose }
}

test('short mouse gesture replays a CLI click without selecting text', () => {
  const { host, selections, dispose } = setup()
  let downs = 0
  let ups = 0
  host.addEventListener('mousedown', () => downs++)
  host.addEventListener('mouseup', () => ups++)
  host.dispatchEvent(new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10, buttons: 1 }))
  host.ownerDocument.dispatchEvent(new FakeMouseEvent('mouseup', { clientX: 11, clientY: 10 }))
  assert.equal(downs, 2)
  assert.equal(ups, 1)
  assert.deepEqual(selections, [])
  dispose()
})

test('drag selects terminal text and does not replay a CLI click', () => {
  const { host, selections, dispose } = setup()
  let downs = 0
  host.addEventListener('mousedown', () => downs++)
  host.dispatchEvent(new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10, buttons: 1 }))
  host.ownerDocument.dispatchEvent(new FakeMouseEvent('mousemove', { clientX: 12, clientY: 10, buttons: 1 }))
  assert.deepEqual(selections, [])
  host.ownerDocument.dispatchEvent(new FakeMouseEvent('mousemove', { clientX: 40, clientY: 10, buttons: 1 }))
  host.ownerDocument.dispatchEvent(new FakeMouseEvent('mouseup', { clientX: 40, clientY: 10 }))
  assert.equal(downs, 1)
  assert.deepEqual(selections.at(-1), [1, 1, 3])
  dispose()
})

test('a lost mouseup cancels the gesture before the next click', () => {
  const { host, selections, dispose } = setup()
  host.dispatchEvent(new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10, buttons: 1 }))
  host.ownerDocument.dispatchEvent(new FakeMouseEvent('mousemove', { clientX: 40, clientY: 10, buttons: 0 }))
  assert.deepEqual(selections, [])
  dispose()
})
