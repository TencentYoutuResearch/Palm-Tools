import test from 'node:test'
import assert from 'node:assert/strict'
import { workspaceFileDrag, workspaceReferenceTarget } from '../src/lib/workspace_drag.ts'

class Surface extends EventTarget {
  active = new Set<string>()
  classList = { add: (name: string) => this.active.add(name), remove: (name: string) => this.active.delete(name) }
  dataset: Record<string, string> = {}
  readonly kind: string
  constructor(kind: string) { super(); this.kind = kind }
  hasAttribute(name: string) { return this.kind === name }
  closest(selector: string) { return selector === `[${this.kind}]` ? this : null }
}
function pointer(type: string, x: number, extra = {}) {
  const event = new Event(type, { cancelable: true })
  Object.assign(event, { pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: x, clientY: 0, ...extra })
  return event
}

test('Files pointer drag reaches the conversation exactly once without HTML5 drag events', () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document
  const win = new EventTarget(), source = new Surface('source'), main = new Surface('data-workspace-reference-target')
  const files = new Surface('data-workspace-files')
  const received: unknown[] = [], imported: unknown[] = [], highlights: boolean[] = []
  let hit: Surface | null = main
  Object.assign(globalThis, { window: Object.assign(win, { getSelection: () => null }), document: { elementFromPoint: () => hit } })
  const target = workspaceReferenceTarget(main as unknown as HTMLElement, { hover: active => highlights.push(active), drop: value => received.push(value) })
  const drag = workspaceFileDrag(source as unknown as HTMLElement, { path: '/project/a b.txt', endpointId: 'remote-1' })
  files.addEventListener('workspace-files-drop', e => imported.push((e as CustomEvent).detail))
  try {
    // A click or tiny movement must keep normal file preview behavior.
    source.dispatchEvent(pointer('pointerdown', 0))
    win.dispatchEvent(pointer('pointermove', 2))
    win.dispatchEvent(pointer('pointerup', 2))
    assert.equal(received.length, 0)
    source.dispatchEvent(pointer('pointerdown', 0))
    win.dispatchEvent(pointer('pointermove', 20))
    assert.equal(highlights.at(-1), true)
    win.dispatchEvent(pointer('pointerup', 20))
    win.dispatchEvent(pointer('pointerup', 20))
    assert.deepEqual(received, [{ path: '/project/a b.txt', endpointId: 'remote-1' }])
    assert.equal(highlights.at(-1), false)
    const click = new Event('click', { cancelable: true }); Object.assign(click, { detail: 1 })
    source.dispatchEvent(click)
    assert.equal(click.defaultPrevented, true)
    // A later keyboard activation still works.
    const keyboardClick = new Event('click', { cancelable: true }); Object.assign(keyboardClick, { detail: 0 })
    source.dispatchEvent(keyboardClick)
    assert.equal(keyboardClick.defaultPrevented, false)
    // Keep endpoint provenance for same-endpoint folder copies; never upload them.
    hit = files
    files.dataset.dropDirectory = '/project'
    source.dispatchEvent(pointer('pointerdown', 0))
    win.dispatchEvent(pointer('pointermove', 20))
    win.dispatchEvent(pointer('pointerup', 20))
    assert.deepEqual(imported, [{ paths: ['/project/a b.txt'], directory: undefined, endpointId: 'remote-1', external: false }])
    // Escape, focus loss, cancellation and unmount must not leave a pending drop.
    hit = main
    for (const cancel of ['keydown', 'blur', 'pointercancel', 'destroy']) {
      source.dispatchEvent(pointer('pointerdown', 0))
      win.dispatchEvent(pointer('pointermove', 20))
      if (cancel === 'destroy') drag.destroy()
      else if (cancel === 'pointercancel') win.dispatchEvent(pointer(cancel, 20))
      else { const e = new Event(cancel); Object.assign(e, { key: 'Escape' }); win.dispatchEvent(e) }
      win.dispatchEvent(pointer('pointerup', 20))
      assert.equal(received.length, 1)
      assert.equal(main.active.size, 0)
    }
  } finally {
    drag.destroy(); target.destroy()
    Object.assign(globalThis, { window: oldWindow, document: oldDocument })
  }
})
