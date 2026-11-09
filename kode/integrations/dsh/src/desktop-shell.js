/** Owned Desktop integration, loaded by the unpacked shell installer. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findDevelopmentRuntime } from './desktop-runtime.js'
// Full-screen Spaces may temporarily report empty auxiliary menu regions.
// Keep the last measured cutout until the physical display disappears.
export function screenCutouts(rows, previous = new Map()) {
  return new Map(rows.flatMap(row => {
    const measured = Number.isFinite(row.left) && Number.isFinite(row.right) && row.right > row.left
    const cutout = measured ? row : previous.get(row.id)
    return cutout ? [[row.id, cutout]] : []
  }))
}
export function installDesktopShell({ app, BrowserWindow, screen, ipcMain, Notification, shell }) {
  const executable = process.platform === 'darwin' ? findDevelopmentRuntime(process.execPath) : null
  if (executable) {
    void app.whenReady().then(() => {
      app.relaunch({ execPath: executable, args: process.argv.slice(1) })
      app.exit(0)
    })
    return { windowOpen: () => null, childCreated() {} }
  }
  const islands = new Map(), notices = new Map(), layouts = new WeakMap(), noticeOwners = new WeakSet()
  let cutouts = new Map()
  const readGeometry = () => {
    if (process.platform !== 'darwin') return
    try {
      const rows = JSON.parse(execFileSync(fileURLToPath(new URL('../assets/desktop/screen-layout', import.meta.url)), [], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }))
      cutouts = screenCutouts(rows, cutouts)
    } catch { /* Older packages retain a conservative camera clearance. */ }
  }
  const owner = event => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return window && !window.isDestroyed() && event.senderFrame === event.sender.mainFrame && event.sender.getURL().startsWith('dsh-app://app/') ? window : null
  }
  const position = (parent, child, size = { width: 240, height: 28 }) => {
    const display = screen.getDisplayMatching(parent.getBounds())
    const menuHeight = display.workArea.y - display.bounds.y
    const cutout = cutouts.get(display.id)
    const camera = !!cutout || (display.internal && menuHeight >= 30)
    const gap = cutout ? cutout.right - cutout.left : 200
    const leftWing = 56, rightWing = 144, collapsed = size.height <= 40
    const center = display.bounds.x + (cutout ? (cutout.left + cutout.right) / 2 : display.bounds.width / 2)
    const width = collapsed ? (camera ? leftWing + gap + rightWing : 240) : size.width
    const desiredX = collapsed && camera ? center - gap / 2 - leftWing : center - width / 2
    const x = Math.round(Math.max(display.bounds.x, Math.min(desiredX, display.bounds.x + display.bounds.width - width)))
    const height = collapsed ? (cutout?.height ?? Math.max(22, Math.min(28, menuHeight || 28))) : Math.min(size.height, display.workArea.height)
    const bounds = { x, y: display.bounds.y, width, height }, previous = child.getBounds()
    if (!previous || Object.keys(bounds).some(key => previous[key] !== bounds[key])) child.setBounds(bounds)
    const layout = JSON.stringify([camera, gap, center - x, height])
    if (layouts.get(child) !== layout && !child.webContents.isLoadingMainFrame()) {
      layouts.set(child, layout)
      void child.webContents.executeJavaScript(`{
        const root = document.documentElement;
        root.dataset.kodeMenuCamera = '${camera ? 'true' : 'false'}';
        root.style.setProperty('--kode-camera-gap', '${gap}px');
        root.style.setProperty('--kode-camera-center', '${center - x}px');
        root.style.setProperty('--kode-menu-height', '${cutout?.height ?? 28}px');
      }`).catch(() => {})
    }
  }
  const refresh = () => {
    for (const [parent, child] of islands) {
      if (parent.isDestroyed() || child.isDestroyed()) continue
      if (parent.isVisible() && !parent.isMinimized()) { position(parent, child, child.getBounds()); if (!child.isVisible()) child.showInactive() }
      else child.hide()
    }
  }
  app.on('browser-window-focus', refresh)
  // The panel belongs to its owner's display, independently of app focus.
  // App switching must neither hide it nor reposition it onto another screen.
  app.on('did-become-active', refresh)
  void app.whenReady().then(() => {
    readGeometry(); refresh()
    const changed = () => { readGeometry(); refresh() }
    screen.on('display-metrics-changed', changed)
    screen.on('display-added', changed)
    screen.on('display-removed', changed)
  })
  ipcMain.handle('kode-desktop:notification-settings', event => {
    if (!owner(event)) throw new Error('Owned application window required')
    // Construction requests native authorization without sending a test notice.
    new Notification({ title: 'Kode' })
    return shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension')
  })
  ipcMain.handle('kode-desktop:notification', async (event, data) => {
    const parent = owner(event)
    if (!parent || !data || typeof data.key !== 'string' || data.key.length > 300) throw new Error('Invalid notification')
    if (!noticeOwners.has(parent)) {
      noticeOwners.add(parent)
      parent.once('closed', () => { for (const [key, note] of notices) if (key.startsWith(parent.id + ':')) { note.close(); notices.delete(key) } })
    }
    const key = parent.id + ':' + data.key
    notices.get(key)?.close()
    if (data.close) { notices.delete(key); return }
    if (typeof data.title !== 'string' || typeof data.body !== 'string') throw new Error('Invalid notification text')
    const note = new Notification({ title: data.title.slice(0, 180), body: data.body.slice(0, 160) })
    notices.set(key, note)
    note.once('click', () => {
      if (!parent.isDestroyed()) { parent.show(); parent.focus(); parent.webContents.send('kode-desktop:notification-click', data.key) }
    })
    note.once('close', () => { if (notices.get(key) === note) notices.delete(key) })
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve({ status: 'pending' }), 5000)
      note.once('show', () => { clearTimeout(timer); resolve({ status: 'shown' }) })
      note.once('failed', (_event, error) => { clearTimeout(timer); if (notices.get(key) === note) notices.delete(key); resolve({ status: 'failed', error: String(error) }) })
      note.show()
    })
  })
  ipcMain.on('kode-desktop:island-size', (event, size) => {
    const parent = owner(event), child = parent && islands.get(parent)
    if (!child || !Number.isFinite(size?.width) || !Number.isFinite(size?.height)) return
    position(parent, child, { width: Math.max(240, Math.min(680, Math.round(size.width))), height: Math.max(28, Math.min(900, Math.round(size.height))) })
    refresh()
  })
  return {
    windowOpen(parent, { url, frameName }) {
      if (process.platform !== 'darwin' || frameName !== 'kode-token-island' || url !== 'about:blank' || !parent.webContents.getURL().startsWith('dsh-app://app/')) return null
      return { action: 'allow', overrideBrowserWindowOptions: { type: 'panel', enableLargerThanScreen: true, width: 240, height: 28, show: false, frame: false, roundedCorners: false, transparent: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } } }
    },
    childCreated(parent, child, details) {
      if (details.frameName !== 'kode-token-island') return
      islands.get(parent)?.close()
      islands.set(parent, child)
      child.setAlwaysOnTop(true, 'pop-up-menu')
      child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const move = () => { if (!child.isDestroyed()) position(parent, child, child.getBounds()) }
      // A native full-screen transition moves the owner to another Space and
      // temporarily changes focus. Reassert the panel after the transition,
      // rather than leaving it hidden by the intermediate blur event.
      const fullScreenChanged = () => {
        if (child.isDestroyed()) return
        child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
        readGeometry(); refresh()
      }
      parent.on('enter-full-screen', fullScreenChanged)
      parent.on('leave-full-screen', fullScreenChanged)
      for (const event of ['move', 'moved', 'resize']) parent.on(event, move)
      for (const event of ['hide', 'show', 'minimize', 'restore']) parent.on(event, refresh)
      parent.once('closed', () => { if (!child.isDestroyed()) child.close() })
      child.once('closed', () => { for (const event of ['move', 'moved', 'resize']) parent.removeListener(event, move); parent.removeListener('enter-full-screen', fullScreenChanged); parent.removeListener('leave-full-screen', fullScreenChanged); for (const event of ['hide', 'show', 'minimize', 'restore']) parent.removeListener(event, refresh); islands.delete(parent) })
      child.webContents.once('did-finish-load', refresh)
      position(parent, child)
      refresh()
    },
  }
}
