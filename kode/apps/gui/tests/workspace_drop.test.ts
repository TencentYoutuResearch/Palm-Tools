import test from 'node:test'
import assert from 'node:assert/strict'
import { routeWorkspaceNativeDrop } from '../src/lib/workspace_drop.ts'

test('native file drops route to Files directory at physical-pixel coordinates', () => {
  const originalDocument = globalThis.document, originalWindow = globalThis.window
  let coordinates: number[] = [], received: unknown
  const pane = { dataset: { dropDirectory: '/workspace' }, dispatchEvent(event: CustomEvent) { received = event.detail } }
  const folder = { dataset: { dropDirectory: '/workspace/src' }, classList: { add() {} } }
  const hit = { closest(selector: string) { return selector === '[data-workspace-files]' ? pane : folder } }
  Object.assign(globalThis, {
    window: { devicePixelRatio: 2 },
    document: { querySelectorAll: () => [], elementFromPoint(x: number, y: number) { coordinates = [x, y]; return hit } },
  })
  try {
    assert.equal(routeWorkspaceNativeDrop({ type: 'drop', paths: ['/tmp/file.txt'], position: { x: 600, y: 200 } }), true)
    assert.deepEqual(coordinates, [300, 100])
    assert.deepEqual(received, { paths: ['/tmp/file.txt'], directory: '/workspace/src' })
    assert.equal(routeWorkspaceNativeDrop({ type: 'leave' }), false)
    globalThis.document.elementFromPoint = () => null
    assert.equal(routeWorkspaceNativeDrop({ type: 'drop', paths: ['/tmp/file.txt'], position: { x: 20, y: 20 } }), false)
  } finally { Object.assign(globalThis, { document: originalDocument, window: originalWindow }) }
})
