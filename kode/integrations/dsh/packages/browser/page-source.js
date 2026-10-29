/** BrowserPage provider for the stock dsh browser chrome; pixels and input stay in an owner-authenticated channel. */
export function createBrowserPage(options) {
  const id = crypto.randomUUID(), listeners = new Set()
  let snapshot = { target: undefined, address: 'empty', loading: false, canGoBack: false, canGoForward: false, error: undefined, sandboxEnabled: undefined }
  let ready = false, creating, disposed = false, host, root, image, input, stream, observer, size = { width: 800, height: 900, pixelRatio: Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1)) }, revision = 0, inputChain = Promise.resolve(), inputQueue = [], drainingInput = false, navigationChain = Promise.resolve(), frameRequest, moveData, resizeTimer, densityQuery, densityListener, recovering, touch, frameViewport, feedback, feedbackTimer, composing = false
  const publish = patch => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener() }
  const showFeedback = text => { if (!feedback) return; feedback.textContent = text; feedback.hidden = false; clearTimeout(feedbackTimer); feedbackTimer = setTimeout(() => { if (feedback) feedback.hidden = true }, 2500) }
  const failure = error => publish({ loading: false, error: { code: -1, description: error.message || '侧栏浏览器连接失败。' } })
  async function api(action, data = {}) {
    const response = await fetch('/api/kode/browser', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, id, ...data }), keepalive: action === 'close', signal: AbortSignal.timeout(30000) })
    let value
    try { value = await response.json() } catch { throw new Error(`侧栏浏览器接口暂不可用（HTTP ${response.status}），请重新连接入口主机。`) }
    if (!response.ok) {
      const gone = value.code === 'BROWSER_TAB_GONE' || /标签页已关闭|标签页已回收/.test(value.error ?? '')
      if (gone) ready = false
      throw Object.assign(new Error(value.error ?? '浏览器操作失败。'), { code: gone ? 'BROWSER_TAB_GONE' : value.code })
    }
    return value
  }
  function update(value) {
    let target
    try { const url = new URL(value.url); if (['http:', 'https:'].includes(url.protocol)) target = { kind: url.protocol === 'https:' ? 'https' : 'http', url: url.href, title: value.title || url.hostname } } catch {}
    publish({ target: target ?? snapshot.target, address: target ? 'observed' : 'unknown', loading: Boolean(value.loading), canGoBack: Boolean(value.canGoBack), canGoForward: Boolean(value.canGoForward), error: value.error ? { code: -1, description: value.error } : undefined })
    if (target) options.persist({ entries: [target], index: 0, request: { revision: ++revision, target }, navigation: { status: 'known', revision }, failure: undefined })
  }
  function connect() {
    stream?.close(); if (!root || !ready || disposed) return
    stream = new EventSource(`/api/kode/browser?stream=${encodeURIComponent(id)}`)
    stream.onmessage = event => {
      let value; try { value = JSON.parse(event.data) } catch { return }
      if (value.type === 'frame' && image) { frameViewport = value.viewport; image.src = `data:${value.mimeType === 'image/png' ? 'image/png' : 'image/jpeg'};base64,${value.data}` }
      else if (value.type === 'state') update(value)
      else if (value.type === 'open') options.openRequested(value.url)
      else if (value.type === 'closed') { ready = false; stream?.close(); void recoverPage() }
    }
    stream.onerror = () => { if (disposed) return; void api('heartbeat').catch(error => { if (error.code === 'BROWSER_TAB_GONE') void recoverPage(); else failure(new Error('网页画面连接中断，正在重连。')) }) }
  }
  async function ensure(target) {
    if (ready) return
    if (!creating) creating = api('create', { url: target.url, ...size }).then(value => { if (disposed) return api('close').catch(() => {}); ready = true; return api('resize', size).then(() => { update(value); connect() }) }).finally(() => { creating = undefined })
    await creating
  }
  function recoverPage() {
    if (disposed || !root || !snapshot.target) return Promise.resolve()
    if (!recovering) {
      ready = false; stream?.close(); publish({ loading: true, error: undefined })
      recovering = ensure(snapshot.target).catch(failure).finally(() => { recovering = undefined })
    }
    return recovering
  }
  function copySelection() {
    return inputChain.then(() => api('selection')).then(async value => { if (!value.text) return showFeedback('请先选中网页里的文字'); if (!navigator.clipboard?.writeText) return showFeedback('当前浏览器不允许访问剪贴板'); await navigator.clipboard.writeText(value.text); showFeedback('已复制') }).catch(error => showFeedback(error.message))
  }
  function command(action, data = {}) {
    const last = inputQueue.at(-1)
    // Only merge adjacent motion events: presses, releases, keys and resizes
    // remain ordering barriers, including during drag selection.
    if (action === 'pointer' && last?.action === action && last.data.type === data.type && last.data.buttons === data.buttons && ['mouseMoved', 'mouseWheel'].includes(data.type)) {
      last.data = data.type === 'mouseWheel' ? { ...data, deltaX: last.data.deltaX + data.deltaX, deltaY: last.data.deltaY + data.deltaY } : data
    } else inputQueue.push({ action, data })
    if (!drainingInput) {
      drainingInput = true
      inputChain = inputChain.catch(() => {}).then(async () => {
        try {
          while (inputQueue.length) {
            const next = inputQueue.shift()
            if (disposed) continue
            try { if (ready) await api(next.action, next.data); else await recoverPage() }
            catch (error) {
              inputQueue.length = 0
              if (error.code === 'BROWSER_TAB_GONE') await recoverPage()
              else failure(error)
            }
          }
        } finally { drainingInput = false }
      })
    }
    return inputChain
  }
  function coordinates(event) {
    const bounds = root.getBoundingClientRect()
    const width = image?.naturalWidth || size.width, height = image?.naturalHeight || size.height
    const scale = Math.min(bounds.width / width, bounds.height / height), pageScale = frameViewport?.scale || 1
    const x = (event.clientX - bounds.left - (bounds.width - width * scale) / 2) / scale
    const y = (event.clientY - bounds.top - (bounds.height - height * scale) / 2) / scale
    return { x: x * (frameViewport?.width || size.width) / width / pageScale, y: (y * (frameViewport?.height || size.height) / height - (frameViewport?.offsetTop || 0)) / pageScale }
  }
  function pointer(event, type) {
    if (!root || !ready) return
    if (type !== 'mouseMoved') event.preventDefault()
    if (type === 'mousePressed') input?.focus({ preventScroll: true })
    const data = { type, ...coordinates(event), button: ['left', 'middle', 'right'][event.button] ?? 'none', buttons: event.buttons, clickCount: event.detail || 1 }
    if (type === 'mouseWheel') Object.assign(data, { button: 'none', deltaX: event.deltaX, deltaY: event.deltaY })
    if (type === 'mouseMoved') { moveData = data; if (frameRequest) return; frameRequest = requestAnimationFrame(() => { frameRequest = undefined; const latest = moveData; moveData = undefined; if (latest) void command('pointer', latest) }) }
    else { if (frameRequest) cancelAnimationFrame(frameRequest); frameRequest = undefined; moveData = undefined; void command('pointer', data) }
  }
  const heartbeat = setInterval(() => { if (ready && !disposed) void api('heartbeat').catch(error => { if (error.code === 'BROWSER_TAB_GONE' && root) void recoverPage() }) }, 20000)
  const frame = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    loadUrl(target) {
      publish({ target, address: 'requested', loading: true, error: undefined })
      navigationChain = navigationChain.catch(() => {}).then(async () => {
        if (disposed) return
        const existing = ready
        await ensure(target)
        if (existing) await command('navigate', { url: target.url })
      }).catch(failure)
    },
    goBack: () => { void command('back') }, goForward: () => { void command('forward') },
    reload: () => { if (ready) { publish({ error: undefined, loading: true }); void command('reload') } else if (snapshot.target) frame.loadUrl(snapshot.target) },
    async dispose() { if (disposed) return; disposed = true; clearInterval(heartbeat); detach(); listeners.clear(); await creating?.catch(() => {}); if (ready) await api('close').catch(() => {}) },
  }
  function detach() { stream?.close(); stream = undefined; observer?.disconnect(); densityQuery?.removeEventListener('change', densityListener); densityQuery = undefined; clearTimeout(resizeTimer); clearTimeout(feedbackTimer); if (frameRequest) cancelAnimationFrame(frameRequest); root?.remove(); root = undefined; image = undefined; input = undefined; host = undefined }
  const presentation = { mount(viewportId) {
    detach(); host = document.getElementById(viewportId); if (!host) throw new Error('浏览器视图尚未挂载。')
    root = document.createElement('div'); root.className = 'kode-browser-surface'; root.tabIndex = 0; root.setAttribute('role', 'region'); root.setAttribute('aria-label', '侧栏网页，点击后可输入；Esc 返回地址栏')
    Object.assign(root.style, { position: 'relative', width: '100%', height: '100%', overflow: 'hidden', outline: 'none', background: 'var(--dsw-alias-bg-base)', touchAction: 'none' })
    image = document.createElement('img'); image.alt = '网页画面'; image.draggable = false; Object.assign(image.style, { display: 'block', width: '100%', height: '100%', objectFit: 'contain', userSelect: 'none' }); root.append(image); input = document.createElement('textarea'); input.setAttribute('aria-label', '网页键盘输入'); input.autocapitalize = 'off'; input.autocomplete = 'off'; input.spellcheck = false; Object.assign(input.style, { position: 'absolute', width: '1px', height: '1px', left: '0', top: '0', opacity: '0' }); root.append(input); feedback = document.createElement('div'); feedback.setAttribute('role', 'status'); feedback.hidden = true; Object.assign(feedback.style, { position: 'absolute', bottom: '12px', left: '12px', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', padding: '6px 10px', borderRadius: '6px', fontSize: '12px', pointerEvents: 'none' }); root.append(feedback); host.append(root)
    root.addEventListener('pointerdown', event => {
      root.setPointerCapture?.(event.pointerId)
      if (event.pointerType === 'touch') { event.preventDefault(); touch = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false }; return }
      pointer(event, 'mousePressed')
    })
    root.addEventListener('pointermove', event => {
      if (touch?.id === event.pointerId) {
        event.preventDefault(); touch.moved ||= Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 6
        if (touch.moved) void command('pointer', { type: 'mouseWheel', ...coordinates(event), button: 'none', deltaX: touch.lastX - event.clientX, deltaY: touch.lastY - event.clientY })
        touch.lastX = event.clientX; touch.lastY = event.clientY; return
      }
      pointer(event, 'mouseMoved')
    })
    root.addEventListener('pointerup', event => {
      if (touch?.id === event.pointerId) {
        event.preventDefault()
        if (!touch.moved) { input?.focus({ preventScroll: true }); const point = coordinates(event); void command('pointer', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 }); void command('pointer', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 }) }
        touch = undefined
      } else pointer(event, 'mouseReleased')
      root.releasePointerCapture?.(event.pointerId)
    })
    root.addEventListener('pointercancel', event => { touch = undefined; pointer(event, 'mouseReleased') })
    root.addEventListener('wheel', event => pointer(event, 'mouseWheel'), { passive: false }); root.addEventListener('contextmenu', event => event.preventDefault())
    const key = event => {
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape' || (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); host?.parentElement?.querySelector('input')?.focus(); return }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
        event.preventDefault(); event.stopPropagation()
        if (event.type === 'keydown') void copySelection()
        return
      }
      event.preventDefault(); event.stopPropagation()
      void command('key', { type: event.type === 'keydown' ? 'keyDown' : 'keyUp', key: event.key, code: event.code, keyCode: event.keyCode, modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0), ...(event.type === 'keydown' && event.key.length === 1 && !event.ctrlKey && !event.metaKey ? { text: event.key } : {}) })
    }
    root.addEventListener('keydown', key); root.addEventListener('keyup', key)
    root.addEventListener('compositionstart', () => { composing = true })
    root.addEventListener('input', event => { if (event.target !== input || composing || event.isComposing || !input.value) return; const text = input.value; input.value = ''; void command('text', { text }) })
    root.addEventListener('beforeinput', event => {
      if (composing || event.isComposing) return
      const key = event.inputType?.startsWith('delete') ? 'Backspace' : event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph' ? 'Enter' : undefined
      if (key) { event.preventDefault(); const keyCode = key === 'Enter' ? 13 : 8; void command('key', { type: 'keyDown', key, code: key, keyCode }); void command('key', { type: 'keyUp', key, code: key, keyCode }) }
    })
    root.addEventListener('compositionend', event => { composing = false; if (event.data) void command('text', { text: event.data }); if (input) input.value = '' })
    root.addEventListener('copy', event => { event.preventDefault(); event.stopPropagation(); void copySelection() })
    root.addEventListener('paste', event => { event.preventDefault(); void command('text', { text: event.clipboardData?.getData('text/plain') ?? '' }) })
    const measure = () => {
      if (!root) return
      const bounds = root.getBoundingClientRect()
      if (!bounds.width || !bounds.height) return
      const next = { width: Math.max(320, Math.min(3840, Math.round(bounds.width))), height: Math.max(240, Math.min(2160, Math.round(bounds.height))), pixelRatio: Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1)) }
      if (next.width === size.width && next.height === size.height && next.pixelRatio === size.pixelRatio) return
      size = next
      if (ready) void command('resize', size)
    }
    const watchDensity = () => {
      densityQuery?.removeEventListener('change', densityListener)
      densityQuery = globalThis.matchMedia?.(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`)
      densityListener = () => { measure(); watchDensity() }
      densityQuery?.addEventListener('change', densityListener)
    }
    measure(); watchDensity()
    observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(measure, 100) }); observer.observe(root)
    if (ready) { void api('heartbeat').then(connect).catch(error => error.code === 'BROWSER_TAB_GONE' ? recoverPage() : failure(error)) } else connect(); return detach
  } }
  return { frame, presentation }
}
