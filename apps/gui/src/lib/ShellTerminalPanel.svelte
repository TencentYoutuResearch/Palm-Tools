<script lang="ts">
  /**
   * ShellTerminalPanel.svelte —— 工作区检查器底部的 shell 终端面板。
   *
   * 独立于主终端 session 系统:用 shellIpc 管理轻量 shell PTY,
   * 不走 kode-core 的 Session/CoreEvent/jsonl 体系。
   *
   * 特性:
   *   - 多开(每个 tab 一个独立 shell PTY),tab 栏在顶部,双击重命名
   *   - per-session 缓存(shellStateCache):切换 session 时保存/恢复终端列表
   *   - shell PTY 在 session 切换时保持存活,切回时重新 subscribe + ring buffer 回放
   *   - 字体大小可调(Cmd+= / Cmd+- / Cmd+0,持久化到 localStorage)
   *
   * xterm.js 初始化逻辑从 Terminal.svelte 精简而来:
   *   - 保留:lazy import、buildXtermTheme、IME #5887 patch、modifier-scroll patch、
   *           waitForLayout、safeFit、ResizeObserver 50ms debounce、MIN_COLS/MIN_ROWS
   *   - 去掉:screen snapshot(ring buffer 回放替代)、link provider、search addon、
   *           viewport repair(主终端专用,shell 终端不需要)
   */
  import { onDestroy, onMount } from 'svelte'
  import { shellIpc, type ShellId } from './ipc'
  import type { TabInfo } from './sessions'
  import Icon from './Icon.svelte'

  type Props = {
    tab: TabInfo | null
    isDark: boolean
    onClose: () => void
  }
  let { tab, isDark, onClose }: Props = $props()

  type ShellTerminalTab = {
    id: ShellId
    title: string
    cwd: string
  }
  type ShellTerminalState = {
    terminals: ShellTerminalTab[]
    activeId: ShellId | null
  }

  /// 按 session 缓存终端面板状态,跨 tab 切换 + 跨组件 unmount 存活。
  /// 只缓存"终端列表 + activeId",shell PTY 在 Rust 后端保持存活,
  /// 切回时重新 subscribe(ring buffer 回放最近输出)。
  const shellStateCache = new Map<number, ShellTerminalState>()

  let terminals = $state<ShellTerminalTab[]>([])
  let activeTerminalId = $state<ShellId | null>(null)
  let prevTabId: number | null = null

  // xterm 实例 + 容器 + unsubscribe,按 shell ID 索引
  const termInstances = new Map<
    ShellId,
    { term: any; fitAddon: any; unsub: (() => Promise<void>) | null; resizeObs: ResizeObserver | null; container: HTMLDivElement | null; markDisposed: () => void }
  >()
  let containerEls = new Map<ShellId, HTMLDivElement>()
  // 正在 init 的 shell id,防止并发 init(action 触发 + effect fallback 同时跑)
  const initializing = new Set<ShellId>()

  /// Svelte action:元素 mount 时注册到 containerEls,unmount 时移除。
  /// init xterm 也在这里触发 —— 不能放 $effect 里,因为 Svelte 5 后续更新里
  /// effect 在 DOM 更新**之前**跑,此时 containerEls 还是旧值,init 会被跳过。
  /// action 在元素插入后同步执行,container 一定就绪。
  function registerContainer(node: HTMLDivElement, id: ShellId) {
    containerEls.set(id, node)
    // container 就绪,立即触发 init(防并发守卫在 initShellTerminal 内)
    if (!termInstances.has(id) && !initializing.has(id)) {
      initShellTerminal(id, node).catch((e) =>
        console.error('[shell-term] init failed:', e),
      )
    }
    return {
      destroy() {
        containerEls.delete(id)
      },
    }
  }

  const MIN_COLS = 20
  const MIN_ROWS = 5

  // ── 字体(全局共享,持久化到 localStorage)──────────────────
  const FONT_SIZE_KEY = 'kode.shellTerminal.fontSize'
  const FONT_FAMILY_KEY = 'kode.shellTerminal.fontFamily'
  const FONT_SIZE_DEFAULT = 13
  const FONT_SIZE_MIN = 8
  const FONT_SIZE_MAX = 32
  let fontSize = $state<number>(loadFontSize())
  let fontFamily = $state<string>(loadFontFamily())

  /// 常见等宽字体预设,作为下拉的默认选项。
  /// queryLocalFonts() 可能不可用(Tauri WKWebView 权限),此时只有这些预设。
  const MONO_FONT_PRESETS = [
    'JetBrains Mono',
    'SF Mono',
    'Menlo',
    'Monaco',
    'Courier New',
    'Fira Code',
    'Cascadia Code',
    'IBM Plex Mono',
    'Source Code Pro',
    'Hack',
    'Meslo LG M',
    'monospace',
  ]

  /// 系统已安装的字体列表(通过 queryLocalFonts API 枚举)。
  /// queryLocalFonts 需要用户在浏览器里授权;Tauri 里一般直接可用。
  let systemFonts = $state<string[]>([])
  let fontDropdownOpen = $state(false)

  async function loadSystemFonts() {
    try {
      const query = (window as any).queryLocalFonts
      if (typeof query !== 'function') return
      const faces: FontFace[] = await query()
      const families = new Set<string>()
      for (const f of faces) {
        if (f.family) families.add(f.family)
      }
      // 去重 + 排序,合并预设
      const all = new Set([...MONO_FONT_PRESETS, ...families])
      systemFonts = [...all].sort((a, b) => a.localeCompare(b))
    } catch {
      // 权限拒绝或 API 不存在,静默降级到预设列表
    }
  }

  function loadFontSize(): number {
    try {
      const v = localStorage.getItem(FONT_SIZE_KEY)
      if (v) {
        const n = parseInt(v, 10)
        if (n >= FONT_SIZE_MIN && n <= FONT_SIZE_MAX) return n
      }
    } catch {}
    return FONT_SIZE_DEFAULT
  }
  function loadFontFamily(): string {
    try {
      const v = localStorage.getItem(FONT_FAMILY_KEY)
      if (v) return v
    } catch {}
    return 'JetBrains Mono'
  }
  function saveFontSize() {
    try { localStorage.setItem(FONT_SIZE_KEY, String(fontSize)) } catch {}
  }
  function saveFontFamily() {
    try { localStorage.setItem(FONT_FAMILY_KEY, fontFamily) } catch {}
  }
  function selectFontFamily(name: string) {
    fontFamily = name
    saveFontFamily()
    fontDropdownOpen = false
    for (const { term, fitAddon, container } of termInstances.values()) {
      try {
        term.options.fontFamily = `${name}, monospace`
        if (container?.offsetWidth && container?.offsetHeight) {
          try { fitAddon?.fit() } catch {}
        }
      } catch {}
    }
  }
  function adjustFontSize(delta: number) {
    const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, fontSize + delta))
    if (next === fontSize) return
    fontSize = next
    saveFontSize()
    for (const { term, fitAddon, container } of termInstances.values()) {
      try {
        term.options.fontSize = fontSize
        if (container?.offsetWidth && container?.offsetHeight) {
          try { fitAddon?.fit() } catch {}
        }
      } catch {}
    }
  }
  function resetFontSize() {
    fontSize = FONT_SIZE_DEFAULT
    saveFontSize()
    for (const { term, fitAddon, container } of termInstances.values()) {
      try {
        term.options.fontSize = fontSize
        if (container?.offsetWidth && container?.offsetHeight) {
          try { fitAddon?.fit() } catch {}
        }
      } catch {}
    }
  }

  let destroyed = false

  // ── xterm theme(从 Terminal.svelte 复制,硬编码不读 CSS 变量)──────────
  const ansiDark = {
    black: '#1A1D1B', red: '#FF6B6B', green: '#71D47D', yellow: '#E6B450',
    blue: '#8FD3FF', magenta: '#D8B4FE', cyan: '#7DD3C7', white: '#C9CEC8',
    brightBlack: '#70776F', brightRed: '#FF8585', brightGreen: '#9FE870',
    brightYellow: '#F0C96A', brightBlue: '#A9DEFF', brightMagenta: '#E4C7FF',
    brightCyan: '#99E5DB', brightWhite: '#EDEFEB',
  }
  const ansiLight = {
    black: '#171A18', red: '#C24141', green: '#216E45', yellow: '#9A6700',
    blue: '#146C94', magenta: '#7E4CB8', cyan: '#087A6D', white: '#5F675F',
    brightBlack: '#7A827B', brightRed: '#D95656', brightGreen: '#2F8F58',
    brightYellow: '#B7791F', brightBlue: '#1D84B5', brightMagenta: '#935FD0',
    brightCyan: '#0F9486', brightWhite: '#171A18',
  }
  function buildXtermTheme(dark: boolean) {
    return dark
      ? { background: '#0D0F0E', foreground: '#EDEFEB', cursor: '#9FE870',
          cursorAccent: '#0D0F0E', selectionBackground: 'rgba(159, 232, 112, 0.48)', ...ansiDark }
      : { background: '#F7F7F3', foreground: '#171A18', cursor: '#216E45',
          cursorAccent: '#F7F7F3', selectionBackground: 'rgba(33, 110, 69, 0.42)', ...ansiLight }
  }

  function waitForLayout(el: HTMLElement): Promise<void> {
    return new Promise((resolve) => {
      let tries = 0
      const tick = () => {
        if (!el || (el.offsetWidth > 0 && el.offsetHeight > 0)) { resolve(); return }
        if (++tries > 30) { resolve(); return }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }

  function getRenderDimensions(term: any) {
    return (term as any)?._core?._renderService?._renderer?.value?.dimensions
  }
  function hasHealthyRenderDimensions(term: any): boolean {
    const dims = getRenderDimensions(term)
    return !!(
      dims?.css?.cell?.width > 0 && dims?.css?.cell?.height > 0 &&
      dims?.css?.canvas?.height > 0 && dims?.device?.cell?.height > 0
    )
  }
  function safeFit(term: any, fitAddon: any): boolean {
    if (!term || !fitAddon || !hasHealthyRenderDimensions(term)) return false
    try { fitAddon.fit(); return true } catch { return false }
  }

  /// 初始化一个 shell 的 xterm 实例。在容器 DOM 就绪后调用(registerContainer action 触发)。
  /// 重新初始化时(切回 session),先清空容器 innerHTML,防止旧 xterm DOM 残留。
  /// 关键:每个 await 后都要检查 container 是否还有效(containerEls.get(shellId) === container)。
  /// 切 tab 时 container 会被 action destroy 删除并换成新的,旧 init 必须中止,否则 xterm 挂到离队 DOM。
  async function initShellTerminal(shellId: ShellId, container: HTMLDivElement) {
    if (initializing.has(shellId) || termInstances.has(shellId)) return
    initializing.add(shellId)
    try {
      // 清空容器:上次 term.dispose() 可能残留 xterm 内部 DOM
      container.innerHTML = ''

      try {
        await (document as any).fonts?.load?.('14px JetBrains Mono')
      } catch {}
      if (containerEls.get(shellId) !== container) return

      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ])
      if (containerEls.get(shellId) !== container) return
      await import('@xterm/xterm/css/xterm.css')
      if (containerEls.get(shellId) !== container) return

      const term = new Terminal({
        fontFamily: `"${fontFamily}", "SF Mono", Menlo, monospace`,
        fontSize: fontSize,
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 5000,
        theme: buildXtermTheme(isDark),
        convertEol: false,
        minimumContrastRatio: 4.5,
      })

      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(container)
      if (containerEls.get(shellId) !== container) { term.dispose(); return }

    // WebGL 优先
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl')
      if (containerEls.get(shellId) !== container || !term) { term?.dispose(); return }
      const wg = new WebglAddon()
      wg.onContextLoss(() => { try { wg.dispose() } catch {} })
      term.loadAddon(wg)
    } catch (e) {
      console.warn('[shell-term] WebGL addon failed:', e)
    }

    // IME-fix #5887(从 Terminal.svelte 复制)
    try {
      const core: any = (term as any)._core
      const compHelper = core?._compositionHelper
      const origInputEvent = core?._inputEvent?.bind(core)
      if (core && compHelper && origInputEvent) {
        core._inputEvent = function (ev: InputEvent): boolean {
          const composing = !!(compHelper._isComposing || compHelper._isSendingComposition)
          if (ev.data && ev.inputType === 'insertText' && !composing &&
              !core.optionsService.rawOptions.screenReaderMode) {
            if (core._keyPressHandled) return false
            core._unprocessedDeadKey = false
            core.coreService.triggerDataEvent(ev.data, true)
            try { core.textarea.value = '' } catch {}
            try { (ev as any).preventDefault?.() } catch {}
            try { (ev as any).stopPropagation?.() } catch {}
            return true
          }
          return origInputEvent(ev)
        }
      }
    } catch (e) {
      console.warn('[shell-term] IME #5887 patch failed', e)
    }

    // modifier-scroll patch(从 Terminal.svelte 复制)
    try {
      const core = (term as any)._core
      const origScrollToBottom = term.scrollToBottom.bind(term)
      const origCoreScrollToBottom = core?.scrollToBottom?.bind(core)
      let _modifierKeyHeld = false
      const _onModKeyDown = (e: KeyboardEvent) => {
        _modifierKeyHeld = ['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)
      }
      const _onModKeyUp = (e: KeyboardEvent) => {
        if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) _modifierKeyHeld = false
      }
      window.addEventListener('keydown', _onModKeyDown, { capture: true })
      window.addEventListener('keyup', _onModKeyUp, { capture: true })
      ;(term as any).scrollToBottom = function () {
        if (_modifierKeyHeld) return
        origScrollToBottom()
      }
      if (core && origCoreScrollToBottom) {
        core.scrollToBottom = function () {
          if (_modifierKeyHeld) return
          origCoreScrollToBottom()
        }
      }
      const _origDestroy = term.dispose.bind(term)
      ;(term as any).dispose = function () {
        window.removeEventListener('keydown', _onModKeyDown, { capture: true } as any)
        window.removeEventListener('keyup', _onModKeyUp, { capture: true } as any)
        if (core && origCoreScrollToBottom) core.scrollToBottom = origCoreScrollToBottom
        _origDestroy()
      }
    } catch (e) {
      console.warn('[shell-term] modifier-scroll patch failed:', e)
    }

    // 字体缩放快捷键拦截(Cmd+= / Cmd+- / Cmd+0)
    function onKeydown(e: KeyboardEvent) {
      if (e.metaKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault()
          adjustFontSize(1)
        } else if (e.key === '-') {
          e.preventDefault()
          adjustFontSize(-1)
        } else if (e.key === '0') {
          e.preventDefault()
          resetFontSize()
        }
      }
    }
    container.addEventListener('keydown', onKeydown)

    await waitForLayout(container)
    if (containerEls.get(shellId) !== container || !term) return
    if (container.offsetWidth > 0 && container.offsetHeight > 0) {
      safeFit(term, fitAddon)
    }

    // 输入回写
    term.onData((data: string) => {
      const bytes = new TextEncoder().encode(data)
      shellIpc.write(shellId, bytes).catch(console.error)
    })

    // 订阅字节流(ring buffer 会先回放)
    // alive flag:disposeShellTerminal 同步置 false 后,Rust 侧 unsub 还在途,
    // 这段时间到达的旧 channel 字节直接丢弃,避免写已 dispose 的 term。
    const state = { alive: true }
    const unsub = await shellIpc.subscribeBytes(shellId, (bytes) => {
      if (!state.alive || !term) return
      term.write(bytes)
    })
    // subscribe 期间可能切走了,再检查一次
    if (containerEls.get(shellId) !== container) {
      state.alive = false
      try { term.dispose() } catch {}
      unsub?.().catch(() => {})
      return
    }

    // 首次 resize
    if (term.cols >= MIN_COLS && term.rows >= MIN_ROWS) {
      shellIpc.resize(shellId, term.cols, term.rows).catch(() => {})
    }

    // ResizeObserver 50ms debounce
    let resizeTimer: number | null = null
    const resizeObs = new ResizeObserver(() => {
      if (resizeTimer != null) clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        if (!state.alive || !term) return
        if (container.offsetWidth === 0 || container.offsetHeight === 0) return
        if (!safeFit(term, fitAddon)) return
        if (term.cols < MIN_COLS || term.rows < MIN_ROWS) return
        shellIpc.resize(shellId, term.cols, term.rows).catch(() => {})
      }, 50)
    })
    resizeObs.observe(container)

    termInstances.set(shellId, { term, fitAddon, unsub, resizeObs, container, markDisposed: () => { state.alive = false } })
    } finally {
      initializing.delete(shellId)
    }
  }

  /// 清理一个 shell 的 xterm 实例(不杀 PTY,只断开前端)。
  /// 必须同步:切 session 时 registerContainer action 重建 DOM 后会检查
  /// `!termInstances.has(id)`,若这里还 await 着 unsub IPC,termInstances 没及时 delete,
  /// action 会跳过 init → 空白。
  /// unsub 不 await:IPC 消息按发送顺序到达 Rust,unsub 一定先于后续 subscribe 被处理,
  /// 所以不会出现旧 unsub 把新 channel 清掉的反序。
  function disposeShellTerminal(shellId: ShellId) {
    const inst = termInstances.get(shellId)
    if (!inst) return
    inst.markDisposed?.()
    inst.resizeObs?.disconnect()
    try { inst.term.dispose() } catch {}
    termInstances.delete(shellId)
    inst.unsub?.().catch(() => {})
  }

  // ── tab 操作 ──────────────────────────────────────────────

  async function newTerminal() {
    if (!tab?.cwd) return
    const cols = 80, rows = 24
    const id = await shellIpc.spawn(tab.cwd, cols, rows)
    const newTab: ShellTerminalTab = { id, title: 'Shell', cwd: tab.cwd }
    terminals = [...terminals, newTab]
    activeTerminalId = id
  }

  // 点击右上角终端图标直接开 shell:面板挂载时若当前 tab 没有终端,自动 spawn 一个。
  // 仅在挂载时触发一次;用户手动关掉全部 shell 后仍保留 empty-state 按钮作为再开入口。
  onMount(() => {
    if (terminals.length === 0 && tab?.cwd) {
      newTerminal().catch((e) => console.error('[shell-term] auto-spawn failed:', e))
    }
  })

  async function closeTerminal(id: ShellId) {
    disposeShellTerminal(id)
    await shellIpc.kill(id).catch(() => {})
    terminals = terminals.filter((t) => t.id !== id)
    containerEls.delete(id)
    if (activeTerminalId === id) {
      activeTerminalId = terminals[0]?.id ?? null
    }
  }

  // ── 重命名 ──────────────────────────────────────────────
  let renamingId = $state<ShellId | null>(null)
  let renameValue = $state('')
  let renameInputEl: HTMLInputElement | null = $state(null)

  function startRename(id: ShellId, currentTitle: string) {
    renamingId = id
    renameValue = currentTitle
    // 等 input 渲染后聚焦 + 全选
    requestAnimationFrame(() => {
      renameInputEl?.focus()
      renameInputEl?.select()
    })
  }
  function commitRename() {
    if (renamingId == null) return
    const v = renameValue.trim()
    if (v) {
      terminals = terminals.map((t) =>
        t.id === renamingId ? { ...t, title: v } : t,
      )
    }
    renamingId = null
  }
  function cancelRename() {
    renamingId = null
  }

  // ── per-session 缓存:save / restore ──────────────────────

  $effect(() => {
    const currentTabId = tab?.id ?? null

    // 离开旧 tab:先 unsubscribe 所有 shell(PTY 保持存活),保存列表
    if (prevTabId != null && prevTabId !== currentTabId) {
      shellStateCache.set(prevTabId, {
        terminals: [...terminals],
        activeId: activeTerminalId,
      })
      // 断开所有 xterm 订阅(PTY 在 Rust 保持存活)
      for (const t of terminals) {
        disposeShellTerminal(t.id)
      }
    }

    if (!tab) {
      terminals = []
      activeTerminalId = null
      prevTabId = currentTabId
      return
    }

    // 恢复缓存
    if (currentTabId !== prevTabId) {
      const saved = currentTabId != null ? shellStateCache.get(currentTabId) : undefined
      if (saved) {
        terminals = saved.terminals
        activeTerminalId = saved.activeId
      } else {
        terminals = []
        activeTerminalId = null
      }
    }
    prevTabId = currentTabId
  })

  // isDark 变化时更新主题
  $effect(() => {
    void isDark
    for (const { term } of termInstances.values()) {
      try { term.options.theme = buildXtermTheme(isDark) } catch {}
    }
  })

  // fontSize 变化时同步到所有 xterm 实例
  $effect(() => {
    void fontSize
    for (const { term } of termInstances.values()) {
      try { term.options.fontSize = fontSize } catch {}
    }
  })

  onDestroy(() => {
    destroyed = true
    for (const { unsub, resizeObs, term } of termInstances.values()) {
      resizeObs?.disconnect()
      unsub?.().catch(() => {})
      try { term.dispose() } catch {}
    }
    termInstances.clear()
  })
  // 点击外部关闭字体下拉
  function onGlobalClick(e: MouseEvent) {
    if (fontDropdownOpen) {
      const target = e.target as HTMLElement
      if (!target?.closest('.font-picker')) {
        fontDropdownOpen = false
      }
    }
  }
</script>

<svelte:window onclick={onGlobalClick} />

<div class="shell-terminal-panel">
  <!-- 顶部 tab 栏 -->
  <div class="tab-bar">
    <div class="tabs-scroll">
      {#each terminals as t (t.id)}
        <div class="tab-item" class:active={t.id === activeTerminalId}>
          {#if renamingId === t.id}
            <input
              bind:this={renameInputEl}
              bind:value={renameValue}
              onkeydown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
              }}
              onblur={commitRename}
              spellcheck="false"
            />
          {:else}
            <button
              class="tab-label"
              onclick={() => (activeTerminalId = t.id)}
              ondblclick={(e) => { e.stopPropagation(); startRename(t.id, t.title) }}
              title={t.title + ' (double-click to rename)'}
            >
              {t.title}
            </button>
          {/if}
          <button class="tab-close" onclick={() => closeTerminal(t.id)} title="Close">
            <Icon name="x" size={10} />
          </button>
        </div>
      {/each}
    </div>
    <div class="tab-bar-actions">
      <!-- 字体选择下拉 -->
      <div class="font-picker">
        <button
          class="tab-action-btn font-trigger"
          title="Font: {fontFamily} (click to change)"
          onclick={(e) => {
            e.stopPropagation()
            fontDropdownOpen = !fontDropdownOpen
            if (fontDropdownOpen && systemFonts.length === 0) {
              loadSystemFonts()
            }
          }}
        >
          <span class="font-label">{fontFamily}</span>
          <Icon name="chevron-down" size={10} />
        </button>
        {#if fontDropdownOpen}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div class="font-dropdown" onclick={(e) => e.stopPropagation()}>
            {#each (systemFonts.length > 0 ? systemFonts : MONO_FONT_PRESETS) as f}
              <button
                class="font-option"
                class:active={f === fontFamily}
                style="font-family: '{f}', monospace"
                onclick={() => selectFontFamily(f)}
              >
                {f}
                {#if f === fontFamily}<Icon name="check" size={11} />{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <button class="tab-action-btn" onclick={newTerminal} title="New terminal">
        <Icon name="plus" size={13} />
      </button>
    </div>
  </div>

  <!-- 终端区域 -->
  <div class="terminal-area">
    {#each terminals as t (t.id)}
      <div
        class="term-container"
        class:active={t.id === activeTerminalId}
        use:registerContainer={t.id}
      ></div>
    {/each}
    {#if terminals.length === 0}
      <div class="empty-hint">
        <button class="new-hint-btn" onclick={newTerminal}>
          <Icon name="terminal" size={20} />
          <span>Open shell</span>
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .shell-terminal-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg-base);
  }

  /* ── 顶部 tab 栏 ── */
  /* overflow: visible —— 不能 hidden,否则字体下拉(font-dropdown,absolute 向下展开)
     会被 30px 高的 tab-bar 裁掉。水平裁剪由 .tabs-scroll 自己的 overflow-x:auto 负责。 */
  .tab-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0;
    height: 30px;
    padding: 0 4px 0 6px;
    border-bottom: 1px solid color-mix(in srgb, var(--fg-primary) 8%, transparent);
    background: var(--bg-sidebar);
    overflow: visible;
  }
  .tabs-scroll {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs-scroll::-webkit-scrollbar { display: none; }
  .tab-item {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 24px;
    padding: 0 4px 0 8px;
    border-radius: var(--rad-sm);
    background: transparent;
    border: 1px solid transparent;
    transition: background var(--t-fast), border-color var(--t-fast);
  }
  .tab-item:hover {
    background: var(--bg-tab-hover);
  }
  .tab-item.active {
    background: color-mix(in srgb, var(--acc) 12%, transparent);
    border-color: color-mix(in srgb, var(--acc) 24%, transparent);
  }
  .tab-label {
    border: none;
    background: transparent;
    color: var(--fg-secondary);
    font: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
    padding: 0;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tab-item.active .tab-label {
    color: var(--fg-primary);
  }
  .tab-item input {
    width: 80px;
    border: 1px solid var(--acc);
    border-radius: 3px;
    background: var(--bg-input);
    color: var(--fg-primary);
    font: inherit;
    font-size: var(--fs-xs);
    padding: 0 4px;
    outline: none;
  }
  .tab-close {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--fg-tertiary);
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--t-fast), background var(--t-fast), color var(--t-fast);
  }
  .tab-item:hover .tab-close { opacity: 1; }
  .tab-close:hover {
    background: var(--st-err);
    color: var(--fg-on-accent);
  }
  .tab-bar-actions {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: 4px;
  }
  .tab-action-btn {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: var(--rad-sm);
    background: transparent;
    color: var(--fg-secondary);
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .tab-action-btn:hover {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }

  /* ── 字体选择下拉 ── */
  .font-picker {
    position: relative;
    flex: 0 0 auto;
  }
  .font-trigger {
    width: auto;
    height: 24px;
    gap: 3px;
    padding: 0 6px;
    font-size: 11px;
  }
  .font-label {
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .font-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    min-width: 180px;
    max-height: 280px;
    overflow-y: auto;
    background: var(--bg-elevated);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    box-shadow: var(--sh-md);
    z-index: 100;
    padding: 4px;
  }
  .font-option {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 8px;
    border: none;
    border-radius: var(--rad-sm);
    background: transparent;
    color: var(--fg-secondary);
    cursor: pointer;
    font-size: 12px;
    text-align: left;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .font-option:hover {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
  .font-option.active {
    color: var(--acc);
  }

  /* ── 终端区域 ── */
  .terminal-area {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
    overflow: hidden;
  }
  .term-container {
    position: absolute;
    inset: 0;
    display: none;
  }
  .term-container.active {
    display: block;
  }
  .empty-hint {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .new-hint-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 16px 24px;
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    background: var(--bg-elevated);
    color: var(--fg-secondary);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-sm);
    transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
  }
  .new-hint-btn:hover {
    background: var(--bg-hover);
    color: var(--fg-primary);
    border-color: var(--acc);
  }
</style>
