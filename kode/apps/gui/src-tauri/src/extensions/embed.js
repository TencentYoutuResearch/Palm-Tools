// Kode extension view bridge (kode.extension/v1). Host-authored; Kode injects
// it into every extension view before the page's own scripts run.
//
// What a view gets:
//   <html data-kode-embed="1" data-kode-platform="macos|windows|linux">
//     plus the `htmlAttributes` its manifest declares for this platform;
//   CSS --kode-traffic-lights-inset: room the macOS window buttons need at
//     the top-left, because the view covers Kode's titlebar;
//   window.kodeHost.request(action, params): ask Kode to do something
//     ("switch-view" {to: "tui", session}, "leave");
//   window "kode-host" CustomEvent: messages from Kode. Kode draws its own
//     notifications on top of the view, so views need not handle "toast".
(() => {
  if (window.top !== window || window.kodeHost) return
  const config = __KODE_EMBED_CONFIG__
  const root = document.documentElement
  root.setAttribute('data-kode-embed', '1')
  root.setAttribute('data-kode-platform', config.platform)
  for (const [name, value] of Object.entries(config.attributes)) root.setAttribute(name, value)
  if (config.platform === 'macos') root.style.setProperty('--kode-traffic-lights-inset', '78px')

  // View → host. A hidden frame navigation is intercepted by Kode and never
  // loads; the page itself does not navigate.
  const request = (action, params) => {
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.src = `kode-host://${encodeURIComponent(action)}?params=${encodeURIComponent(JSON.stringify(params ?? {}))}`
    root.appendChild(frame)
    setTimeout(() => frame.remove(), 2000)
  }
  Object.defineProperty(window, 'kodeHost', { value: Object.freeze({ version: 1, request }) })

  // Host → view.
  let layer = null
  const ensureLayer = () => {
    if (layer?.isConnected) return layer
    const host = document.createElement('kode-host-layer')
    host.style.cssText = 'position:fixed;inset:auto 16px 16px auto;z-index:2147483647;pointer-events:none'
    const shadow = host.attachShadow({ mode: 'closed' })
    shadow.innerHTML = `<style>
      :host { all: initial; }
      .stack { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .toast { pointer-events: auto; max-width: 360px; padding: 10px 12px; border-radius: 10px; border: 1px solid; box-shadow: 0 8px 24px rgba(0,0,0,.14); cursor: default; animation: in .16s ease-out; }
      .toast.light { background: #fff; color: #1f2328; border-color: rgba(31,35,40,.12); }
      .toast.dark { background: #26272b; color: #ececed; border-color: rgba(255,255,255,.12); }
      .toast .title { font-weight: 600; }
      .toast .detail { margin-top: 2px; opacity: .78; white-space: pre-wrap; word-break: break-word; }
      .toast.error { border-left: 3px solid #d1453b; }
      .toast.warning { border-left: 3px solid #c98a12; }
      @keyframes in { from { opacity: 0; transform: translateY(6px); } }
    </style><div class="stack"></div>`
    root.appendChild(host)
    layer = shadow.querySelector('.stack')
    return layer
  }
  const showToast = ({ title = '', detail = '', severity = 'info', theme = 'light', durationMs = 4000 }) => {
    const item = document.createElement('div')
    item.className = `toast ${theme === 'dark' ? 'dark' : 'light'} ${severity}`
    const head = document.createElement('div')
    head.className = 'title'
    head.textContent = title
    item.append(head)
    if (detail) {
      const body = document.createElement('div')
      body.className = 'detail'
      body.textContent = detail
      item.append(body)
    }
    item.addEventListener('click', () => item.remove())
    ensureLayer().append(item)
    setTimeout(() => item.remove(), Math.max(1500, durationMs))
  }
  Object.defineProperty(window, '__kodeHostReceive', {
    value: message => {
      if (message?.type === 'toast') showToast(message)
      window.dispatchEvent(new CustomEvent('kode-host', { detail: message }))
    },
  })

  // Window dragging: the view covers Kode's titlebar.
  if (config.drag) {
    const interactive = 'button,a,input,textarea,select,summary,[role=button],[role=tab],[contenteditable]'
    const skip = config.drag.exclude ? `${interactive},${config.drag.exclude}` : interactive
    const inRegion = target => target instanceof Element && target.closest(config.drag.selector) && !target.closest(skip)
    const invoke = command => window.__TAURI_INTERNALS__?.invoke(command).catch(() => {})
    document.addEventListener('mousedown', event => {
      if (event.button !== 0 || event.detail > 1 || !inRegion(event.target)) return
      event.preventDefault()
      invoke('plugin:window|start_dragging')
    }, true)
    document.addEventListener('dblclick', event => {
      if (inRegion(event.target)) invoke('plugin:window|internal_toggle_maximize')
    }, true)
  }
})()
