<script lang="ts">
  /**
   * Terminal.svelte —— 一个 xterm.js 容器 + Tauri PTY 双向桥接。
   *
   * Phase 3 策略:本组件 mount 一个 xterm 实例。父组件让已打开 tab 常驻 mounted:
   *   - 首次 mount 一个 sessionId 时,先 invoke get_screen_snapshot 拿到当前 vt100 屏幕,
   *     term.write(snapshot) 一次性重建画面
   *   - 之后再 subscribe 字节流,后端按 ~8ms coalesce 推过来
   *
   * 关键性能点(对应 ROADMAP Phase 2):
   *   - lazy import xterm(首屏不阻塞)
   *   - WebGL addon 失败 fallback canvas
   *   - 字体加载完成后再 mount,避免重排
   *   - resize debounce 50ms
   *   - HiDPI 切显示器自动 refresh
   *   - 字节流走 Channel<Uint8Array>,直接 term.write(Uint8Array)
   */
  import { onMount, onDestroy } from 'svelte'
  import { get } from 'svelte/store'
  import { ipc, type SessionId, type EndpointId } from './ipc'
  import { tabs } from './sessions'
  import {
    TERMINAL_FONT_SIZE_DEFAULT,
    TERMINAL_FONT_SIZE_MIN,
    TERMINAL_FONT_SIZE_MAX,
    buildXtermTheme,
    loadTerminalAppearance,
    onTerminalSettingsChanged,
    updateTerminalFontSize,
    type TerminalAppearance,
  } from './terminal_settings'
  import { TerminalAnsiThemeAdapter } from './terminal_ansi_theme'

  /**
   * 健康尺寸下限。低于此值的 cols/rows 一律视为容器还没准备好,
   * 此时绝不能把这个尺寸 push 给后端 PTY —— 否则子进程会按极小宽度排版,
   * 已经写进 vt100 buffer 的行不会 reflow,导致"4-5 字一行无法恢复"。
   */
  const MIN_COLS = 20
  const MIN_ROWS = 5

  type Props = {
    sessionId: SessionId
    visible: boolean
    isDark?: boolean
    /// Phase 11.2:本 tab 跑哪个 transport 上。Local 走 sync write_input,Remote
    /// 走 async write_input_remote。**字节流接收路径不变** —— 远端 transport 已经
    /// 把 WS 上来的字节灌进 BridgeCtx::core_tx,这边订阅 byte_buffer Channel 一切
    /// 照旧。
    endpointId?: EndpointId
  }
  let { sessionId, visible, isDark = true, endpointId }: Props = $props()

  let containerEl: HTMLDivElement
  let term: any = null
  let fitAddon: any = null
  // WKWebView 会限制同一页面可同时持有的 WebGL context 数。所有常驻 tab 都
  // load WebglAddon 时,较早的 context 会被浏览器回收;addon 虽会 fallback 到
  // DOM renderer,但 WKWebView 下该降级路径可能把 true-color 字形画成默认前景色。
  // 因此只允许当前可见 tab 持有 WebGL,后台 tab 仍持续解析/保存 PTY 字节。
  let webglAddon: any = null
  let webglLoadGeneration = 0
  let destroyed = false

  // 字体设置:从 localStorage 恢复;所有 Terminal 实例共享同一组设置。
  const initialAppearance = loadTerminalAppearance('pty')
  let appearance = $state<TerminalAppearance>(initialAppearance)
  let fontSize = $state(initialAppearance.fontSize)
  let fontFamily = $state(initialAppearance.fontFamily)

  let resizeObserver: ResizeObserver | null = null
  let resizeTimer: number | null = null
  let viewportRepairRaf: number | null = null
  let pendingViewportStick = false
  let dprMql: MediaQueryList | null = null
  let bytesUnsubscribe: (() => Promise<void>) | null = null
  let terminalSettingsUnsubscribe: (() => void) | null = null
  const ansiThemeAdapter = new TerminalAnsiThemeAdapter()
  // Cmd 键状态监听器(组件级,以便 onDestroy 时清理)
  let _onCmdDown: ((e: KeyboardEvent) => void) | null = null
  let _onCmdUp: ((e: KeyboardEvent) => void) | null = null
  let _onWheelFallback: ((e: WheelEvent) => void) | null = null
  let cmdHeld = $state(false)

  // ── 搜索(Ctrl/Cmd+F)──────────────────────────────────────────
  // 防卡顿三件套(业界通用):
  //   1. 输入防抖(SEARCH_DEBOUNCE_MS)—— 不在每次按键触发全量计数
  //   2. 代际计数器(searchGen)—— 新输入到来时自增,异步回调发现 gen 不符即丢弃
  //   3. 分块异步计数(SEARCH_COUNT_CHUNK_LINES 行/帧 + rAF 让出主线程)
  // findNext/findPrevious 本身同步且快(<10ms,只选中+滚动到当前命中),不走
  // decorations —— addon 的 decorations 会触发同步 _highlightAllMatches 全量
  // 高亮扫描,长 scrollback 下直接阻塞主线程。匹配计数走我们自己的 chunked scan。
  const SEARCH_DEBOUNCE_MS = 250
  const SEARCH_COUNT_CHUNK_LINES = 500
  const SEARCH_POSITION_CAP = 10000
  let searchAddon: any = null
  let searchOpen = $state(false)
  let searchQuery = $state('')
  let searchCaseSensitive = $state(false)
  let searchRegex = $state(false)
  let searchMatchTotal = $state(0)
  let searchMatchIdx = $state(0)        // 1-based;0 = 无命中
  let searchSearching = $state(false)
  let searchOverCap = $state(false)
  let searchInvalidRegex = $state(false)
  let searchInputEl: HTMLInputElement | null = $state(null)
  // 非 reactive 内部态(避免无谓 reflow)
  let searchGen = 0
  let matchPositions: { row: number; col: number }[] = []
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let countRafId: number | null = null
  // 多行搜索专用:query 含 \n 时走自定义扫描(绕过 addon-search)
  let mlMatchPositions: { row: number; col: number }[] = []
  let mlSearchRafId: number | null = null

  /**
   * 等容器真正有布局尺寸再 resolve。
   * 用 rAF + 短轮询(最多 ~500ms),覆盖以下边界:
   *   - 首次 mount 时 svelte 刚把节点插入 DOM,offsetWidth 还是 0
   *   - 父级 BackendChooser 关闭那一拍
   */
  function waitForLayout(el: HTMLElement): Promise<void> {
    return new Promise((resolve) => {
      let tries = 0
      const tick = () => {
        if (!el || (el.offsetWidth > 0 && el.offsetHeight > 0)) {
          resolve()
          return
        }
        if (++tries > 30) {
          // 超时也 resolve —— 让上层逻辑用 MIN_COLS/MIN_ROWS 守卫兜底
          resolve()
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }

  async function initTerminal() {
    // 1) 先等字体加载完(避免首次绘制后字体替换重排)
    try {
      await (document as any).fonts?.load?.(`${fontSize}px ${fontFamily}`)
    } catch {}
    if (destroyed) return

    // 2) lazy import xterm —— 首屏的 main.ts 不会带上这些字节
    const [{ Terminal }, { FitAddon }, { SearchAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-search'),
    ])
    if (destroyed) return
    await import('@xterm/xterm/css/xterm.css')
    if (destroyed) return

    // Theme values come from terminal_settings.ts and stay hardcoded there.
    // Do not read CSS variables here; App theme effects can race terminal init.
    term = new Terminal({
      fontFamily,
      fontSize: fontSize,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: buildXtermTheme(isDark, appearance.themeMode),
      // 让 xterm 直接吃 UTF-8 二进制(避免 string 路径的 UTF-16 重编码)
      convertEol: false,
      // 强制最小对比度 —— 子进程常用 24-bit RGB 转义序列(\x1b[38;2;...)输出
      // "在 dark 终端上好看的浅色"(白/灰/淡蓝)。这种 true-color 不走我们的
      // ANSI 调色板,xterm 按字面 RGB 渲染,落到 light 背景(#F6F6F7)上就消失。
      // minimumContrastRatio=4.5(WCAG AA)让 xterm 自动调整任何对比度不足的
      // 前景色直到达标。dark 模式下浅色字符在深背景上对比度本来就够,等同无操作;
      // light 模式下浅色字符会被自动压暗到可读。
      minimumContrastRatio: 4.5,
      // 覆盖 xterm 内置 linkHandler。
      // 默认行为:xterm 对 OSC 8 超链接 + WebLinkAddon 识别的 URL 调
      // window.confirm("Do you want to navigate to …") —— Tauri WKWebView
      // 不允许 confirm,会抛 "dialog.confirm not allowed. Command not found"。
      // 我们自己的 registerLinkProvider 已经处理了所有链接,这里设一个空
      // handler 阻断 xterm 默认路径即可。Cmd+Click 由 activate 回调处理。
      linkHandler: {
        activate(_event: MouseEvent, uri: string) {
          // Cmd+Click 才打开;普通 click 不做任何事
          if (!_event?.metaKey) return
          ipc.openPath(uri).catch((err) => {
            console.warn('[term] linkHandler open failed:', err)
          })
        },
      },
    })

    fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    // 搜索 addon:findNext/findPrevious 只选中+滚动到当前命中(同步,快);
    // 不传 decorations,避免触发 addon 内部同步 _highlightAllMatches 全量扫描。
    // "X / N" 计数由 countMatchesChunked() 分块异步完成。
    searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)

    // **必须在 loadAddon(WebglAddon) 之前** open —— xterm 的 renderer 在 open() 时
    // 才被构建,WebglAddon.activate() 直接读 `this._renderer.value.dimensions` 来
    // 给 WebGL 算 cell size。如果 open 之前装 webgl:
    //   - renderer 还是 RendererProxy (deferred),`.value.dimensions` 是 undefined
    //   - 紧接着首帧字节流写入 → triggerSyncScrollArea → 命中 undefined 崩溃:
    //       TypeError: undefined is not an object (evaluating 'this._renderer.value.dimensions')
    // 修法:open() 先调,renderer 内部 _innerSetRenderer 先把 dimensions 填好,
    // 再异步加 WebglAddon。FitAddon 不读 renderer 内部,放 open 前后都行。
    term.open(containerEl)
    if (destroyed || !term) return

    // 3) 只给当前可见 tab 装 WebGL。后台 tab 常驻但不能各占一个 context,
    //    否则 WKWebView 达到上限后会随机回收较早 tab 的 context并触发丢色。
    //    必须在 open() **之后**装,理由见上面的注释。
    if (visible) await setWebglActive(true)

    // IME-fix #5887 —— 豆包 / 搜狗中文输入法**英文模式**连续打字丢第二个字符
    // 上游 issue: https://github.com/xtermjs/xterm.js/issues/5887
    //
    // 根因(读 node_modules/@xterm/xterm/src/browser/Terminal.ts 核对):
    //   1. 这类 IME 在英文模式下仍把 keystroke 报成 keyCode=229,且**不发**
    //      compositionstart/update/end —— xterm 走的是 `_handleAnyTextareaChanges` 路径
    //   2. 事件顺序是 `input → keydown`(豆包反序),不是常规 `keydown → input`
    //   3. xterm `_inputEvent` 的 gate `(!ev.composed || !this._keyDownSeen)` 在
    //      第二次连击时:上一次的 keyup 还没派发,_keyDownSeen 仍是 true,
    //      条件变 false → input 事件被静默丢
    //
    // 修:把 gate 从「上次 keydown 是否处理过」换成「是否真的在组词」。
    // 真正的中文组词时 _isComposing 会被 compositionstart 置 true,fallback 到
    // 原实现;非组词的 insertText 直接 emit,不再依赖 _keyDownSeen 时序。
    //
    // 收尾:emit 后必须清空 textarea.value,否则同 keystroke 触发的
    // `_handleAnyTextareaChanges` 会在 setTimeout 0 里再 emit 一次 diff(双发)。
    try {
      const core: any = (term as any)._core
      const compHelper = core?._compositionHelper
      const origInputEvent = core?._inputEvent?.bind(core)
      if (core && compHelper && origInputEvent) {
        core._inputEvent = function (ev: InputEvent): boolean {
          const composing = !!(compHelper._isComposing || compHelper._isSendingComposition)
          if (
            ev.data &&
            ev.inputType === 'insertText' &&
            !composing &&
            !core.optionsService.rawOptions.screenReaderMode
          ) {
            if (core._keyPressHandled) return false
            core._unprocessedDeadKey = false
            core.coreService.triggerDataEvent(ev.data, true)
            // 关键:清空 textarea —— 防止 path A 的 _handleAnyTextareaChanges
            // 在下一拍 setTimeout 0 里 diff 出同一段文本再 emit 一次。
            try { core.textarea.value = '' } catch {}
            try { (ev as any).preventDefault?.() } catch {}
            try { (ev as any).stopPropagation?.() } catch {}
            return true
          }
          return origInputEvent(ev)
        }
      } else {
        console.warn('[term] IME #5887 patch skipped: xterm internals not found')
      }
    } catch (e) {
      console.warn('[term] IME #5887 patch failed', e)
    }

    // patch:阻止 xterm 在按下 modifier-only 键(Cmd/Ctrl/Alt/Shift)时 scrollToBottom。
    //
    // xterm 的 browser/Terminal._keyDown 在每次 keydown 时调 this.scrollToBottom()
    // (即 _core.scrollToBottom),对于纯修饰键(metaKey/ctrlKey 等)本身不产生任何 PTY
    // 输出,但还是会把用户在 scrollback 里的位置抢回底部。
    //
    // 修法:同时 wrap _core.scrollToBottom(内部调用路径)和公开 term.scrollToBottom,
    // 在 modifier-only keydown 期间跳过。
    //
    // 注意:xterm 内部 _keyDown 调的是 this.scrollToBottom()(即 _core 的方法),
    // 而非公开 API term.scrollToBottom();只 patch 公开 API 不足以拦截内部调用。
    // modifier-only 的识别:若当前最近一次 keydown 的 key 属于
    // ['Meta','Control','Alt','Shift'],则视为 modifier-only。
    try {
      const core = (term as any)._core
      // 同时 patch 公开 API 和内部 _core,确保覆盖所有调用路径
      const origScrollToBottom = term.scrollToBottom.bind(term)
      const origCoreScrollToBottom = core?.scrollToBottom?.bind(core)
      let _modifierKeyHeld = false
      const _onModKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') {
          _modifierKeyHeld = true
        } else {
          // 有非修饰键加入(如 Cmd+K),不再视为 modifier-only,允许 scroll
          _modifierKeyHeld = false
        }
      }
      const _onModKeyUp = (e: KeyboardEvent) => {
        if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') {
          _modifierKeyHeld = false
        }
      }
      window.addEventListener('keydown', _onModKeyDown, { capture: true })
      window.addEventListener('keyup', _onModKeyUp, { capture: true })
      ;(term as any).scrollToBottom = function () {
        if (_modifierKeyHeld) return
        origScrollToBottom()
      }
      // patch _core.scrollToBottom — 这是 _keyDown 的实际调用路径
      if (core && origCoreScrollToBottom) {
        core.scrollToBottom = function () {
          if (_modifierKeyHeld) return
          origCoreScrollToBottom()
        }
      }
      // 清理(onDestroy 里已有 term.dispose,但 window listener 需要手动移除)
      const _origDestroy = term.dispose.bind(term)
      ;(term as any).dispose = function () {
        window.removeEventListener('keydown', _onModKeyDown, { capture: true })
        window.removeEventListener('keyup', _onModKeyUp, { capture: true })
        // 还原 _core.scrollToBottom
        if (core && origCoreScrollToBottom) {
          core.scrollToBottom = origCoreScrollToBottom
        }
        _origDestroy()
      }
    } catch (e) {
      console.warn('[term] modifier-scroll patch failed:', e)
    }

    // 关键:在容器还没完成首帧 layout 时(尤其是父组件切 chooser 那一拍),
    // offsetWidth 可能为 0,fitAddon.fit() 会算出
    // 极小的 cols(xterm 内部 MIN_COLS≈2),随后 ipc.resizeSession 会把后端 PTY
    // 缩成 ~2 cols → 子进程按 2 cols 排版输出 → 写进 vt100 后**已经被 wrap 的
    // 行无法 reflow**,即使尺寸恢复也是"4-5 字一行"且无法恢复。
    //
    // 防御:首次 fit 必须等到容器有真实尺寸再做。等一帧 + 兜底轮询。
    await waitForLayout(containerEl)
    if (destroyed || !term) return

    if (containerEl.offsetWidth > 0 && containerEl.offsetHeight > 0) {
      safeFit()
    }

    // 4) 输入回写到 PTY —— fire and forget
    //    JS 单线程保证 invoke 调用顺序;后端 write_input 是同步命令,
    //    在 IPC 线程上按到达顺序串行执行(参考 commands.rs 注释)。
    term.onData((data: string) => {
      const bytes = new TextEncoder().encode(data)
      ipc.writeInput(sessionId, bytes, endpointId).catch(console.error)
    })

    // 4.5) WKWebView 文本编辑快捷键拦截。
    //
    // **字母 / 数字 / 中文 / 标点全部走 xterm.js 标准路径**(textarea + composition
    // + input 事件 → term.onData → 上面的 invoke writeInput)。这里处理两类额外键:
    //
    // (A) 翻译成 PTY 控制序列的快捷键:
    //   - Cmd+← / Cmd+→:textarea 默认跳光标到行首/行尾,xterm 收不到 keystroke
    //   - Cmd+Backspace / Cmd+Delete:textarea 自删,PTY 不知情
    //   - Option+← / Option+→ / Option+Backspace / Option+Delete:同理
    //   - Esc 在 IME 非组合态:避免被 IME 层吞
    //
    // (B) 剪贴板操作(不产生 PTY 控制序列):
    //   - Cmd+C:有选中时复制到剪贴板;无选中时 preventDefault 避免 WKWebView undo-focus
    //   - Cmd+V:粘贴剪贴板文本到 PTY(xterm 默认已处理,这里做一层兜底)
    //
    // (C) 字体缩放(不产生 PTY 控制序列,由 adjustFontSize 处理):
    //   - Cmd+= / Cmd+Shift+= / Cmd++ → 放大
    //   - Cmd+- → 缩小
    //   - Cmd+0 → 重置
    //
    // press-and-hold accent popup 吞字符这事由 Rust 侧
    // disable_apple_press_and_hold() 关掉宿主进程偏好。
    function ptyKeyOverride(e: KeyboardEvent): string | null {
      const meta = e.metaKey
      const opt = e.altKey
      const ctrl = e.ctrlKey
      const shift = e.shiftKey
      const k = e.key

      // Cmd+← / Cmd+→ → 行首 / 行尾(readline:Ctrl-A / Ctrl-E)
      if (meta && !ctrl && !opt) {
        if (k === 'ArrowLeft') return '\x01'   // ^A
        if (k === 'ArrowRight') return '\x05'  // ^E
        if (k === 'Backspace') return '\x15'   // ^U  删到行首
        if (k === 'Delete') return '\x0b'      // ^K  删到行尾
      }

      // Option+← / Option+→ → 按词跳(ESC b / ESC f)
      if (opt && !meta && !ctrl) {
        if (k === 'ArrowLeft') return '\x1bb'
        if (k === 'ArrowRight') return '\x1bf'
        if (k === 'Backspace') return '\x17'   // ^W  删词
        if (k === 'Delete') return '\x1bd'     // ESC d  向后删词
      }

      // Esc:IME 没在组合时直接送 \x1b。组合态下浏览器自己会处理掉(我们也收不到)。
      // shift / cmd 修饰的 Esc 不拦。
      if (k === 'Escape' && !meta && !ctrl && !opt && !shift && !(e as any).isComposing) {
        return '\x1b'
      }

      return null
    }
    const onKeyCapture = (e: KeyboardEvent) => {
      // IME 组合中:绝不动,让 IME 自己处理候选选词、Enter 提交等
      if ((e as any).isComposing || (e as KeyboardEvent & { keyCode: number }).keyCode === 229) {
        return
      }

      // ── (S) 搜索栏打开且 input 聚焦时:只截搜索专用键,其余放行给 input ──
      // 绝不能落进下面的 PTY 路径(否则在搜索框敲字会变成给 CLI 发字符)。
      if (searchOpen && searchInputEl && e.target === searchInputEl) {
        const mc = e.metaKey || e.ctrlKey
        if (mc && !e.altKey && (e.key === 'f' || e.key === 'F')) {
          e.preventDefault(); e.stopPropagation()
          searchInputEl.focus()
          searchInputEl.select()
          return
        }
        if (mc && !e.altKey && (e.key === 'g' || e.key === 'G')) {
          e.preventDefault(); e.stopPropagation()
          if (e.shiftKey) { findPrevMatch() } else { findNextMatch() }
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation()
          if (e.shiftKey) { findPrevMatch() } else { findNextMatch() }
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation()
          closeSearch()
          return
        }
        // Ctrl+Enter → 在搜索框插入换行符(启用多行搜索,VSCode 风格)
        if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation()
          const s = searchInputEl.selectionStart ?? 0
          const ed = searchInputEl.selectionEnd ?? s
          searchQuery = searchQuery.slice(0, s) + '\n' + searchQuery.slice(ed)
          requestAnimationFrame(() => {
            onSearchInput()
            if (searchInputEl) {
              searchInputEl.selectionStart = searchInputEl.selectionEnd = s + 1
            }
          })
          return
        }
        // 标准 macOS 编辑快捷键(Cmd+A 全选 / Cmd+Backspace 删行首 / Cmd+C/V/...):
        // 只 stopPropagation —— 阻止 App.svelte 的兜底 preventDefault 杀掉默认行为;
        // 不 preventDefault —— 保留浏览器原生行为。
        if (mc) {
          e.stopPropagation()
          return
        }
        // 其余按键(含普通输入)交给 input 原生处理 → 触发 oninput → onSearchInput
        return
      }

      // ── (B) 剪贴板操作 ──────────────────────────────────────────────
      // Cmd+C:有选区 → 复制;无选区 → 仍 preventDefault(避免 WKWebView undo-focus)
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'c') {
        e.preventDefault()
        e.stopPropagation()
        const sel = term.getSelection()
        if (sel) {
          navigator.clipboard.writeText(sel).catch((err) => {
            console.warn('[term] clipboard write failed:', err)
          })
        }
        return
      }
      // Cmd+V:粘贴剪贴板文本到 PTY。通过 Rust 侧读剪贴板,绕过 WKWebView 的
      // 系统权限弹窗(navigator.clipboard.readText 在 WKWebView 里每次都触发弹窗)。
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'v') {
        e.preventDefault()
        e.stopPropagation()
        ipc.readClipboard().then((text) => {
          if (!text) return
          const bytes = new TextEncoder().encode(text)
          ipc.writeInput(sessionId, bytes, endpointId).catch(console.error)
        }).catch((err) => {
          console.warn('[term] clipboard read failed:', err)
        })
        return
      }

      // ── (F) 搜索 ─────────────────────────────────────────────────────
      // Cmd/Ctrl+F → 打开/聚焦搜索栏(预填当前选区)。在 capture 阶段拦截,
      // 早于 App.svelte 的 window onkeydown 兜底 preventDefault,也压制
      // WebKit 内建 find-bar。
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        e.stopPropagation()
        openSearch()
        return
      }
      // Cmd/Ctrl+G → 下一个;Shift → 上一个(仅搜索栏已打开时)
      if (searchOpen && (e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault()
        e.stopPropagation()
        if (e.shiftKey) { findPrevMatch() } else { findNextMatch() }
        return
      }
      // 搜索栏打开 + 焦点在终端时,Esc 关搜索栏(不送给 PTY)。
      // 焦点在 input 时由上面的 input-guard 处理。
      if (searchOpen && e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        closeSearch()
        return
      }

      // ── (C) 字体缩放 ─────────────────────────────────────────────────
      // Cmd+= / Cmd+Shift+= / Cmd++ → 放大;Cmd+- → 缩小;Cmd+0 → 重置
      if (e.metaKey && !e.ctrlKey && !e.altKey) {
        const k = e.key
        if (k === '=' || k === '+') {
          e.preventDefault()
          e.stopPropagation()
          adjustFontSize(1)
          return
        }
        if (k === '-') {
          e.preventDefault()
          e.stopPropagation()
          adjustFontSize(-1)
          return
        }
        if (k === '0') {
          e.preventDefault()
          e.stopPropagation()
          adjustFontSize(0)
          return
        }
      }

      // ── (A) PTY 控制序列翻译 ──────────────────────────────────────────
      const seq = ptyKeyOverride(e)
      if (seq == null) return
      e.preventDefault()
      e.stopPropagation()
      const bytes = new TextEncoder().encode(seq)
      ipc.writeInput(sessionId, bytes, endpointId).catch(console.error)
    }
    // capture phase = 在 xterm 自己的 keydown 之前跑;阻断后 xterm 也不再处理
    containerEl.addEventListener('keydown', onKeyCapture, { capture: true })

    // 5) 原子订阅 PTY 字节流,并先回放 spawn 至今积累的原始字节。
    //
    //    为什么不用 vt100 snapshot:如果切点恰好位于半条 ANSI/OSC 序列中,
    //    snapshot 无法携带 parser 的中间状态,会偶发丢颜色/样式。原始字节则能
    //    完整重放 startup scrollback 和所有终端控制序列。
    //
    //    channel 在 invoke 返回后就可能收到实时消息;ipc 层会先排队。必须等
    //    initialBytes 写完再 start,确保 xterm 看到的字节顺序与 PTY 完全一致。
    const byteSubscription = await ipc.subscribeSessionBytes(sessionId, (bytes) => {
      if (destroyed || !term) return
      const themedBytes = ansiThemeAdapter.transform(bytes)
      if (themedBytes.length > 0) term.write(themedBytes)
      if (visible) queueViewportRepair(false)
    })
    if (destroyed || !term) {
      await byteSubscription.unsubscribe().catch((e) => console.warn('[term] unsubscribe bytes failed', e))
      return
    }
    bytesUnsubscribe = byteSubscription.unsubscribe
    try {
      if (byteSubscription.initialBytes.length > 0) {
        const themedInitialBytes = ansiThemeAdapter.transform(byteSubscription.initialBytes)
        await new Promise<void>((resolve) => {
          if (themedInitialBytes.length === 0) {
            resolve()
            return
          }
          term.write(themedInitialBytes, () => {
            try { term.scrollToBottom() } catch {}
            resolve()
          })
        })
        // 初始字节写完后强制 repairViewport:大量 startup 输出会改变 buffer 长度,
        // 触发 syncScrollArea,但若容器尺寸
        // 在 initTerminal 时未完全稳定,_lastRecordedViewportHeight 可能仍是旧值。
        // 此处主动重置让下次 syncScrollArea 短路必然失败。
        queueViewportRepair(true)
      }
    } catch (e) {
      console.warn('[term] initial PTY replay failed', e)
    } finally {
      byteSubscription.start()
    }

    // 6) 把当前 cols/rows 同步给 PTY —— 但只有 fit 出健康尺寸时才发,
    //    否则交给后续 ResizeObserver 触发(scheduleResize 内部也有最小尺寸守卫)。
    if (term.cols >= MIN_COLS && term.rows >= MIN_ROWS) {
      await ipc.resizeSession(sessionId, term.cols, term.rows, endpointId)
    } else {
      // 兜底:再调度一次 resize,等容器真有尺寸了再同步给 PTY。
      scheduleResize(true)
    }

    // 7) ResizeObserver + debounce 50ms
    resizeObserver = new ResizeObserver(() => scheduleResize())
    resizeObserver.observe(containerEl)

    // 8) HiDPI 切显示器:监听 devicePixelRatio 变化
    setupDprWatcher()

    // 9) Cmd+Click 路径 / URL 识别 —— registerLinkProvider
    //
    // ── 坐标约定(xterm 5.x 源码确认) ──────────────────────────────────
    // • provideLinks(bufferedRowIndex, cb): bufferedRowIndex 是 1-based buffer
    //   absolute row(已加 ydisp)。getLine(bufferedRowIndex - 1) 才拿到对应行。
    // • range.start/end.x : 1-based col;range.start/end.y : 1-based buffer row
    //   → 直接用 bufferedRowIndex,不要 ±1。
    // • translateToString(trimRight, startCol, endCol):公开 API 只有 3 个
    //   参数,**没有 outCharMap**。早期版本的代码传了第 4 个 charMap 数组
    //   是无效的(永远空),导致中文 / CJK 行里字符索引被当成 cell col
    //   使用,链接下划线整体偏移 N(N = 行内全宽字符数)。修复方案:用
    //   getCell(x).getWidth() 自己遍历 cell 构建 charIdx ↔ cellCol 映射。
    // • activate(event, text): event 是真实 MouseEvent,可以读 metaKey。
    //   直接在这里判断 Cmd 再 openPath,不需要额外 click capture handler。
    //
    // 识别范围:
    //   a) http:// / https:// / file:// URL
    //   b) 绝对路径 /… 或 ~/… (含可选 :row:col 后缀)
    //   c) 相对路径 word/word… (含可选 :row:col 后缀)
    //      — 前一字符不能是 / 或 \w,避免把绝对路径里的中间片段单独匹配
    //      — 路径主体字符类排除 : ,行列号通过独立的 :\d+ 后缀捕获,
    //        防止 "foo/bar: something" 把 ": something" 贪吃进来
    // 高亮范围包含行列号后缀,activate 时通过 cleanPath 去掉
    const LINK_PATTERN = /(?:https?:\/\/|file:\/\/)[^\s"'<>()[\]{}，。、；：（）【】「」『』]+|(?:~\/|\/)[^\s"'<>()[\]{}:*?，。、；：（）【】「」『』]+(?::\d+(?::\d+)?)?|(?<![/\w])[A-Za-z0-9_.][A-Za-z0-9_./-]*\/[^\s"'<>()[\]{}:*?，。、；：（）【】「」『』]+(?::\d+(?::\d+)?)?/g

    /** 把 match 文本清理成可传给 open 的路径 */
    function cleanPath(raw: string): string {
      return raw
        .replace(/[.,;:!?，。、；：（）【】「」『』）】」』\]）>]+$/, '') // 去末尾标点
        .replace(/:\d+(?::\d+)?$/, '')          // 去行列号后缀
    }

    term.registerLinkProvider({
      provideLinks(
        bufferedRowIndex: number,   // 1-based, buffer-absolute row
        callback: (links: any[] | undefined) => void,
      ) {
        const buf = term.buffer.active
        // getLine 接受 0-based index → bufferedRowIndex - 1
        const line = buf.getLine(bufferedRowIndex - 1)
        if (!line) { callback(undefined); return }

        // 自己构建 charIdx → 0-based cellCol 的映射。
        // 遍历 cells:width=2(全宽 CJK)算 1 个字符占 2 cells;
        //          width=0(紧跟全宽字符的占位 cell)跳过,不产生字符;
        //          width=1 普通字符。
        // 同时拼出 text 字符串(用 cell.getChars(),空 cell 当空格)。
        const charToCol: number[] = []
        let textBuf = ''
        const tmpCell = buf.getNullCell()
        for (let col = 0; col < line.length; col++) {
          const cell = line.getCell(col, tmpCell)
          if (!cell) continue
          const w = cell.getWidth()
          if (w === 0) continue   // 全宽字符的右半,无字符
          const chars = cell.getChars() || ' '
          charToCol.push(col)
          textBuf += chars
        }
        const text = textBuf
        if (!text.trim()) { callback(undefined); return }

        const links: any[] = []
        LINK_PATTERN.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = LINK_PATTERN.exec(text)) !== null) {
          const rawMatch = m[0]
          const charStart = m.index
          const charEnd   = charStart + rawMatch.length - 1

          // 字符索引 → cell col(1-based,xterm range 是 1-based)
          const cellStart = (charToCol[charStart] ?? charStart) + 1
          const cellEnd   = (charToCol[charEnd]   ?? charEnd)   + 1

          const raw = rawMatch.replace(/[.,;:!?，。、；：（）【】「」『』）】」』\]）>]+$/, '')

          links.push({
            range: {
              start: { x: cellStart,     y: bufferedRowIndex },
              end:   { x: cellEnd + 1,   y: bufferedRowIndex },
            },
            text: raw,
            decorations: {
              underline: true,
              pointerCursor: true,
            },
            activate(event: MouseEvent, _text: string) {
              // xterm 在鼠标抬起时调 activate(mouseEvent, linkText)
              // 只有 Cmd 按住时才真正打开
              if (!event?.metaKey) return
              let path = cleanPath(raw)
              // 相对路径:拼接 session cwd 变绝对路径
              if (!path.startsWith('/') && !path.startsWith('~') && !path.match(/^https?:\/\//)) {
                const tab = get(tabs).find(t => t.id === sessionId)
                if (tab?.cwd) {
                  path = tab.cwd.replace(/\/$/, '') + '/' + path
                }
              }
              console.debug('[term] cmd+click open:', path)
              ipc.openPath(path).catch((err) => {
                console.warn('[term] open_path failed:', err)
              })
            },
          })
        }
        callback(links.length ? links : undefined)
      },
    })

    // 11) click capture handler — Cmd 按住时落在 LINK_PATTERN 上,preventDefault 阻止文本选中。
    //   xterm activate 回调里已处理打开逻辑,这里只做防选区。
    const onClickCapture = (e: MouseEvent) => {
      if (!e.metaKey || !term) return

      const termCols = term.cols
      const termRows = term.rows
      if (!termCols || !termRows) return

      const rect = containerEl.getBoundingClientRect()
      const termW = containerEl.offsetWidth
      const termH = containerEl.offsetHeight
      if (!termW || !termH) return

      const relX = e.clientX - rect.left
      const relY = e.clientY - rect.top
      if (relX < 0 || relY < 0 || relX > termW || relY > termH) return

      const cellW = termW / termCols
      const cellH = termH / termRows
      const col = Math.floor(relX / cellW)
      const row = Math.floor(relY / cellH)

      const buf = term.buffer.active
      // bufRow: 0-based absolute
      const bufRow = buf.viewportY + row
      const line = buf.getLine(bufRow)
      if (!line) return

      // 同 provideLinks:用 getCell + getWidth 自己构建 charIdx → cellCol 映射
      const charToCol: number[] = []
      let textBuf = ''
      const tmpCell = buf.getNullCell()
      for (let c = 0; c < line.length; c++) {
        const cell = line.getCell(c, tmpCell)
        if (!cell) continue
        const w = cell.getWidth()
        if (w === 0) continue
        charToCol.push(c)
        textBuf += cell.getChars() || ' '
      }
      const text = textBuf

      // 把 col(0-based) 反查到字符索引:找 charToCol 中第一个 >= col 的位置
      let charIdx = charToCol.findIndex(c => c >= col)
      if (charIdx < 0) charIdx = text.length - 1

      LINK_PATTERN.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = LINK_PATTERN.exec(text)) !== null) {
        if (charIdx >= m.index && charIdx < m.index + m[0].length) {
          e.preventDefault()
          e.stopPropagation()
          return
        }
      }
    }
    containerEl.addEventListener('click', onClickCapture, { capture: true })

    // WKWebView + xterm：wheel 命中 link-layer / canvas 时，xterm 注册在 screen
    // 元素上的 native wheel listener 在某些层叠场景下收不到事件,所以我们在
    // 容器 capture 阶段兜一个 handler。
    //
    // 关键修正（切 tab 后滚不动的根因）:
    //   之前这里调 term.scrollLines(lines) —— 公开 API 改的是 buffer.ydisp，
    //   再由 Viewport._innerRefresh 用 `ydisp * _currentRowHeight` 反算 DOM
    //   scrollTop 写回。但切 tab(visibility:hidden 期间)后 _currentRowHeight /
    //   renderDimensions 可能被冻结成旧值,而我们的 forceScrollAreaDom 又直接
    //   写过 viewportEl.scrollTop + vp._lastScrollTop，造成 ydisp 与 DOM scrollTop
    //   两套真值彼此错位:
    //     - scrollLines 先动 ydisp → onScroll → syncScrollArea 命中 short-circuit
    //       (_lastScrollTop 已被我们手填成等于 ydisp*rowHeight)→ 不 refresh
    //     - 即使 refresh，用的也是错的 _currentRowHeight → scrollTop 算回原值
    //   结果 vpScrollTop 纹丝不动。
    //
    //   正解:**完全照搬 xterm native handleWheel 的做法 —— 直接改
    //   viewportEl.scrollTop**。DOM scroll 事件会触发 xterm 内部 _handleScroll，
    //   它读 `round(scrollTop / _currentRowHeight) - ydisp` 反推出 amount 再
    //   把 ydisp 对齐到 DOM(suppressScrollEvent:true,不会再回写 scrollTop)。
    //   这样 DOM scrollTop 成为唯一驱动源,绕开 _currentRowHeight 冻结 + sync
    //   short-circuit 两个坑;clamp 也由浏览器原生 scrollTop 边界保证。
    _onWheelFallback = (e: WheelEvent) => {
      if (destroyed || !term || !containerEl) return
      if (e.deltaY === 0 || e.shiftKey) return

      const xtermEl = containerEl.querySelector('.xterm') as HTMLElement | null
      const mouseEventsActive =
        xtermEl?.classList.contains('enable-mouse-events') ||
        !!(term as any)?._core?.coreMouseService?.areMouseEventsActive
      if (mouseEventsActive) return

      const viewportEl = containerEl.querySelector('.xterm-viewport') as HTMLDivElement | null
      if (!viewportEl) return

      // rowHeight 仅用于 line/page 模式的 delta 换算,优先用真实渲染维度,
      // 退化到 viewport 实测高度 / 行数,最后兜 16px。
      const dims = getRenderDimensions()
      const dpr = window.devicePixelRatio || 1
      const rowHeight =
        dims?.device?.cell?.height && dims.device.cell.height > 0
          ? dims.device.cell.height / dpr
          : term.rows > 0
            ? viewportEl.clientHeight / term.rows
            : 16
      const pixelDelta =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? e.deltaY * rowHeight
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? e.deltaY * viewportEl.clientHeight
            : e.deltaY
      const sensitivity = Number((term.options as any).scrollSensitivity ?? 1)
      const delta = pixelDelta * sensitivity
      if (delta === 0) return

      const maxScrollTop = Math.max(0, viewportEl.scrollHeight - viewportEl.clientHeight)
      const before = viewportEl.scrollTop
      const next = Math.max(0, Math.min(maxScrollTop, before + delta))

      // 只有真正能滚动时才吞事件;到顶/到底则放行让宿主页面/父级处理。
      if (next === before) return
      if (e.cancelable) e.preventDefault()
      viewportEl.scrollTop = next
      // DOM scroll 事件是异步派发的,但 xterm 的 _handleScroll 会在同一帧后
      // 同步 ydisp。无需手动调 scrollLines —— 那正是之前 desync 的来源。
    }
    containerEl.addEventListener('wheel', _onWheelFallback, { capture: true, passive: false })

    // 12) Cmd 按住时改变鼠标样式,给用户"可点击"的视觉反馈
    //
    // 原理:监听 keydown/keyup 切换 CSS class;CSS 里对 .cmd-held 下的 xterm 容器
    // 设置 cursor: pointer。注意只有真正 hover 到 link 上才会让 xterm 内部再改 cursor,
    // 但给整个终端加 pointer 已经是业界通行做法(VSCode 就这样)。
    _onCmdDown = (e: KeyboardEvent) => {
      if (e.key === 'Meta') {
        cmdHeld = true
        containerEl.classList.add('cmd-held')
      }
    }
    _onCmdUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta') {
        cmdHeld = false
        containerEl.classList.remove('cmd-held')
      }
    }
    // 用 window 监听防止 keyup 丢失(如 Cmd+Tab 切走时 keyup 不到 containerEl)
    window.addEventListener('keydown', _onCmdDown)
    window.addEventListener('keyup', _onCmdUp)
  } // end initTerminal

  /**
   * 滚动条修复的整体策略(2026-06 重写为纯原生)。
   *
   * 问题本质:
   *   - .term-host 在非 active tab 上 display:none → .xterm-viewport.offsetHeight = 0。
   *     scrollbar 是由 .xterm-scroll-area 的 height 撑出的;隐藏期间到达的字节会让
   *     xterm 把 scroll-area 高度算成错的小值。
   *   - 切回 visible 后即使 fit,若 cols/rows 不变,xterm 内部会短路 resize,
   *     syncScrollArea() 也命中「viewportHeight/scrollTop/cellHeight 都没变」的
   *     短路 → 不重算 scroll-area → 用户看到内容齐全但滚不动 / 没滚动条。
   *
   * 历史教训(别再走回头路):
   *   早期版本手写 .xterm-scroll-area.style.height、viewport.scrollTop,以及回填
   *   xterm 私有字段(_lastRecorded*、_currentRowHeight、_lastScrollTop)。这套
   *   manual patch 会和 xterm 自己的 _renderDimensions / dirty-check 抢真值:一旦
   *   我们填的值与 xterm 下一次从真实几何算出的值「碰巧相等」(切到短内容 tab 再
   *   切回时极易发生),xterm 认为无需变化 → 跳过 _innerRefresh → scroll-area 高度
   *   永远停在被污染的旧值 → 反复丢滚动条。
   *
   * 现行做法(repairViewport / forceNativeResync):
   *   完全不写 DOM 几何与私有字段,只用 xterm syncScrollArea() 的逃生通道 ——
   *   把 _lastRecordedBufferLength 设成 -1 → syncScrollArea 第一条判断必然命中
   *   → 无条件 _refresh(true) → _innerRefresh 用 xterm 自己维护的真值
   *   (_renderDimensions,由内部 onDimensionsChange 监听保持最新)重写 scroll-area
   *   高度。ResizeObserver + scheduleResize 里的 safeFit 负责真正的尺寸变化重测。
   */

  function queueViewportRepair(stickToBottom = false) {
    if (stickToBottom) pendingViewportStick = true
    if (viewportRepairRaf != null) return
    viewportRepairRaf = requestAnimationFrame(() => {
      viewportRepairRaf = null
      const shouldStick = pendingViewportStick
      pendingViewportStick = false
      repairViewport(shouldStick)
    })
  }

  function repairViewport(stickToBottom = false) {
    if (!term || !containerEl) return
    // 纯原生重同步:不再手写 .xterm-scroll-area.style.height / viewport.scrollTop /
    // _lastRecorded* 等私有字段(那套手动 patch 会和 xterm 内部模型抢真值,反复造成
    // desync —— 切到无滚动条 tab 再切回有滚动条 tab 时丢滚动条就是它造成的)。
    //
    // 改用 xterm syncScrollArea() 自己的「逃生通道」:
    //   syncScrollArea() 第一条判断是 `_lastRecordedBufferLength !== buffer.lines.length`,
    //   命中就**无条件** _refresh(true) → _innerRefresh()。而 _innerRefresh 读的是
    //   xterm 自己维护的 _renderDimensions(由内部 onDimensionsChange 监听保持最新),
    //   用真实 viewport.offsetHeight + canvas.height 重算并重写 scroll-area 高度。
    //   只要把 _lastRecordedBufferLength 设成不可能值(-1),就强制走这条通道,
    //   绕开「viewportHeight/scrollTop/cellHeight 都没变」的短路,且全程让 xterm
    //   用自己的真值,我们不掺和。
    forceNativeResync()
    if (stickToBottom) {
      try {
        const buf = term.buffer?.active
        const atBottom = !buf || buf.viewportY >= buf.length - term.rows
        if (atBottom) term.scrollToBottom()
      } catch {}
    }
  }

  /**
   * 强制 xterm 重新同步 scroll-area 高度,全程使用 xterm 自己的真值。
   * 不写任何 DOM 几何 / scrollTop,只把 _lastRecordedBufferLength 设成 -1 触发
   * syncScrollArea 的无条件 _refresh 通道(见 repairViewport 注释)。
   */
  function forceNativeResync(): boolean {
    if (!term || !containerEl) return false
    // 容器还在 display:none(offsetHeight 0)时重测毫无意义且会写出 0 高度,跳过。
    if (containerEl.offsetWidth === 0 || containerEl.offsetHeight === 0) return false
    try {
      const vp = (term as any)._core?.viewport
      if (vp && '_lastRecordedBufferLength' in vp && typeof vp.syncScrollArea === 'function') {
        vp._lastRecordedBufferLength = -1
        vp.syncScrollArea(true) // immediate=true → 同步 _innerRefresh,不排 rAF
        return true
      }
    } catch (e) {
      console.warn('[term] native resync failed', e)
    }
    // Fallback:老版本字段名不同时,bump scrollback 触发官方 onSpecificOptionChange → syncScrollArea。
    try {
      const cur = (term.options as any).scrollback ?? 5000
      term.options.scrollback = cur + 1
      term.options.scrollback = cur
      return true
    } catch {}
    return false
  }

  function getRenderDimensions() {
    const renderer = (term as any)?._core?._renderService?._renderer?.value
    return renderer?.dimensions
  }

  function hasHealthyRenderDimensions(): boolean {
    const dims = getRenderDimensions()
    return !!(
      dims?.css?.cell?.width > 0 &&
      dims?.css?.cell?.height > 0 &&
      dims?.css?.canvas?.height > 0 &&
      dims?.device?.cell?.height > 0
    )
  }

  function safeFit(): boolean {
    if (!term || !fitAddon || !hasHealthyRenderDimensions()) return false
    try {
      fitAddon.fit()
      return true
    } catch (e) {
      console.warn('[term] fit skipped: renderer not ready', e)
      return false
    }
  }

  /**
   * stickToBottom: 这次 resize 完成后是否把 viewport 强制推到最底部。
   * 用于 tab 切换 / 首次 mount 这种"用户期待看到最新输出"的场景。
   * ResizeObserver 触发的常规 resize 不传 — 用户可能正在 scrollback 翻看历史,
   * 不能粗暴抢走他的滚动位置。
   */
  let pendingStick = false
  function scheduleResize(stickToBottom = false) {
    if (destroyed) return
    if (stickToBottom) pendingStick = true
    if (resizeTimer != null) clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => {
      resizeTimer = null
      if (destroyed) return
      const shouldStick = pendingStick
      pendingStick = false
      // 关键:容器处于 display:none(非 active tab)时 offsetWidth/Height === 0。
      // 此时 fitAddon.fit() 会把 cols/rows 算成极小值,接着 ipc.resizeSession 会把
      // PTY 真实尺寸缩成 1×N → 后端 vt100 按 1 列 reflow → 切回来时只剩很窄一列,
      // 而且 vt100 已 wrap 的行**不会** reflow,导致永久"4-5 字一行"。
      // 两道防线:
      //   ① 容器 0 尺寸 → 直接 return
      //   ② fit 完了仍低于 MIN_COLS/MIN_ROWS → 也 return,不要污染后端
      if (
        !containerEl ||
        containerEl.offsetWidth === 0 ||
        containerEl.offsetHeight === 0
      ) {
        // 容器还没准备好;如果是请求 stick 的调用,记下来下次再补
        if (shouldStick) pendingStick = true
        return
      }
      try {
        if (!safeFit()) {
          if (shouldStick) pendingStick = true
          window.setTimeout(() => scheduleResize(shouldStick), 80)
          return
        }
        if (!term) return
        if (term.cols < MIN_COLS || term.rows < MIN_ROWS) {
          // fit 失败的兜底信号:再调度一次,等真实尺寸稳定后再同步
          if (shouldStick) pendingStick = true
          if (containerEl.offsetWidth > 0 && containerEl.offsetHeight > 0) {
            // 容器其实有尺寸但 fit 算错了 —— 再来一次
            window.setTimeout(() => scheduleResize(shouldStick), 80)
          }
          return
        }
        ipc.resizeSession(sessionId, term.cols, term.rows, endpointId).catch(console.error)
        // fit 会重算 viewport,可能把滚动条留在任意位置;tab 切回 / 首次 mount
        // 必须在 fit **之后** scrollToBottom,否则被 fit 重置。
        // 双 rAF:第一帧让 xterm 内部 buffer 刷新,第二帧 DOM 已稳定再滚。
        //
        // 关键:无论是否 stickToBottom 都要强制 syncScrollArea ——
        // 切回时如果 cols/rows 没变,xterm 短路 resize,scroll-area 高度
        // 还停留在 display:none 期间算错的值上,scrollbar 看不到。
        if (shouldStick && !cmdHeld) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              repairViewport(false)
              // 只有用户当前仍在底部(或从未手动滚动过)才执行 scrollToBottom。
              // 若用户在 tab 切换后向上翻阅了 scrollback,不再抢夺其滚动位置。
              try {
                const buf = term?.buffer?.active
                const atBottom = !buf || buf.viewportY >= buf.length - (term?.rows ?? 0)
                if (atBottom) term?.scrollToBottom()
              } catch {}
            })
          })
        } else {
          requestAnimationFrame(() => repairViewport(false))
        }
      } catch (e) {
        console.warn('[term] fit/resize failed', e)
      }
    }, 50)
  }

  function setupDprWatcher() {
    const onChange = () => {
      term?.refresh(0, term.rows - 1)
      // 重新订阅下一次变化(matchMedia 单次触发)
      setupDprWatcher()
    }
    dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    dprMql.addEventListener('change', onChange, { once: true })
  }

  /**
   * 调整字体大小。
   * - delta > 0  → 放大
   * - delta < 0  → 缩小
   * - delta === 0 → 重置到默认值
   *
   * 调完立刻 fit → resize PTY,让终端行列数随新字号重算。
   */
  function adjustFontSize(delta: number) {
    if (!term) return
    const next = delta === 0
      ? TERMINAL_FONT_SIZE_DEFAULT
      : Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, fontSize + delta))
    if (next === fontSize && delta !== 0) return
    appearance = updateTerminalFontSize('pty', next)
    fontSize = appearance.fontSize
    term.options.fontSize = fontSize
    // setTimeout(0) 让 xterm 先消化 fontSize 变更再 fit,避免用旧字号算列数
    window.setTimeout(() => scheduleResize(), 0)
  }

  onMount(() => {
    terminalSettingsUnsubscribe = onTerminalSettingsChanged(({ target, settings }) => {
      if (target !== 'pty') return
      appearance = settings
      fontSize = settings.fontSize
      fontFamily = settings.fontFamily
      applyAppearance(settings)
    })
    initTerminal().catch((e) => {
      console.error('[term] init failed', e)
    })
  })

  function applyAppearance(next = appearance) {
    if (!term) return
    try {
      term.options.fontFamily = next.fontFamily
      term.options.fontSize = next.fontSize
      term.options.theme = buildXtermTheme(isDark, next.themeMode)
      try { term.clearTextureAtlas?.() } catch {}
      term.refresh(0, term.rows - 1)
      window.setTimeout(() => scheduleResize(), 0)
    } catch (e) {
      console.warn('[term] appearance update failed', e)
    }
  }

  // isDark 或 terminal appearance 变化时热更新 xterm。
  $effect(() => {
    void isDark
    void appearance
    applyAppearance()
  })

  // ============ 搜索(Ctrl/Cmd+F)============
  // 调用栈:openSearch → onSearchInput → findNext(同步跳到命中)+ 防抖 runCount
  // runCount 用 rAF 分块扫 buffer 行,每帧 SEARCH_COUNT_CHUNK_LINES 行,gen 不符即退出。

  function openSearch() {
    if (!searchAddon) return
    if (!searchOpen) {
      // 首次打开:预填当前选区(单行、合理长度才预填)
      const sel = term?.getSelection?.() ?? ''
      if (sel && sel.length > 0 && sel.length < 200 && sel.indexOf('\n') < 0) {
        searchQuery = sel.trim()
      }
    }
    searchOpen = true
    // 已 mount → 直接聚焦(否则 $effect 不会重跑:searchOpen 已是 true,是 no-op)
    // 未 mount → $effect 会在 searchInputEl 就绪后聚焦
    if (searchInputEl) {
      searchInputEl.focus()
      searchInputEl.select()
    }
  }

  // 搜索栏 mount 后聚焦 + 全选;用 $effect 跟随 searchOpen/searchInputEl
  $effect(() => {
    if (searchOpen && searchInputEl) {
      searchInputEl.focus()
      searchInputEl.select()
    }
  })

  function closeSearch() {
    searchOpen = false
    searchGen++
    if (searchDebounceTimer != null) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null }
    if (countRafId != null) { cancelAnimationFrame(countRafId); countRafId = null }
    if (mlSearchRafId != null) { cancelAnimationFrame(mlSearchRafId); mlSearchRafId = null }
    matchPositions = []
    mlMatchPositions = []
    searchSearching = false
    searchOverCap = false
    searchInvalidRegex = false
    try { searchAddon?.clearDecorations() } catch {}
    try { term?.focus?.() } catch {}
  }

  // input 的 oninput handler(binded value 已更新)
  function onSearchInput() {
    // 重置代际 + 取消挂起的计数
    searchGen++
    if (countRafId != null) { cancelAnimationFrame(countRafId); countRafId = null }
    if (mlSearchRafId != null) { cancelAnimationFrame(mlSearchRafId); mlSearchRafId = null }
    if (searchDebounceTimer != null) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null }
    matchPositions = []
    mlMatchPositions = []
    searchOverCap = false
    searchInvalidRegex = false
    searchMatchTotal = 0
    searchMatchIdx = 0
    searchSearching = false
    if (!searchQuery) {
      try { searchAddon?.clearDecorations() } catch {}
      return
    }
    // 多行搜索:query 含 \n → 自定义跨行扫描
    if (searchQuery.includes('\n')) {
      searchSearching = true
      mlSearchChunked()
      return
    }
    if (!searchAddon) return
    // 单行:立即同步跳到下一个命中(<10ms,即时反馈)
    const opts = { caseSensitive: searchCaseSensitive, regex: searchRegex }
    let found = false
    try {
      found = searchAddon.findNext(searchQuery, opts)
      if (!found) {
        try { searchAddon.clearDecorations() } catch {}
        return
      }
    } catch {
      // 正则构造失败 / 非法 → 标记,不阻塞
      searchInvalidRegex = true
      try { searchAddon.clearDecorations() } catch {}
      return
    }
    // 命中成功:立即显示 "searching…",当前命中乐观标为第 1 个
    searchSearching = true
    searchMatchIdx = 1
    // 防抖后做全量计数(长内容下唯一可能慢的环节)
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null
      runCount()
    }, SEARCH_DEBOUNCE_MS)
  }

  function runCount() {
    if (!searchQuery || !term) return
    const gen = ++searchGen
    searchSearching = true
    const q = searchQuery
    const cs = searchCaseSensitive
    const rx = searchRegex
    let regex: RegExp | null = null
    if (rx) {
      try {
        regex = new RegExp(q, cs ? 'g' : 'gi')
      } catch {
        searchInvalidRegex = true
        searchSearching = false
        return
      }
    }
    searchInvalidRegex = false
    const buffer = term.buffer.active
    const total = buffer.length
    const needle = cs ? q : q.toLowerCase()
    let i = 0
    let count = 0
    const positions: { row: number; col: number }[] = []
    let overCap = false

    const chunk = () => {
      if (gen !== searchGen) return  // 已被新输入作废
      const end = Math.min(i + SEARCH_COUNT_CHUNK_LINES, total)
      for (; i < end; i++) {
        const line = buffer.getLine(i)
        if (!line) continue
        const text = line.translateToString(true)
        const hay = cs ? text : text.toLowerCase()
        if (regex) {
          regex.lastIndex = 0
          let m: RegExpExecArray | null
          while ((m = regex.exec(hay)) !== null) {
            if (m[0].length === 0) { regex.lastIndex++; continue }  // 防零宽死循环
            count++
            if (!overCap && positions.length < SEARCH_POSITION_CAP) {
              positions.push({ row: i, col: m.index })
            } else if (!overCap) {
              overCap = true
            }
          }
        } else {
          let from = 0
          let idx: number
          while ((idx = hay.indexOf(needle, from)) !== -1) {
            count++
            if (!overCap && positions.length < SEARCH_POSITION_CAP) {
              positions.push({ row: i, col: idx })
            } else if (!overCap) {
              overCap = true
            }
            from = idx + needle.length
            if (needle.length === 0) break  // 理论上前面已挡,防御
          }
        }
      }
      if (i < total) {
        searchMatchTotal = count  // 部分进度
        countRafId = requestAnimationFrame(chunk)
      } else {
        if (gen !== searchGen) return
        matchPositions = positions
        searchOverCap = overCap
        searchMatchTotal = count
        searchSearching = false
        updateCurrentIdx()
      }
    }
    countRafId = requestAnimationFrame(chunk)
  }

  // 根据 xterm 当前选区/光标位置,在 matchPositions 里定位当前命中索引
  function updateCurrentIdx() {
    if (matchPositions.length === 0) {
      searchMatchIdx = searchMatchTotal > 0 ? 1 : 0
      return
    }
    let row = -1
    let col = -1
    try {
      const pos = term?.getSelectionPosition?.()
      if (pos) { row = pos.start.y; col = pos.start.x }
    } catch {}
    if (row < 0) {
      try {
        const b = term?.buffer?.active
        if (b) { row = b.baseY + b.cursorY; col = b.cursorX }
      } catch {}
    }
    if (row < 0) { searchMatchIdx = 1; return }
    // 找最后一个 row/col <= 当前位置的命中;全在它之后 → 回绕到第一个
    let idx = 0
    for (let k = 0; k < matchPositions.length; k++) {
      const p = matchPositions[k]
      if (p.row > row || (p.row === row && p.col > col)) break
      idx = k + 1
    }
    if (idx === 0) idx = 1
    searchMatchIdx = idx
  }

  function findNextMatch() {
    if (!searchQuery || !term) return
    if (searchQuery.includes('\n')) {
      if (mlMatchPositions.length === 0) return
      const nextIdx = searchMatchIdx % mlMatchPositions.length
      mlSelectMatch(nextIdx)
      return
    }
    if (!searchAddon) return
    try {
      searchAddon.findNext(searchQuery, { caseSensitive: searchCaseSensitive, regex: searchRegex })
      updateCurrentIdx()
    } catch {}
  }

  function findPrevMatch() {
    if (!searchQuery || !term) return
    if (searchQuery.includes('\n')) {
      if (mlMatchPositions.length === 0) return
      const prevIdx = (searchMatchIdx + mlMatchPositions.length - 2) % mlMatchPositions.length
      mlSelectMatch(prevIdx)
      return
    }
    if (!searchAddon) return
    try {
      searchAddon.findPrevious(searchQuery, { caseSensitive: searchCaseSensitive, regex: searchRegex })
      updateCurrentIdx()
    } catch {}
  }

  // ── 多行搜索(Ctrl+Enter 插入 \n,绕过 addon-search)──────
  function mlSearchChunked() {
    if (!searchQuery || !term) return
    const gen = ++searchGen
    const subQueries = searchQuery.split('\n')
    if (subQueries.length < 2 || subQueries.every(q => !q)) {
      searchSearching = false
      return
    }
    const buffer = term.buffer.active
    const total = buffer.length
    let i = 0
    const positions: { row: number; col: number }[] = []

    const chunk = () => {
      if (gen !== searchGen) return
      const end = Math.min(i + SEARCH_COUNT_CHUNK_LINES, total - subQueries.length + 1)
      for (; i < end; i++) {
        const firstLine = buffer.getLine(i)
        if (!firstLine) continue
        const text = firstLine.translateToString(true)
        const hay = searchCaseSensitive ? text : text.toLowerCase()
        const n0 = searchCaseSensitive ? subQueries[0] : subQueries[0].toLowerCase()
        let from = 0
        while (true) {
          const idx = hay.indexOf(n0, from)
          if (idx === -1) break
          let allMatch = true
          for (let j = 1; j < subQueries.length; j++) {
            const ln = buffer.getLine(i + j)
            if (!ln) { allMatch = false; break }
            const t = ln.translateToString(true)
            const h = searchCaseSensitive ? t : t.toLowerCase()
            const n = searchCaseSensitive ? subQueries[j] : subQueries[j].toLowerCase()
            if (!h.includes(n)) { allMatch = false; break }
          }
          if (allMatch) positions.push({ row: i, col: idx })
          from = idx + n0.length
          if (n0.length === 0) break
        }
      }
      if (i < total - subQueries.length + 1) {
        mlSearchRafId = requestAnimationFrame(chunk)
      } else {
        if (gen !== searchGen) return
        mlMatchPositions = positions
        searchMatchTotal = positions.length
        searchOverCap = positions.length > SEARCH_POSITION_CAP
        searchSearching = false
        if (positions.length > 0) {
          mlSelectMatch(0)
        } else {
          searchAddon?.clearDecorations()
        }
      }
    }
    mlSearchRafId = requestAnimationFrame(chunk)
  }

  function mlSelectMatch(idx: number) {
    if (!term || mlMatchPositions.length === 0) return
    const pos = mlMatchPositions[idx]
    const subQueries = searchQuery.split('\n')
    const buffer = term.buffer.active
    // 计算跨行选区总长度
    let totalLen = (term.cols - pos.col)  // 首行剩余
    for (let j = 1; j < subQueries.length - 1; j++) totalLen += term.cols  // 中间整行
    totalLen += subQueries[subQueries.length - 1].length  // 末行命中文本
    term.clearSelection()
    term.select(pos.col, pos.row, totalLen)
    // 滚动确保命中可见
    const vpTop = buffer.viewportY
    const vpBot = vpTop + term.rows - 1
    if (pos.row < vpTop || pos.row + subQueries.length - 1 > vpBot) {
      term.scrollToRow(pos.row)
    }
    searchMatchIdx = idx + 1
  }

  function toggleCase() {
    searchCaseSensitive = !searchCaseSensitive
    onSearchInput()
  }

  function toggleRegex() {
    searchRegex = !searchRegex
    onSearchInput()
  }

  onDestroy(() => {
    destroyed = true
    webglLoadGeneration++
    resizeObserver?.disconnect()
    if (resizeTimer != null) clearTimeout(resizeTimer)
    if (viewportRepairRaf != null) cancelAnimationFrame(viewportRepairRaf)
    if (searchDebounceTimer != null) clearTimeout(searchDebounceTimer)
    if (countRafId != null) cancelAnimationFrame(countRafId)
    if (mlSearchRafId != null) cancelAnimationFrame(mlSearchRafId)
    searchGen++  // 作废所有挂起的 chunk
    pendingViewportStick = false
    if (_onCmdDown) window.removeEventListener('keydown', _onCmdDown)
    if (_onCmdUp) window.removeEventListener('keyup', _onCmdUp)
    terminalSettingsUnsubscribe?.()
    if (_onWheelFallback) containerEl?.removeEventListener('wheel', _onWheelFallback, { capture: true })
    bytesUnsubscribe?.().catch((e) => console.warn('[term] unsubscribe bytes failed', e))
    disposeWebgl()
    try {
      term?.dispose()
    } catch {}
    term = null
    fitAddon = null
    searchAddon = null
  })

  function disposeWebgl() {
    const addon = webglAddon
    webglAddon = null
    if (!addon) return
    try { addon.dispose() } catch {}
  }

  async function setWebglActive(active: boolean) {
    const generation = ++webglLoadGeneration
    if (!active) {
      disposeWebgl()
      return
    }
    if (destroyed || !term || webglAddon) return
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl')
      if (destroyed || !term || !visible || generation !== webglLoadGeneration) return
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        // context loss 后立即释放并回到 xterm 原生 renderer。下一次 tab 激活会
        // 再尝试创建;正常情况下 active-only 策略不会再撞 context 上限。
        if (webglAddon === addon) disposeWebgl()
      })
      term.loadAddon(addon)
      webglAddon = addon
      term.refresh(0, term.rows - 1)
    } catch (e) {
      console.warn('[term] WebGL addon failed, falling back:', e)
    }
  }

  // 父组件 visible 变化时调一下 fit(从隐藏切回显示后,字号可能变了)。
  // 传 stickToBottom=true:fit 完成后强制把 viewport 推回底部。
  // 不能在这里直接调 term.scrollToBottom() —— scheduleResize 内部 50ms 后才 fit,
  // 现在调会被 fit 重置,所以让 scheduleResize 在 fit 之后自己滚。
  //
  // 两道防线,全部走 xterm 原生路径,不手写 DOM/私有字段:
  //   ① scheduleResize(true) —— 常规 fit + repairViewport(50ms debounce)
  //   ② 立即 rAF repairViewport(true) —— 抢在 50ms 前用 forceNativeResync
  //      (设 _lastRecordedBufferLength=-1 → syncScrollArea 无条件 _refresh)
  //      覆盖 cols/rows 不变时 xterm 自身短路、scroll-area 高度不更新的 case。
  //
  // 历史:这里曾在第 ② 步之后再 rAF 跑 forceReflow()(真改容器高度 -1px 强制
  // 同步 reflow + 双帧尺寸抖动 + 二次 fit)。它是"拖窗口"级别的终极手段,却被当
  // 常规切换路径每次执行 —— 来回切 tab 会累积成明显卡顿。已移除;上面两道防线
  // 已能覆盖绝大多数 scroll-area 高度不同步的场景。
  $effect(() => {
    void setWebglActive(visible)
    if (visible) {
      try { term?.focus?.() } catch {}
      scheduleResize(true)
      requestAnimationFrame(() => repairViewport(true))
    }
  })
</script>

<div
  class="term-host"
  class:cmd-held={cmdHeld}
  bind:this={containerEl}
>
  {#if searchOpen}
    <div class="term-search" role="search">
      <input
        bind:this={searchInputEl}
        bind:value={searchQuery}
        oninput={() => onSearchInput()}
        placeholder="Find"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
      />
      <button
        class="seg"
        class:active={searchCaseSensitive}
        onclick={() => toggleCase()}
        title="Match case (Alt+C)"
        aria-label="Match case"
      >Aa</button>
      <button
        class="seg"
        class:active={searchRegex}
        onclick={() => toggleRegex()}
        title="Regular expression (Alt+R)"
        aria-label="Regular expression"
      >.*</button>
      <span class="count" aria-live="polite">
        {#if searchSearching}…{:else if searchInvalidRegex}invalid{:else if !searchQuery}{:else if searchOverCap}{searchMatchIdx}/{searchMatchTotal}+{:else}{searchMatchIdx}/{searchMatchTotal}{/if}
      </span>
      <button class="nav" onclick={() => findPrevMatch()} title="Previous (⇧⏎)" aria-label="Previous match">‹</button>
      <button class="nav" onclick={() => findNextMatch()} title="Next (⏎)" aria-label="Next match">›</button>
      <button class="close" onclick={() => closeSearch()} title="Close (esc)" aria-label="Close search">✕</button>
    </div>
  {/if}
</div>

<style>
  .term-host {
    position: relative;
    width: 100%;
    height: 100%;
    background: var(--bg-base);
    /*
     * 自成 stacking context,堵住宿主装饰层(.root::before 网格 / .root::after 噪声)
     * 从 xterm canvas 边缘 padding / 滚动条 gutter 缝隙透出的可能性。
     * 与 App.svelte `.main { isolation: isolate }` 双重保险。
     */
    isolation: isolate;
  }
  /*
   * xterm.css 默认给 .xterm-viewport 设 background-color:#000(纯黑),
   * 与本应用 dark 底色 var(--bg-base)=#0D0F0E 不完全一致,且 canvas 只覆盖
   * 字符单元格区域、不覆盖 viewport 全部像素 —— gutter / 边缘缝隙会露底。
   * 显式对齐成 var(--bg-base),消除缝隙处的色差与潜在网格泄漏。
   */
  .term-host :global(.xterm .xterm-viewport) {
    /* xterm.css 在组件挂载后动态加载，并写死 overflow-y:scroll。仅改 thumb
       颜色无法阻止 WKWebView 绘制全高系统滑块，因此这里覆盖滚动行为本身：
       没有 scrollback 时不生成滚动条，有溢出时仍可正常滚动。 */
    overflow-y: auto !important;
    background-color: var(--bg-base) !important;
    scrollbar-color: color-mix(in srgb, var(--fg-tertiary) 46%, transparent) transparent;
    scrollbar-width: thin;
  }
  /* xterm 强制 overflow-y:scroll；macOS 设为“始终显示滚动条”时即使内容很短也会
     画出接近整高的 thumb。单独收敛终端滚动条，避免系统白色 thumb 在黑底上形成白条。 */
  .term-host :global(.xterm .xterm-viewport::-webkit-scrollbar) {
    width: 8px;
    height: 8px;
  }
  .term-host :global(.xterm .xterm-viewport::-webkit-scrollbar-track) {
    background: transparent;
  }
  .term-host :global(.xterm .xterm-viewport::-webkit-scrollbar-thumb) {
    min-height: 32px;
    border: 2px solid transparent;
    border-radius: 999px;
    background: color-mix(in srgb, var(--fg-tertiary) 46%, transparent);
    background-clip: padding-box;
  }
  .term-host :global(.xterm .xterm-viewport::-webkit-scrollbar-thumb:hover) {
    background: color-mix(in srgb, var(--fg-secondary) 58%, transparent);
    background-clip: padding-box;
  }
  .term-host :global(.xterm .xterm-viewport::-webkit-scrollbar-thumb:active) {
    background: color-mix(in srgb, var(--fg-secondary) 78%, transparent);
    background-clip: padding-box;
  }
  .term-host :global(.xterm .xterm-viewport::-webkit-scrollbar-corner) {
    background: transparent;
  }
  /* Cmd 按住时整个终端显示 pointer,提示"有可点击的路径" */
  .term-host.cmd-held {
    cursor: pointer;
  }

  @media (forced-colors: active) {
    .term-host :global(.xterm .xterm-viewport) { scrollbar-color: auto; }
    .term-host :global(.xterm .xterm-viewport::-webkit-scrollbar-thumb) { background: CanvasText; }
  }
  /* xterm link decorations(underline)的颜色追随主题 */
  .term-host :global(.xterm-underline-1) {
    text-decoration: underline;
    text-decoration-color: inherit;
  }

  /* ── 搜索栏 overlay ───────────────────────────────────────────
   * VS Code 风格:terminal 右上角浮动。z-index 高于 xterm canvas/viewport。
   * 颜色全部走 CSS 变量,dark/light 通用,不读 isDark。 */
  .term-search {
    position: absolute;
    top: var(--sp-2);
    right: var(--sp-2);
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    background: var(--bg-elevated);
    border: 1px solid var(--bd-default);
    border-radius: 8px;
    box-shadow: var(--sh-md);
    font-size: 12px;
    /* 自成 stacking,避免 xterm canvas 透出 */
    isolation: isolate;
  }
  .term-search input {
    width: 200px;
    min-width: 120px;
    padding: 4px 6px;
    background: var(--bg-input);
    color: inherit;
    border: 1px solid transparent;
    border-radius: 4px;
    font: inherit;
    font-family: '"JetBrains Mono", "SF Mono", Menlo, monospace';
    font-size: 12px;
    outline: none;
  }
  .term-search input:focus {
    border-color: color-mix(in srgb, var(--acc) 50%, var(--bd-default));
  }
  .term-search .seg {
    width: 24px;
    height: 24px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    color: var(--fg-secondary);
    border: 1px solid transparent;
    border-radius: 4px;
    font: inherit;
    font-size: 11px;
    font-family: '"JetBrains Mono", "SF Mono", Menlo, monospace';
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
  }
  .term-search .seg:hover {
    background: color-mix(in srgb, var(--fg-secondary) 12%, transparent);
  }
  .term-search .seg.active {
    background: var(--acc-soft);
    color: var(--acc);
    border-color: color-mix(in srgb, var(--acc) 40%, transparent);
  }
  .term-search .count {
    min-width: 56px;
    text-align: center;
    color: var(--fg-secondary);
    font-family: '"JetBrains Mono", "SF Mono", Menlo, monospace';
    font-size: 11px;
    padding: 0 4px;
    user-select: none;
  }
  .term-search .nav,
  .term-search .close {
    width: 24px;
    height: 24px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    color: var(--fg-secondary);
    border: 1px solid transparent;
    border-radius: 4px;
    font: inherit;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .term-search .nav:hover,
  .term-search .close:hover {
    background: color-mix(in srgb, var(--fg-secondary) 12%, transparent);
    color: var(--fg);
  }
</style>
