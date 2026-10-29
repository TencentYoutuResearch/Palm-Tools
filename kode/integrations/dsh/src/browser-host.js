/** A private, sandboxed Chromium instance renders top-level pages for the sidebar. No framing headers are rewritten. */
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, delimiter } from 'node:path'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'

export function browserUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('侧栏浏览器只接受不含账号密码的 HTTP(S) 地址。')
  return url.href
}
export function viewportSize(width, height) { return { width: Math.max(320, Math.min(3840, Math.round(Number(width) || 800))), height: Math.max(240, Math.min(2160, Math.round(Number(height) || 900))) } }

// CSS viewport size controls layout; the independent backing scale controls
// sharpness. Bound high-density frames rather than shrinking the CSS layout.
export function viewportPixelRatio(value, size) {
  const ratio = Math.max(1, Math.min(2, Number(value) || 1))
  return Math.min(ratio, Math.max(1, Math.sqrt(8388608 / (size.width * size.height))))
}
export function screencastOptions(page) {
  return { format: 'png', maxWidth: Math.ceil(page.size.width * page.pixelRatio), maxHeight: Math.ceil(page.size.height * page.pixelRatio), everyNthFrame: 1 }
}

class Devtools extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.pending = new Map(); this.next = 0
    socket.addEventListener('message', event => {
      let data; try { data = JSON.parse(event.data) } catch { return }
      if (data.id) { const pending = this.pending.get(data.id); if (!pending) return; this.pending.delete(data.id); clearTimeout(pending.timer); data.error ? pending.reject(new Error(data.error.message)) : pending.resolve(data.result) }
      else if (data.method) this.emit('event', data)
    })
    socket.addEventListener('close', () => { for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('侧栏浏览器连接已关闭。')) }; this.pending.clear(); this.emit('closed') })
  }
  call(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.next, timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`浏览器响应超时：${method}`)) }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
}

export class SidebarBrowserHost {
  constructor(config = {}) {
    this.config = config; this.pages = new Map(); this.creating = new Map(); this.closed = false
    this.profile = config.browserProfileDirectory ?? join(homedir(), '.local/share/kode/sidebar-browser')
    this.sweep = setInterval(() => { for (const page of this.pages.values()) if (!this.creating.has(page.id) && !page.listeners.size && Date.now() - page.touched > (config.browserPageIdleMs ?? 90000)) void this.remove(page.id).catch(() => {}) }, config.browserSweepMs ?? 30000); this.sweep.unref()
  }
  async launch() {
    if (this.closed) throw new Error('浏览器服务正在关闭。')
    if (this.recovering) await this.recovering
    if (this.ready) return this.ready
    this.ready = (async () => {
      const candidates = [this.config.browserExecutable, ...(process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'] : (process.env.PATH ?? '').split(delimiter).flatMap(path => ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(name => join(path, name))))].filter(Boolean)
      let executable
      for (const path of candidates) { try { await access(path, constants.X_OK); executable = path; break } catch {} }
      if (!executable) throw new Error('未找到 Chrome/Chromium。请安装浏览器，或配置 browserExecutable。')
      if (this.closed) throw new Error('浏览器服务正在关闭。')
      await mkdir(this.profile, { recursive: true, mode: 0o700 }); await rm(join(this.profile, 'DevToolsActivePort'), { force: true })
      const child = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${this.profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32', shell: false })
      this.child = child; let failure, diagnostic = ''
      child.on('error', error => { failure = error }); child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-2048) })
      child.once('exit', () => { if (this.child !== child) return; this.ready = undefined; this.rpc?.socket.close(); for (const page of this.pages.values()) this.publish(page, { type: 'closed' }); this.pages.clear() })
      let address
      for (let i = 0; i < 150; i++) {
        if (this.closed) throw new Error('浏览器服务正在关闭。')
        if (failure || child.exitCode !== null) throw new Error(`侧栏浏览器启动失败。${diagnostic.includes('SingletonLock') ? '独立浏览器配置正在使用中。' : '请检查浏览器安装及系统沙箱支持。'}`)
        try { const [port, path] = (await readFile(join(this.profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); if (/^\d+$/.test(port) && path.startsWith('/devtools/browser/')) { address = `ws://127.0.0.1:${port}${path}`; break } } catch {}
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!address) throw new Error('侧栏浏览器启动超时。')
      const socket = new WebSocket(address)
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('浏览器连接超时。')), 10000); socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true }); socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('无法连接侧栏浏览器。')) }, { once: true }) })
      const rpc = new Devtools(socket); this.rpc = rpc
      rpc.on('event', event => { void this.event(event).catch(() => {}) })
      rpc.on('closed', () => { if (!this.closed && this.rpc === rpc) void this.recover(rpc).catch(() => {}) })
      await rpc.call('Target.setDiscoverTargets', { discover: true })
      return rpc
    })().catch(error => { this.ready = undefined; this.child?.kill('SIGTERM'); throw error })
    return this.ready
  }
  publish(page, data) { for (const send of page.listeners) { try { send(data) } catch { page.listeners.delete(send) } } }
  async focus(page, rpc = this.rpc) {
    if (this.focusedPage === page && this.focusedRpc === rpc) return
    await rpc.call('Page.bringToFront', {}, page.sessionId)
    await rpc.call('Emulation.setDeviceMetricsOverride', { ...page.size, screenWidth: page.size.width, screenHeight: page.size.height, deviceScaleFactor: page.pixelRatio || 1, mobile: false }, page.sessionId)
    this.focusedPage = page; this.focusedRpc = rpc
  }
  async event(event) {
    if (event.method === 'Target.targetCreated' && event.params.targetInfo.openerId) {
      this.focusedPage = undefined
      const target = event.params.targetInfo, parent = [...this.pages.values()].find(page => page.targetId === target.openerId)
      if (parent) {
        try { this.publish(parent, { type: 'open', url: browserUrl(target.url && target.url !== 'about:blank' ? target.url : parent.popupUrl) }) } catch {}
        await this.rpc.call('Target.closeTarget', { targetId: target.targetId }).catch(() => {})
      }
      return
    }
    const page = [...this.pages.values()].find(page => page.sessionId === event.sessionId)
    if (!page) return
    const { method, params } = event
    if (method === 'Page.screencastFrame') {
      void this.rpc.call('Page.screencastFrameAck', { sessionId: params.sessionId }, page.sessionId).catch(() => {})
      if (params.data.length > 8 * 1024 * 1024) return
      if (page.pixelRatio > 1) { this.queueCapture(page); return }
      page.frameViewport = { width: params.metadata.deviceWidth, height: params.metadata.deviceHeight, scale: params.metadata.pageScaleFactor, offsetTop: params.metadata.offsetTop }
      this.queueFrame(page, { type: 'frame', mimeType: 'image/png', data: params.data, viewport: page.frameViewport }); return
    }
    if (method === 'Page.windowOpen') page.popupUrl = params.url
    if (method === 'Page.frameNavigated' && !params.frame.parentId) page.frameId = params.frame.id
    if (method === 'Page.frameStartedLoading' && params.frameId === page.frameId) { page.state = { ...page.state, loading: true }; this.publish(page, { type: 'state', ...page.state }) }
    if (method === 'Page.frameStoppedLoading' && params.frameId === page.frameId || method === 'Page.navigatedWithinDocument' && params.frameId === page.frameId || method === 'Page.frameNavigated' && !params.frame.parentId) await this.update(page)
  }
  async capture(page, size = page.size) {
    const metrics = await this.rpc.call('Page.getLayoutMetrics', {}, page.sessionId)
    const viewport = metrics.cssVisualViewport ?? metrics.visualViewport
    return this.rpc.call('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false, clip: { x: viewport?.pageX ?? 0, y: viewport?.pageY ?? 0, ...size, scale: 1 } }, page.sessionId)
  }
  // Chromium screencasts can remain at CSS resolution on Retina displays.
  // Use their dirty signals to request bounded, serial backing-surface captures.
  queueCapture(page) {
    page.captureRequested = true
    if (page.captureTimer || page.capturing) return
    const delay = Math.max(0, 33 - (Date.now() - (page.lastCapture ?? 0)))
    page.captureTimer = setTimeout(async () => {
      page.captureTimer = undefined
      if (this.pages.get(page.id) !== page || !page.listeners.size) return
      page.captureRequested = false; page.capturing = true; page.lastCapture = Date.now()
      const size = { ...page.size }, pixelRatio = page.pixelRatio
      try {
        const image = await this.capture(page, size)
        if (this.pages.get(page.id) === page && pixelRatio === page.pixelRatio && size.width === page.size.width && size.height === page.size.height) {
          this.publish(page, { type: 'frame', mimeType: 'image/png', data: image.data, viewport: { ...size, scale: 1, offsetTop: 0 } })
        }
      } catch { /* The control-channel recovery publishes its own close event. */ }
      finally {
        page.capturing = false
        if (page.captureRequested) this.queueCapture(page)
      }
    }, delay)
  }
  queueFrame(page, frame) {
    page.pendingFrame = frame
    if (page.frameTimer) return
    const flush = () => { page.frameTimer = undefined; const latest = page.pendingFrame; page.pendingFrame = undefined; page.lastFrame = Date.now(); if (latest && this.pages.get(page.id) === page) this.publish(page, latest) }
    const delay = Math.max(0, 70 - (Date.now() - (page.lastFrame ?? 0)))
    if (delay) page.frameTimer = setTimeout(flush, delay)
    else flush()
  }
  async update(page) {
    const navigation = page.navigation ?? 0
    const history = await this.rpc.call('Page.getNavigationHistory', {}, page.sessionId)
    if ((page.navigation ?? 0) !== navigation) return page.state
    const entry = history.entries[history.currentIndex]
    page.state = { url: entry?.url ?? page.state.url, title: entry?.title || entry?.url || '', loading: false, canGoBack: history.entries.slice(0, history.currentIndex).some(entry => /^https?:\/\//.test(entry.url)), canGoForward: history.entries.slice(history.currentIndex + 1).some(entry => /^https?:\/\//.test(entry.url)) }
    this.publish(page, { type: 'state', ...page.state }); return page.state
  }
  create(input) {
    if (this.creating.has(input.id)) return this.creating.get(input.id)
    const job = this.createPage(input).finally(() => this.creating.delete(input.id))
    this.creating.set(input.id, job); return job
  }
  async createPage(input) {
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(input.id ?? '')) throw new Error('无效浏览器标签页。')
    if (this.pages.has(input.id)) { const page = this.pages.get(input.id); page.touched = Date.now(); return { id: page.id, ...page.state } }
    if (this.pages.size + [...this.creating.keys()].filter(id => !this.pages.has(id)).length >= 6) throw new Error('侧栏浏览器最多同时打开 6 个网页，请先关闭不需要的标签页。')
    const url = browserUrl(input.url), size = viewportSize(input.width, input.height)
    let rpc = await this.launch(), target
    if (this.closed) throw new Error('浏览器服务正在关闭。')
    try { target = await rpc.call('Target.createTarget', { url: 'about:blank', background: true }) }
    catch (error) {
      // Recover only a dead browser control channel; network/page errors never
      // restart the browser or any Agent process. Retry allocation just once.
      if (!/响应超时|连接已关闭/.test(error.message) || this.closed) throw error
      await this.recover(rpc)
      rpc = await this.launch()
      target = await rpc.call('Target.createTarget', { url: 'about:blank', background: true })
    }
    try {
      const attached = await rpc.call('Target.attachToTarget', { targetId: target.targetId, flatten: true })
      const page = { id: input.id, targetId: target.targetId, sessionId: attached.sessionId, size, pixelRatio: viewportPixelRatio(input.pixelRatio, size), listeners: new Set(), touched: Date.now(), state: { url, title: new URL(url).hostname, loading: true, canGoBack: false, canGoForward: false } }
      this.pages.set(page.id, page)
      await rpc.call('Page.enable', {}, page.sessionId)
      await rpc.call('Emulation.setDeviceMetricsOverride', { ...size, screenWidth: size.width, screenHeight: size.height, deviceScaleFactor: page.pixelRatio, mobile: false }, page.sessionId)

      const response = await rpc.call('Page.navigate', { url }, page.sessionId)
      if (response.errorText) throw new Error(response.errorText)
      return { id: page.id, ...page.state }
    } catch (error) { await rpc.call('Target.closeTarget', { targetId: target.targetId }).catch(() => {}); this.pages.delete(input.id); throw error }
  }
  async subscribe(id, send) {
    const page = this.pages.get(id); if (!page) throw Object.assign(new Error('浏览器标签页已回收，正在恢复。'), { code: 'BROWSER_TAB_GONE' })
    const rpc = this.rpc
    if (!rpc) throw Object.assign(new Error('浏览器连接已关闭，正在恢复。'), { code: 'BROWSER_TAB_GONE' })
    page.touched = Date.now(); page.listeners.add(send); send({ type: 'state', ...page.state })
    try {
      await this.focus(page, rpc)
      await rpc.call('Page.startScreencast', screencastOptions(page), page.sessionId)
      const image = await this.capture(page)
      send({ type: 'frame', mimeType: 'image/png', data: image.data, viewport: { ...page.size, scale: 1, offsetTop: 0 } })
    } catch (error) { page.listeners.delete(send); throw error }
    return () => { page.listeners.delete(send); if (!page.listeners.size) { void rpc.call('Page.stopScreencast', {}, page.sessionId).catch(() => {}) } }
  }
  async action(input) {
    const page = this.pages.get(input.id); if (!page) throw Object.assign(new Error('浏览器标签页已回收，正在恢复。'), { code: 'BROWSER_TAB_GONE' })
    page.touched = Date.now()
    const rpc = this.rpc
    if (!rpc) throw Object.assign(new Error('浏览器连接已关闭，正在恢复。'), { code: 'BROWSER_TAB_GONE' })
    const call = (method, params) => rpc.call(method, params, page.sessionId)
    const focus = () => this.focus(page, rpc)
    if (input.action === 'heartbeat') return {}
    if (input.action === 'navigate') { const url = browserUrl(input.url); page.navigation = (page.navigation ?? 0) + 1; page.state = { ...page.state, url, loading: true }; this.publish(page, { type: 'state', ...page.state }); const response = await call('Page.navigate', { url }); if (response.errorText) throw new Error(response.errorText); return {} }
    if (input.action === 'reload') { await call('Page.reload', {}); return {} }
    if (input.action === 'back' || input.action === 'forward') { const h = await call('Page.getNavigationHistory', {}), direction = input.action === 'back' ? -1 : 1; let next = h.currentIndex + direction; while (h.entries[next] && !/^https?:\/\//.test(h.entries[next].url)) next += direction; if (h.entries[next]) await call('Page.navigateToHistoryEntry', { entryId: h.entries[next].id }); return {} }
    if (input.action === 'resize') { page.size = viewportSize(input.width, input.height); page.pixelRatio = viewportPixelRatio(input.pixelRatio, page.size); await call('Emulation.setDeviceMetricsOverride', { ...page.size, screenWidth: page.size.width, screenHeight: page.size.height, deviceScaleFactor: page.pixelRatio, mobile: false }); if (page.listeners.size) { await call('Page.stopScreencast', {}); await call('Page.startScreencast', screencastOptions(page)) }; return {} }
    if (input.action === 'selection') {
      const result = await call('Runtime.evaluate', { expression: `(() => { const e = document.activeElement; if (e && (e.tagName === 'TEXTAREA' || e.tagName === 'INPUT') && e.type !== 'password' && Number.isInteger(e.selectionStart)) return e.value.slice(e.selectionStart, e.selectionEnd); return String(window.getSelection() || ''); })()`, returnByValue: true });
      return { text: typeof result.result?.value === 'string' ? result.result.value.slice(0, 1048576) : '' }
    }
    if (input.action === 'text') { await focus(); if (typeof input.text !== 'string' || input.text.length > 65536) throw new Error('输入过长。'); await call('Input.insertText', { text: input.text }); return {} }
    if (input.action === 'key') {
      if (!['keyDown', 'keyUp'].includes(input.type) || typeof input.key !== 'string' || input.key.length > 64 || typeof input.code !== 'string' || input.code.length > 64) throw new Error('无效键盘输入。')
      if (input.type === 'keyDown') await focus()
      await call('Input.dispatchKeyEvent', { type: input.type === 'keyDown' && !input.text ? 'rawKeyDown' : input.type, key: input.key, code: input.code, modifiers: Number(input.modifiers) & 15, windowsVirtualKeyCode: Number(input.keyCode) || 0, ...(input.type === 'keyDown' && (Number(input.modifiers) & 6) && input.key.toLowerCase() === 'a' ? { commands: ['selectAll'] } : {}), ...(typeof input.text === 'string' && input.text.length < 8 ? { text: input.text } : {}) });
      if (input.type === 'keyDown' && (Number(input.modifiers) & 6) && input.key.toLowerCase() === 'a') await call('Runtime.evaluate', { expression: `(() => { const e = document.activeElement; if (e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') && typeof e.select === 'function') e.select(); })()` })
      return {}
    }
    if (input.action === 'pointer') {
      if (!['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(input.type)) throw new Error('无效指针输入。')
      const x = Math.max(0, Math.min(page.size.width, Number(input.x) || 0)), y = Math.max(0, Math.min(page.size.height, Number(input.y) || 0))
      if (input.type === 'mousePressed') await focus()
      await call('Input.dispatchMouseEvent', { type: input.type, x, y, button: ['left', 'right', 'middle'].includes(input.button) ? input.button : 'none', buttons: Number(input.buttons) & 7, clickCount: input.type === 'mousePressed' || input.type === 'mouseReleased' ? Math.min(3, Math.max(1, Number(input.clickCount) || 1)) : 0, ...(input.type === 'mouseWheel' ? { deltaX: Math.max(-10000, Math.min(10000, Number(input.deltaX) || 0)), deltaY: Math.max(-10000, Math.min(10000, Number(input.deltaY) || 0)) } : {}) }); return {}
    }
    throw new Error('未知浏览器操作。')
  }
  async recover(rpc) {
    if (this.recovering) return this.recovering
    if (rpc !== this.rpc) return
    this.recovering = (async () => {
      const child = this.child
      this.ready = undefined; this.rpc = undefined; this.child = undefined
      for (const page of this.pages.values()) this.publish(page, { type: 'closed' })
      this.pages.clear(); rpc.socket.close()
      if (child?.exitCode === null) {
        await new Promise(resolve => {
          const timer = setTimeout(() => { child.kill('SIGKILL') }, 3000)
          child.once('exit', () => { clearTimeout(timer); resolve() })
          child.kill('SIGTERM')
        })
      }
    })().finally(() => { this.recovering = undefined })
    return this.recovering
  }
  async remove(id) { const page = this.pages.get(id); if (!page) return; clearTimeout(page.frameTimer); clearTimeout(page.captureTimer); this.pages.delete(id); this.publish(page, { type: 'closed' }); await this.rpc?.call('Target.closeTarget', { targetId: page.targetId }).catch(() => {}) }
  async close() { this.closed = true; clearInterval(this.sweep); await this.recovering; await this.ready?.catch(() => {}); await Promise.allSettled([...this.creating.values()]); await Promise.allSettled([...this.pages.keys()].map(id => this.remove(id))); await this.rpc?.call('Browser.close').catch(() => {}); this.rpc?.socket.close(); if (this.child?.exitCode === null) this.child.kill('SIGTERM') }
}

export function registerBrowserApi(ctx, config = {}) {
  const host = new SidebarBrowserHost(config), responses = new Set()
  const dispose = ctx.webServer.register({ kind: 'exact', path: '/api/kode/browser', handler: async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    try {
      if (req.method === 'GET') {
        const id = new URL(req.url, 'http://localhost').searchParams.get('stream')
        if (!id || !host.pages.has(id)) return send(404, { error: 'Browser tab unavailable' })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' }); responses.add(res)
        let release, closed = false
        const heartbeat = setInterval(() => { if (!closed && !res.writableEnded && !res.destroyed) { res.write(': heartbeat\n\n'); res.flush?.() } }, 15000)
        res.on('close', () => { closed = true; clearInterval(heartbeat); responses.delete(res); release?.() })
        release = await host.subscribe(id, event => { if (closed || res.writableEnded || res.destroyed) return; if (res.writableLength > 2 * 1024 * 1024) { res.end(); return; } res.write(`data: ${JSON.stringify(event)}\n\n`); res.flush?.(); if (event.type === 'closed') res.end() })
        if (closed) release(); return
      }
      if (req.method !== 'POST' || !(req.headers['content-type'] ?? '').startsWith('application/json')) return send(405, { error: 'JSON POST required' })
      let body = ''; for await (const part of req) { body += part; if (Buffer.byteLength(body) > 128 * 1024) throw new Error('Browser request too large') }
      const input = JSON.parse(body)
      send(200, input.action === 'create' ? await host.create(input) : input.action === 'close' ? (await host.remove(input.id), {}) : await host.action(input))
    } catch (error) { if (!res.headersSent) send(error.code === 'BROWSER_TAB_GONE' ? 404 : 400, { error: error.message, ...(error.code ? { code: error.code } : {}) }); else res.end() }
  } })
  return async () => { dispose(); for (const res of responses) res.end(); await host.close() }
}
