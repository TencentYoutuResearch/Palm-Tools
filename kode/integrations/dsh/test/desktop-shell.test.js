import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { installDesktopShell, screenCutouts } from '../src/desktop-shell.js'

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
  Object.assign(child, { webContents: Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, isLoadingMainFrame: () => false, executeJavaScript: async () => {} }), isDestroyed: () => false, isVisible() { return !!this.visible }, setBounds(bounds) { this.bounds = bounds }, getBounds() { return this.bounds }, setAlwaysOnTop(flag, level) { this.level = level }, setVisibleOnAllWorkspaces(flag, options) { this.workspaces = { flag, options } }, showInactive() { this.visible = true }, hide() { this.visible = false }, close() { this.emit('closed') } })
  let focused = parent
  class Notification extends EventEmitter { constructor(data) { super(); this.data = data; notes.push(this) } show() { this.emit('show') } close() { this.emit('close') } }
  const bridge = installDesktopShell({ app, screen, BrowserWindow: { fromWebContents: s => s === sender ? parent : null, getFocusedWindow: () => focused }, ipcMain: { handle: (key, fn) => handlers.set(key, fn), on: (key, fn) => listeners.set(key, fn) }, Notification, shell: { openExternal: async () => {} } })
  return { bridge, parent, child, app, notes, handlers, listeners, event: { sender, senderFrame: frame }, focus: window => { focused = window; app.emit('browser-window-focus') } }
}
test('one native panel follows the owning display, avoids the camera and stays on the owning display when DSH loses focus', () => {
  const f = fixture()
  if (process.platform === 'darwin') {
    const result = f.bridge.windowOpen(f.parent, { frameName: 'kode-token-island', url: 'about:blank' })
    assert.equal(result.overrideBrowserWindowOptions.type, 'panel')
    assert.equal(result.overrideBrowserWindowOptions.roundedCorners, false)
    assert.equal(result.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false)
  }
  assert.equal(f.bridge.windowOpen(f.parent, { frameName: 'kode-token-island', url: 'https://example.com' }), null)
  f.bridge.childCreated(f.parent, f.child, { frameName: 'kode-token-island' })
  assert.deepEqual(f.child.bounds, { x: 632, y: 0, width: 320, height: 28 })
  assert.equal(f.child.visible, true)
  assert.equal(f.child.level, 'pop-up-menu')
  f.child.hide()
  f.parent.emit('enter-full-screen')
  assert.equal(f.child.visible, true)
  assert.equal(f.child.workspaces.options.visibleOnFullScreen, true)
  f.parent.emit('leave-full-screen')
  assert.equal(f.child.visible, true)
  f.parent.getBounds = () => ({ x: 1700, y: 100, width: 900, height: 600 })
  f.parent.emit('move')
  assert.equal(f.child.bounds.x, 2440)
  assert.equal(f.child.bounds.height, 25)
  f.focus(null); assert.equal(f.child.visible, true)
  assert.equal(f.child.bounds.x, 2440, 'another app focus must not move the panel')
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
  assert.equal(f.parent.listenerCount('enter-full-screen'), 0)
  assert.equal(f.parent.listenerCount('leave-full-screen'), 0)
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


test('full-screen menu hiding preserves the measured camera gap and disconnected displays are removed', () => {
  const cutout = { id: 1, left: 663, right: 848, height: 32 }
  let layouts = screenCutouts([cutout, { id: 2 }])
  layouts = screenCutouts([{ id: 1 }, { id: 2 }], layouts)
  assert.deepEqual(layouts.get(1), cutout)
  assert.equal(layouts.has(2), false)
  const changed = { ...cutout, left: 600, right: 800 }
  assert.deepEqual(screenCutouts([changed], layouts).get(1), changed)
  assert.equal(screenCutouts([{ id: 2 }], layouts).has(1), false)
})


test('app switching leaves the owner panel stable while minimize and hide still dismiss it', async () => {
  const f = fixture()
  f.bridge.childCreated(f.parent, f.child, { frameName: 'kode-token-island' })
  let shows = 0
  const show = f.child.showInactive.bind(f.child)
  f.child.showInactive = () => { shows++; show() }
  const before = { ...f.child.bounds }
  f.app.emit('browser-window-blur', {}, f.parent)
  f.app.emit('did-resign-active'); f.focus(null)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.child.visible, true)
  assert.deepEqual(f.child.bounds, before); assert.equal(shows, 0)
  f.app.emit('did-become-active'); assert.equal(shows, 0)
  f.parent.isMinimized = () => true; f.parent.emit('minimize')
  assert.equal(f.child.visible, false)
  f.parent.isMinimized = () => false; f.parent.emit('restore')
  assert.equal(f.child.visible, true)
  f.parent.isVisible = () => false; f.parent.emit('hide'); assert.equal(f.child.visible, false)
  f.parent.isVisible = () => true; f.parent.emit('show'); assert.equal(f.child.visible, true)
  f.parent.getBounds = () => ({ x: 1700, y: 100, width: 900, height: 600 })
  f.parent.emit('resize'); assert.equal(f.child.bounds.x, 2440)
  f.parent.getBounds = () => ({ x: 0, y: 50, width: 900, height: 600 })
  f.parent.emit('moved'); assert.equal(f.child.bounds.x, 632)
  f.child.close()
  for (const event of ['move', 'moved', 'resize']) assert.equal(f.parent.listenerCount(event), 0)
})


test('Space transitions cannot turn native panel drift into a new expansion size', () => {
  const f = fixture()
  f.bridge.childCreated(f.parent, f.child, { frameName: 'kode-token-island' })
  const collapsed = { ...f.child.bounds }
  // Model synchronous native notifications from setBounds too: correcting drift
  // must not recursively reposition the same panel.
  f.child.setBounds = function(bounds) { this.bounds = bounds; this.emit('move'); this.emit('resize') }
  f.child.bounds = { x: 400, y: 450, width: 500, height: 300 }
  f.child.emit('move')
  assert.deepEqual(f.child.bounds, collapsed)
  const resize = f.listeners.get('kode-desktop:island-size')
  resize(f.event, { width: 640, height: 820 })
  const expanded = { ...f.child.bounds }
  f.child.bounds = { x: 400, y: 200, width: 300, height: 28 }
  f.child.emit('resize')
  assert.deepEqual(f.child.bounds, expanded, 'native resize cannot collapse an expanded panel')
  resize(f.event, { width: 240, height: 28 })
  f.child.hide()
  f.child.showInactive = function() { this.visible = true; this.bounds = { x: 400, y: 450, width: 500, height: 300 }; this.emit('show') }
  f.app.emit('did-become-active')
  assert.deepEqual(f.child.bounds, collapsed, 'showing a panel reasserts the menu-bar position')
  f.child.close()
  for (const event of ['move', 'moved', 'resize', 'show']) assert.equal(f.child.listenerCount(event), 0)
})
