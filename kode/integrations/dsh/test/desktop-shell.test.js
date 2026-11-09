import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { installDesktopShell } from '../src/desktop-shell.js'

function fixture() {
  const handlers = new Map(), listeners = new Map(), notes = []
  const app = new EventEmitter(), screen = new EventEmitter()
  app.whenReady = async () => {}
  screen.getDisplayMatching = bounds => bounds.x > 1500
    ? { bounds: { x: 1600, y: 0, width: 1920, height: 1080 }, workArea: { x: 1600, y: 25, width: 1920, height: 1055 } }
    : { internal: true, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 33, width: 1512, height: 949 } }
  const parent = new EventEmitter(), child = new EventEmitter()
  const frame = {}, sender = { mainFrame: frame, getURL: () => 'dsh-app://app/', send: (...args) => { sender.sent = args } }
  Object.assign(parent, { id: 1, webContents: sender, isVisible: () => true, isMinimized: () => false, isDestroyed: () => false, getBounds: () => ({ x: 0, y: 50, width: 900, height: 600 }), show() { this.shown = true }, focus() { this.focused = true } })
  Object.assign(child, { webContents: Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, isLoadingMainFrame: () => false, executeJavaScript: async () => {} }), isDestroyed: () => false, setBounds(bounds) { this.bounds = bounds }, getBounds() { return this.bounds }, setAlwaysOnTop() {}, setVisibleOnAllWorkspaces() {}, showInactive() { this.visible = true }, hide() { this.visible = false }, close() { this.emit('closed') } })
  let focused = parent
  class Notification extends EventEmitter { constructor(data) { super(); this.data = data; notes.push(this) } show() { this.emit('show') } close() { this.emit('close') } }
  const bridge = installDesktopShell({ app, screen, BrowserWindow: { fromWebContents: s => s === sender ? parent : null, getFocusedWindow: () => focused }, ipcMain: { handle: (key, fn) => handlers.set(key, fn), on: (key, fn) => listeners.set(key, fn) }, Notification, shell: { openExternal: async () => {} } })
  return { bridge, parent, child, app, notes, handlers, listeners, event: { sender, senderFrame: frame }, focus: window => { focused = window; app.emit('browser-window-focus') } }
}
test('one native panel follows the owning display, avoids the camera and hides when DSH loses focus', () => {
  const f = fixture()
  if (process.platform === 'darwin') {
    const result = f.bridge.windowOpen(f.parent, { frameName: 'kode-token-island', url: 'about:blank' })
    assert.equal(result.overrideBrowserWindowOptions.type, 'panel')
    assert.equal(result.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false)
  }
  assert.equal(f.bridge.windowOpen(f.parent, { frameName: 'kode-token-island', url: 'https://example.com' }), null)
  f.bridge.childCreated(f.parent, f.child, { frameName: 'kode-token-island' })
  assert.deepEqual(f.child.bounds, { x: 476, y: 0, width: 560, height: 28 })
  assert.equal(f.child.visible, true)
  f.parent.getBounds = () => ({ x: 1700, y: 100, width: 900, height: 600 })
  f.parent.emit('move')
  assert.equal(f.child.bounds.x, 2440)
  assert.equal(f.child.bounds.height, 25)
  f.focus(null); assert.equal(f.child.visible, false)
  f.focus(f.parent); assert.equal(f.child.visible, true)
  f.parent.isVisible = () => false; f.focus(f.child); assert.equal(f.child.visible, false)
  f.parent.isVisible = () => true; f.focus(f.parent)
  const resize = f.listeners.get('kode-desktop:island-size')
  resize({ ...f.event, senderFrame: {} }, { width: 640, height: 820 })
  assert.equal(f.child.bounds.width, 240)
  resize(f.event, { width: 640, height: 820 })
  assert.equal(f.child.bounds.width, 640)
  f.parent.emit('closed')
  assert.equal(f.parent.listenerCount('move'), 0)
})
test('native notification bridge rejects foreign frames, reports delivery and sends click to its owner', async () => {
  const f = fixture(), notify = f.handlers.get('kode-desktop:notification')
  await assert.rejects(notify({ ...f.event, senderFrame: {} }, { key: 'turn1', title: 'Complete', body: 'Task' }))
  assert.equal(f.notes.length, 0)
  assert.deepEqual(await notify(f.event, { key: 'turn1', title: 'Complete', body: 'Task' }), { status: 'shown' })
  f.notes[0].emit('click')
  assert.equal(f.parent.shown, true)
  assert.equal(f.parent.focused, true)
  assert.deepEqual(f.event.sender.sent, ['kode-desktop:notification-click', 'turn1'])
  await notify(f.event, { key: 'turn1', close: true })
})
