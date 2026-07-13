<script lang="ts">
  /**
   * 主窗口:左侧栏(tab 列表) + 右侧 PTY 区 + 底部状态栏。
   *
   * Phase 7 重构(2026-05-30):
   *   - tab 卡片用 session title 作主标题,backend / model chip 作副标签
   *   - context 占用进度条
   *   - 底部状态栏分 input / output / cached + 精确 cost
   *   - 持久化:启动时自动尝试恢复上次 tab(banner 询问)
   *   - 多窗口:Cmd+N 开新窗口(独立 AppState,不恢复)
   *
   * Phase 3 mounted xterm 实例保持常驻,避免 LRU evict 丢 scrollback。
   */
  import { onMount, onDestroy } from 'svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { open } from '@tauri-apps/plugin-dialog'
  import Terminal from './lib/Terminal.svelte'
  import CommandPalette, { type Command } from './lib/CommandPalette.svelte'
  import RenameDialog from './lib/RenameDialog.svelte'
  import ConfirmDialog from './lib/ConfirmDialog.svelte'
  import BackendChooser from './lib/BackendChooser.svelte'
  import PairingDialog from './lib/PairingDialog.svelte'
  import EndpointDialog from './lib/EndpointDialog.svelte'
  import PathsBanner from './lib/PathsBanner.svelte'
  import MemoryPanel from './lib/MemoryPanel.svelte'
  import MemoryBrowsePanel, { type BrowseFilterState } from './lib/MemoryBrowsePanel.svelte'
  import MemorySyncPanel from './lib/MemorySyncPanel.svelte'
  import MemoryMcpBanner from './lib/MemoryMcpBanner.svelte'
  import SettingsPanel from './lib/SettingsPanel.svelte'
  import DeployPanel from './lib/DeployPanel.svelte'
  import MetricsHoverCard from './lib/MetricsHoverCard.svelte'
  import WorkspacePanel from './lib/WorkspacePanel.svelte'
  import ShellTerminalPanel from './lib/ShellTerminalPanel.svelte'
  import Icon from './lib/Icon.svelte'
  import BackendIcon from './lib/BackendIcon.svelte'
  import AvatarSprite from './lib/AvatarSprite.svelte'
  import AvatarPicker from './lib/AvatarPicker.svelte'
  import EventCenter from './lib/EventCenter.svelte'
  import ToastHost from './lib/ToastHost.svelte'
  import { avatarLibrary, loadAvatarLibrary, type AvatarStatus } from './lib/avatars'
  import {
    tabs,
    activeId,
    activeTab,
    mountedIds,
    newTab,
    closeTab,
    selectTab,
    startEventSubscriptions,
    stopEventSubscriptions,
    restoreTabs,
    renameTab,
    reorderTabs,
    duplicateTab,
    restoreTab,
    setTabAvatar,
    type TabInfo,
  } from './lib/sessions'
  import { dndzone, dragHandleZone, dragHandle } from 'svelte-dnd-action'
  import type { DndEvent } from 'svelte-dnd-action'
  import { longpressGate, TAB_DRAG_LONG_PRESS_MS } from './lib/longpress_gate'
  import { outsidePressClose } from './lib/outside_close'
  import { ipc, endpointIpc, backendAdminIpc, type BackendInfo, type EndpointSummary, type PersistedTab, type SessionId, type SpecOpsSession, type ThemeMode, type LocaleMode } from './lib/ipc'
  import { memoryIpc, memoryMcpIpc } from './lib/ipc'
  import { shortModelName, compactModelName, modelAbbr, backendChip, formatTokens } from './lib/model_alias'
  import { currentLocale, setLocaleModeFromString, setLocaleMode, t, type Params } from './lib/i18n'

  /**
   * 模板专用的响应式翻译函数。t() 本身不读任何 reactive 源,直接在常驻模板里用
   * `{t('x')}` 切换语言不会重渲染(命令面板靠 `void $currentLocale` 显式建依赖)。
   * tr 用 $derived 绑定 $currentLocale → locale 变时重建 → 模板中 tr('x') 重跑。
   */
  let tr = $derived.by(() => {
    void $currentLocale
    return (key: string, params?: Params) => t(key, params)
  })

  let backends: BackendInfo[] = $state([])
  let bootError: string | null = $state(null)
  /** Phase 11.6:已配置的远端 endpoint 列表(含 connected 状态),用于状态栏指示器。
   * 不轮询 —— endpoint 变化时 EndpointDialog 关闭时手动刷新;connected 指向 WS 上线。
   * 启动时拉一次,EndpointDialog onClose 后再拉一次。 */
  let endpoints: EndpointSummary[] = $state([])
  let paletteOpen = $state(false)
  let renameOpen = $state(false)
  /** 显式弹出后端选择器(Cmd+T 触发,或主区域为空时常驻) */
  let chooserOpen = $state(false)
  /** Phase 9.1.2 配对弹层(给手机 App 扫 QR)*/
  let pairingOpen = $state(false)
  /** Phase 11.4 远端 endpoint 配置面板 */
  let endpointsOpen = $state(false)
  /** 路径配置 banner —— 默认隐藏;用户可用 Cmd+, 打开 */
  let pathsOpen = $state(false)
  /** 隐藏的开发者细节(默认隐藏,Cmd+Shift+D 切换) */
  let showDevInfo = $state(false)
  /** M4:memory review queue 面板。Cmd+Shift+M 打开。 */
  let memoryPanelOpen = $state(false)
  /** Memory git sync 配置面板。Cmd+P → "Memory: Sync settings…" */
  let memorySyncOpen = $state(false)
  /** M4.3:memory browse 面板(已 approve 池)。Cmd+Shift+B 打开。 */
  let memoryBrowseOpen = $state(false)
  /** 2026-06:Settings 面板(命令面板「Settings…」或 ⌘, 打开)。
   *  backend 的增删改查 + 开关全在这个面板内 inline 完成,不再有独立的 manage 浮层。 */
  let settingsOpen = $state(false)
  let deployOpen = $state(false)
  let workspacePanelOpen = $state(false)
  // inspector 宽度可拖拽调整,带上下限。
  const INSPECTOR_MIN = 280
  const INSPECTOR_MAX = 1440
  let inspectorWidth = $state(420)
  let inspectorResizing = $state(false)

  // 终端面板(工作区检查器底部)
  let terminalPanelOpen = $state(false)
  let terminalEnsureToken = $state(0)
  let terminalHeight = $state(280)
  const TERMINAL_MIN_H = 80
  const TERMINAL_MAX_H = 800

  async function refreshEndpoints() {
    try {
      endpoints = await endpointIpc.list()
    } catch {
      // endpoint 指示器不是主流程,失败时保持旧快照。
    }
  }

  async function onDeployCompleted() {
    await refreshEndpoints()
    window.dispatchEvent(new CustomEvent('kode:endpoints-changed'))
  }

  function toggleTerminalPanel() {
    if (terminalPanelOpen) {
      terminalPanelOpen = false
      return
    }
    terminalPanelOpen = true
    terminalEnsureToken += 1
  }

  function startInspectorResize(e: PointerEvent) {
    e.preventDefault()
    inspectorResizing = true
    const startX = e.clientX
    const startW = inspectorWidth
    // 上限同时受窗口宽度约束(最多留 360px 给主区)
    const maxByWindow = Math.max(INSPECTOR_MIN, window.innerWidth - 360)
    const upper = Math.min(INSPECTOR_MAX, maxByWindow)
    const onMove = (ev: PointerEvent) => {
      // 把手在 inspector 左缘:向左拖(clientX 变小)→ 变宽
      const next = startW + (startX - ev.clientX)
      inspectorWidth = Math.min(upper, Math.max(INSPECTOR_MIN, next))
    }
    const onUp = () => {
      inspectorResizing = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function startTerminalResize(e: PointerEvent) {
    e.preventDefault()
    const startY = e.clientY
    const startH = terminalHeight
    const onMove = (ev: PointerEvent) => {
      // 把手在终端面板上缘:向上拖(clientY 变小)→ 变高
      const next = startH + (startY - ev.clientY)
      terminalHeight = Math.min(TERMINAL_MAX_H, Math.max(TERMINAL_MIN_H, next))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /** 当前展开 ⋯ 菜单的 tab id;同时只开一个 */
  let menuOpenId = $state<SessionId | null>(null)
  /** Avatar picker 状态:null = 关闭;对象 = 已打开,绑定到对应 tab */
  let pickerState = $state<{
    tabId: SessionId
    tabBackendKey: string
    avatarId: string | null
    rect: DOMRect
  } | null>(null)
  /** 当前行内 rename 的 tab id */
  let editingId = $state<SessionId | null>(null)
  /** 行内 rename 输入值 */
  let editValue = $state('')
  /** 行内 rename input 的 DOM 引用,用于 $effect 聚焦 */
  let renameInputEl: HTMLInputElement | null = $state(null)
  /** dnd 进行中 —— 禁用 ⋯ 按钮 hover 显形,避免拖拽途中误触 */
  let dragging = $state(false)
  /** workspace header 同时是折叠按钮和拖拽 handle;拖拽完成后的 click 必须吞掉。 */
  let suppressNextCollapseClick = $state(false)
  /**
   * 工作区分栏:按 cwd 把 tabs 分组,每组一个可折叠 section header。
   * 单 workspace 时退化为平铺列表(不渲染 header),避免常见单项目场景出现多余 UI。
   *
   * DnD 影子数组改为按 cwd 分组的 `groupShadows` —— 每个 workspace 一个独立
   * dndzone(type 带 cwd 后缀),自然禁止跨组拖拽(tab 的 cwd 在 spawn 时固定,
   * 跨组拖拽语义上矛盾)。consider 改影子,finalize 落回 $tabs + schedulePersist。
   *
   * **必须用 $effect 在非拖拽时把分组同步到 groupShadows** —— dndzone 的 update
   * hook 遍历 node.children 绑 mousedown,若 items 初始为空或与实际 DOM 不同步,
   * mousedown 绑不上;拖拽开始后 shadow item 不会进入 DOM,被拖的 tab 会“消失”。
   */
  type WsGroup = {
    id: string
    cwd: string
    name: string
    fullPath: string
    pathHint: string
    showPathHint: boolean
    endpointKind: 'local' | 'remote'
    tabs: TabInfo[]
  }

  /** 按 endpoint + cwd 分组(保留首次出现顺序);cwd 缺失归入 '(no cwd)' 组,显示名 Other。
   *  id 字段值 = endpoint + cwd,用于 dnd item 标识、折叠状态和同路径 local/remote 隔离。 */
  const wsGroups = $derived.by<WsGroup[]>(() => {
    const order: string[] = []
    const map = new Map<string, TabInfo[]>()
    for (const t of $tabs) {
      const key = wsGroupKey(t)
      let arr = map.get(key)
      if (!arr) {
        arr = []
        map.set(key, arr)
        order.push(key)
      }
      arr.push(t)
    }

    const draft = order.map((key) => {
      const tabs = map.get(key)!
      const first = tabs[0]
      const cwd = first.cwd ?? '(no cwd)'
      const endpoint = wsEndpointInfo(first)
      const name = cwd === '(no cwd)' ? 'Other' : wsBasename(cwd)
      return {
        id: key,
        cwd,
        name,
        fullPath: cwd === '(no cwd)' ? '' : wsCompactPath(cwd, homeDir),
        pathHint: cwd === '(no cwd)' ? '' : wsPathHint(cwd, homeDir),
        showPathHint: false,
        endpointKind: endpoint.kind,
        tabs,
      }
    })

    const nameCounts = new Map<string, number>()
    for (const g of draft) nameCounts.set(g.name, (nameCounts.get(g.name) ?? 0) + 1)
    return draft.map((g) => ({
      ...g,
      showPathHint: (nameCounts.get(g.name) ?? 0) > 1 && !!g.pathHint,
    }))
  })

  /** 是否渲染分组 header —— 单组时不渲染,保持原平铺体验。 */
  const wsGrouped = $derived(wsGroups.length > 1)

  /** 全局序号(按 $tabs 顺序),用于 tab 角标 / tooltip / Cmd+1..9。 */
  const wsGlobalIdx = $derived.by(() => {
    const m = new Map<number, number>()
    let i = 0
    for (const t of $tabs) m.set(t.id, i++)
    return m
  })

  /** 每个 workspace 的 dnd 影子数组;非拖拽时由 $effect 从 wsGroups 同步。 */
  let groupShadows = $state<Record<string, TabInfo[]>>({})
  $effect(() => {
    if (dragging) return
    const next: Record<string, TabInfo[]> = {}
    for (const g of wsGroups) next[g.id] = g.tabs
    groupShadows = next
  })

  /** workspace 分组顺序的影子数组;拖拽时跟随,非拖拽时由 $effect 同步。 */
  let wsShadows = $state<WsGroup[]>([])
  $effect(() => {
    if (dragging) return
    wsShadows = [...wsGroups]
  })

  /** 折叠的 workspace cwd 集合;持久化到 localStorage,默认全展开。 */
  const WS_COLLAPSED_KEY = 'kode:workspace-collapsed'
  let collapsedCwds = $state<Set<string>>(loadCollapsedCwds())
  $effect(() => {
    try {
      localStorage.setItem(WS_COLLAPSED_KEY, JSON.stringify([...collapsedCwds]))
    } catch { /* localStorage 不可用时静默 */ }
  })
  function loadCollapsedCwds(): Set<string> {
    try {
      const raw = localStorage.getItem(WS_COLLAPSED_KEY)
      if (!raw) return new Set()
      const arr = JSON.parse(raw)
      return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set()
    } catch {
      return new Set()
    }
  }
  function toggleCollapse(groupId: string) {
    const next = new Set(collapsedCwds)
    if (next.has(groupId)) next.delete(groupId)
    else next.add(groupId)
    collapsedCwds = next
  }
  function onWorkspaceHeaderClick(e: MouseEvent, groupId: string) {
    if (suppressNextCollapseClick) {
      e.preventDefault()
      e.stopPropagation()
      suppressNextCollapseClick = false
      return
    }
    toggleCollapse(groupId)
  }

  /**
   * 切到某 tab 时,若其所在 workspace 被折叠,自动展开 —— active tab 永远可见。
   *
   * **只在 active tab 的 id 变化时触发**,不在 collapsedCwds 变化时触发:
   * 否则用户手动折叠 active tab 所在组时,这个 effect 会立刻把它展开回去
   * (因为 collapsedCwds 变 → effect 重跑 → active 的 cwd 还在集合里 → 删掉 → 展开),
   * 导致「选中了 session 的 workspace 组无法收起」。
   * 用 lastExpandedForActiveId 守门:id 没变就跳过,尊重用户的手动折叠。
   */
  let lastExpandedForActiveId: number | null = null
  $effect(() => {
    const at = $activeTab
    if (!at) { lastExpandedForActiveId = null; return }
    if (at.id !== lastExpandedForActiveId) {
      lastExpandedForActiveId = at.id
      const groupId = wsGroupKey(at)
      if (collapsedCwds.has(groupId)) {
        const next = new Set(collapsedCwds)
        next.delete(groupId)
        collapsedCwds = next
      }
    }
  })

  function wsEndpointInfo(tab: TabInfo): { kind: 'local' | 'remote'; label: string } {
    if (tab.endpointId?.kind === 'remote') return { kind: 'remote', label: tab.endpointId.id }
    return { kind: 'local', label: 'local' }
  }
  function wsGroupKey(tab: TabInfo): string {
    const cwd = tab.cwd ?? '(no cwd)'
    const endpoint = wsEndpointInfo(tab)
    return `${endpoint.kind}:${endpoint.label}\u0000${cwd}`
  }
  function wsBasename(cwd: string): string {
    const parts = cwd.split('/').filter(Boolean)
    return parts[parts.length - 1] ?? cwd
  }
  function wsCompactPath(cwd: string, home: string): string {
    if (!cwd) return ''
    if (home && (cwd === home || cwd.startsWith(home + '/'))) {
      return '~' + cwd.slice(home.length)
    }
    return cwd
  }
  function wsPathHint(cwd: string, home: string): string {
    const compact = wsCompactPath(cwd, home)
    const idx = compact.lastIndexOf('/')
    const parent = idx > 0 ? compact.slice(0, idx) : compact
    if (parent.length <= 34) return parent
    const parts = parent.split('/').filter(Boolean)
    const tail = parts.slice(-2).join('/')
    if (parent.startsWith('~/')) return `~/…/${tail}`
    if (parent.startsWith('/')) return `…/${tail}`
    return `…/${tail}`
  }

  /**
   * 右键 / ⋯ 菜单的固定定位样式。用 position: fixed 让菜单逃出 .tab-list 的
   * overflow:auto 裁切(底部 tab 的菜单不会被截断)。打开时根据锚点元素在视口
   * 里的位置算 top/right;下方空间不够时翻转到上方。
   */
  let menuStyle = $state('')
  function toggleMenu(id: SessionId, anchorEl?: HTMLElement) {
    if (menuOpenId === id) {
      menuOpenId = null
      return
    }
    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect()
      // 菜单宽度约 168px,高度约 120px(3 项 + padding)。右侧对齐锚点右边缘。
      const menuW = 168
      const menuH = 130
      const right = window.innerWidth - r.right
      const spaceBelow = window.innerHeight - r.bottom
      const flipUp = spaceBelow < menuH + 8 && r.top > menuH + 8
      const top = flipUp ? r.top - menuH - 4 : r.bottom + 4
      menuStyle = `position:fixed;top:${top}px;right:${Math.max(4, right)}px;left:auto;`
    } else {
      menuStyle = ''
    }
    menuOpenId = id
  }
  function closeMenu() {
    menuOpenId = null
  }
  /** 关闭 tab 前的二次确认。killSession 不可撤销,弹窗确认后再执行 closeTab。 */
  let closeConfirm = $state<{ id: SessionId; title: string } | null>(null)
  function requestCloseTab(id: SessionId, title: string) {
    closeConfirm = { id, title }
  }
  function confirmCloseTab() {
    if (!closeConfirm) return
    const id = closeConfirm.id
    closeConfirm = null
    closeTab(id)
  }
  function cancelCloseTab() {
    closeConfirm = null
  }
  /** 打开 avatar picker,锚定到触发元素的位置 */
  function openAvatarPicker(
    tabId: SessionId,
    avatarId: string | null,
    rect: DOMRect,
  ) {
    const tab = $tabs.find((t) => t.id === tabId)
    pickerState = {
      tabId,
      tabBackendKey: tab?.backendKey ?? '',
      avatarId,
      rect,
    }
  }
  function closeAvatarPicker() {
    pickerState = null
  }
  function startRename(id: SessionId, currentTitle: string) {
    editingId = id
    editValue = currentTitle
    menuOpenId = null
  }
  function commitRename(id: SessionId) {
    const v = editValue.trim()
    if (v) renameTab(id, v)
    editingId = null
  }
  function cancelRename() {
    editingId = null
  }
  // 进入编辑态时聚焦 + 全选 input
  $effect(() => {
    if (editingId != null && renameInputEl) {
      renameInputEl.focus()
      renameInputEl.select()
    }
  })
  /**
   * 全局 click-outside:点非菜单/more-btn 区域时关菜单。挂在 <svelte:window> 上,
   * 覆盖终端区、sidebar 空白、inspector 等所有区域 —— 不再依赖事件穿过 dndzone
   * 冒泡到 .tab-list。more-btn / 菜单项的 onclick 都 stopPropagation,不会误触。
   */
  function onGlobalClick(e: MouseEvent) {
    if (menuOpenId == null) return
    const target = e.target as Element | null
    if (target && target.closest('.tab-menu, .more-btn')) return
    closeMenu()
  }
  /** compact 模式右键 → 开菜单 */
  function onTabContext(e: MouseEvent, id: SessionId) {
    e.preventDefault()
    toggleMenu(id, e.currentTarget as HTMLElement)
  }

  /**
   * 统一 HTML5 文件拖拽(dragDropEnabled:false)。支持三种来源:
   *   1. WorkspacePanel 文件树内部拖拽 → 自定义 MIME `application/x-kode-file`
   *   2. Finder / VS Code 拖文件进来 → dataTransfer.files,Tauri 给 File 注入 .path
   *
   * xterm.js 会消费终端区的 drop 事件,所以拖拽中渲染一个 overlay div 覆盖终端,
   * 由 overlay 捕获 drop —— 绕过 xterm 的事件拦截。
   */
  function onMainDragOver(e: DragEvent) {
    const types = e.dataTransfer?.types ?? []
    if (!types.includes('application/x-kode-file') && !types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'copy'
    dragOver = true
  }
  function onMainDragLeave(e: DragEvent) {
    if (e.currentTarget === e.target) dragOver = false
  }
  function onOverlayDrop(e: DragEvent) {
    e.preventDefault()
    dragOver = false
    const dt = e.dataTransfer
    if (!dt) return
    const tab = $activeTab
    if (!tab) return

    // 1. 内部拖拽(WorkspacePanel 文件树)
    const raw = dt.getData('application/x-kode-file')
    if (raw) {
      try {
        const { path, endpointId } = JSON.parse(raw) as { path: string; endpointId: string | null }
        const tabEp = tab.endpointId?.kind === 'remote' ? tab.endpointId.id : null
        if (endpointId !== tabEp) return
        ipc.writeInput(tab.id, new TextEncoder().encode(`@${path} `), tab.endpointId)
          .then(() => focusTerminal())
          .catch((err) => console.warn('internal drag-drop failed:', err))
      } catch {}
      return
    }

    // 2. 外部文件拖拽(Finder / VS Code)
    if (!dt.types.includes('Files')) return
    if (tab.endpointId && tab.endpointId.kind === 'remote') return
    const paths: string[] = []
    for (let i = 0; i < dt.files.length; i++) {
      const f = dt.files[i] as File & { path?: string }
      // Tauri 2 在 macOS WKWebView 给 File 注入 .path;若没有则退化为 name
      paths.push(f.path ?? f.name)
    }
    if (paths.length === 0) return
    const text = paths.map((p) => `@${p}`).join(' ') + ' '
    ipc.writeInput(tab.id, new TextEncoder().encode(text), tab.endpointId)
      .then(() => focusTerminal())
      .catch((err) => console.warn('external drag-drop failed:', err))
  }
  /** 拖拽完成后 focus 到终端,让用户直接继续打字 */
  function focusTerminal() {
    const el = document.querySelector<HTMLTextAreaElement>('.main .xterm-helper-textarea')
    el?.focus()
  }
  function onDndConsider(e: CustomEvent<DndEvent>) {
    // svelte-dnd-action 不走原生 dragstart;第一次 consider 才表示拖拽真正开始。
    dragging = true
    menuOpenId = null
    // consider 频繁触发 —— 只改当前组的影子数组,不写 store,不 schedulePersist。
    // detail.items 包含 shadow item,必须用于渲染,否则被拖 tab 会从 DOM 中“消失”。
    const groupId = (e.currentTarget as HTMLElement).dataset.groupId ?? ''
    groupShadows = { ...groupShadows, [groupId]: [...(e.detail.items as TabInfo[])] }
  }
  function onDndFinalize(e: CustomEvent<DndEvent>) {
    const groupId = (e.currentTarget as HTMLElement).dataset.groupId ?? ''
    const finalItems = e.detail.items as TabInfo[]
    const original = wsGroups.find((g) => g.id === groupId)?.tabs ?? []
    // 保护持久状态:异常空 items / 跨组混入绝不能落盘。
    if (finalItems.length !== original.length || finalItems.some((t) => !original.some((o) => o.id === t.id))) {
      dragging = false
      groupShadows = { ...groupShadows, [groupId]: [...original] }
      return
    }
    groupShadows = { ...groupShadows, [groupId]: [...finalItems] }
    // 重建完整 $tabs 顺序:其他组保持原序,当前组用 finalize 后的新序。
    const nextOrder: SessionId[] = []
    for (const g of wsGroups) {
      const src = g.id === groupId ? finalItems : g.tabs
      for (const t of src) nextOrder.push(t.id)
    }
    reorderTabs(nextOrder)
    dragging = false
  }

  /** workspace 分组级别的拖拽回调:把整个分组上下重排。 */
  function clearWorkspaceDragClickSuppression() {
    window.setTimeout(() => {
      suppressNextCollapseClick = false
    }, 0)
  }
  function onWsDndConsider(e: CustomEvent<DndEvent>) {
    dragging = true
    suppressNextCollapseClick = true
    menuOpenId = null
    wsShadows = [...(e.detail.items as WsGroup[])]
  }
  function onWsDndFinalize(e: CustomEvent<DndEvent>) {
    // 过滤 shadow item(svelte-dnd-action 的占位),只保留真实 workspace。
    // isDndShadowItem 是运行时注入的标记,不在 WsGroup 类型里,用 as any 读取。
    const finalGroups = (e.detail.items as WsGroup[]).filter(
      (g): g is WsGroup =>
        !!g && !(g as any).isDndShadowItem && Array.isArray(g.tabs),
    )
    // 保护:数量或 workspace id 集合不一致时回滚,避免脏数据落盘。
    const origIds = new Set(wsGroups.map((g) => g.id))
    if (
      finalGroups.length !== wsGroups.length ||
      finalGroups.some((g) => !origIds.has(g.id))
    ) {
      dragging = false
      wsShadows = [...wsGroups]
      clearWorkspaceDragClickSuppression()
      return
    }
    wsShadows = [...finalGroups]
    // 把 wsGroups 新顺序映射回 $tabs:按新 workspace 顺序拼接所有 tab id。
    const nextOrder: SessionId[] = []
    for (const g of finalGroups) {
      for (const t of g.tabs) nextOrder.push(t.id)
    }
    reorderTabs(nextOrder)
    dragging = false
    clearWorkspaceDragClickSuppression()
  }

  /// 任何模态弹层打开时为 true —— 全局 Cmd/Ctrl 快捷键 handler 据此放行,
  /// 让弹层内 input 的 Cmd+A/C/V/Z 等原生编辑键不被拦截。
  /// 新增弹层只要用 `*Open = true` 控制,这里自动覆盖,无需再改 handler。
  let anyModalOpen = $derived(
    paletteOpen ||
      renameOpen ||
      chooserOpen ||
      pairingOpen ||
      endpointsOpen ||
      pathsOpen ||
      memoryPanelOpen ||
      memorySyncOpen ||
      memoryBrowseOpen ||
      settingsOpen ||
      deployOpen ||
      pickerState != null,
  )
  /** SpecOps console session. The token remains in-memory and is injected via URL fragment. */
  let specopsSession: SpecOpsSession | null = $state(null)
  let specopsOpening = $state(false)
  let specopsError: string | null = $state(null)
  /** memory hover 卡片显示态;徽章 hover 300ms 后显示。 */
  let memoryHoverVisible = $state(false)
  let memoryHoverTimer: number | null = null
  /** Browse 面板上次的 filter(从 PersistedState 加载,改动时同步回去) */
  let memoryBrowseFilter: BrowseFilterState | null = $state(null)
  /** 当前 scope(初值跟当前 active tab 的 cwd 推断;Browse 用作默认) */
  let memoryScope = $state('')
  /** ~/.kode-memory 当前 pending 数(状态栏右侧 badge);后端 watcher 推送。 */
  let memoryPendingCount = $state(0)
  /** 远端 endpoint_id -> pending 数;bridge 通过 memory.pending WS 事件推送。 */
  let remoteMemoryPendingCounts: Record<string, number> = $state({})
  let totalMemoryPendingCount = $derived(
    memoryPendingCount + Object.values(remoteMemoryPendingCounts).reduce((a, b) => a + b, 0),
  )
  /** $HOME — 启动时一次性拿,用于状态栏 cwd 路径的 ~ 缩写。失败 = 空串(不缩写) */
  let homeDir = $state('')
  /** banner 组件引用,命令面板需要触发 forceShow */
  let memoryMcpBannerRef: { show: () => void } | undefined = $state()
  /** kode-memory prompt 注入开关(state.json 持久化)。命令面板项展示 + 预览用。
   *  启动时拉一次,toggle 时跟着 ipc 调用更新。改了**只对下次新建 tab 生效**,
   *  现存 tab 的子进程已固化的 args 不会被重写 —— UI 文案需要明确这点。 */
  let memoryPromptEnabled = $state(true)
  /** 注入文本字节数,命令面板 label 显示用("(X B)") */
  let memoryPromptBytes = $state(0)
  /** 当前展开的预览(null = 关闭) */
  let memoryPromptPreviewText: string | null = $state(null)
  /** 全局 UI 主题。null/初始 = 'system' 走系统偏好。state.json 持久化。 */
  let theme: ThemeMode = $state('system')
  /** 全局 UI 语言。system 走 navigator.language。 */
  let locale: LocaleMode = $state('system')
  /** 系统当前是否 dark — 仅 theme=system 时才用,监听 prefers-color-scheme 变化。 */
  let systemPrefersDark = $state(true)
  /** restore banner */
  let restorable: PersistedTab[] = $state([])
  /** 侧栏显示模式 — Cmd+B 三态循环 full → compact → hidden → full
   *  - full:260px 完整 tab 卡片(title / chips / ctx 进度条)
   *  - compact:52px 窄条,只显示序号 + status dot + unread/attention 标记
   *    完整 title / model 通过 .tab 的 title 属性(native tooltip)悬停揭示
   *  - hidden:完全隐藏(0 列),主区占满
   *  Cmd+B 仍然在 hidden 下工作(svelte:window onkeydown 不依赖 sidebar 渲染),
   *  Cmd+P 命令面板里也有对应项,所以隐藏后可恢复。
   */
  type SidebarMode = 'full' | 'compact' | 'hidden'
  let sidebarMode: SidebarMode = $state('full')
  function cycleSidebar() {
    sidebarMode =
      sidebarMode === 'full' ? 'compact' :
      sidebarMode === 'compact' ? 'hidden' : 'full'
  }
  /// 反向(命令面板 ← 用)。
  function cycleSidebarPrev() {
    sidebarMode =
      sidebarMode === 'full' ? 'hidden' :
      sidebarMode === 'hidden' ? 'compact' : 'full'
  }

  async function openSpecOps(force = false) {
    if (specopsSession && !force) {
      // 已有 session,直接打开独立窗口
      try {
        await ipc.openSpecOpsWindow(specopsSession, theme, locale)
      } catch (error) {
        console.error('Failed to open specops window:', error)
        specopsError = 'Could not open SpecOps window'
      }
      return
    }
    if (specopsOpening) return
    // force=true 且已有 session:先关闭当前 sidecar,再重新走 picker
    if (specopsSession && force) {
      await closeSpecOps()
    }
    specopsOpening = true
    specopsError = null
    try {
      const picked = await open({ directory: true, multiple: false, title: 'Open a Git workspace in SpecOps' })
      if (typeof picked !== 'string') return
      specopsSession = await ipc.specopsOpen(picked)
      // 打开独立窗口
      try {
        await ipc.openSpecOpsWindow(specopsSession, theme, locale)
      } catch (error) {
        console.error('Failed to open specops window:', error)
        specopsError = 'Could not open SpecOps window'
      }
    } catch (error) {
      specopsError = String(error)
    } finally {
      specopsOpening = false
    }
  }

  async function closeSpecOps() {
    const session = specopsSession
    specopsSession = null
    if (session) {
      try { await ipc.specopsClose(session.workspace) } catch (error) { console.error('specopsClose failed:', error) }
    }
  }

  function onSpecOpsMessage(event: MessageEvent) {
    // 独立窗口模式下,不再需要处理 specops 消息
    // 保留空实现以防未来需要
    void event
  }
  /** 是否跳过持久化恢复(新窗口走这里;query string 检测) */
  const skipPersist = (() => {
    try {
      return new URLSearchParams(window.location.search).has('skip_persist')
    } catch {
      return false
    }
  })()

  // 监听系统主题变化(只在 theme=system 时影响 UI;其它模式下我们仍跟踪以防切回 system)。
  let mql: MediaQueryList | null = null
  function onSystemThemeChange(e: MediaQueryListEvent | MediaQueryList) {
    systemPrefersDark = e.matches
  }

  onMount(async () => {
    try {
      // theme 优先 — 在拉 backends 前加载,避免页面闪 dark→light
      try {
        const l = await ipc.getLocale()
        if (l === 'en' || l === 'zh-CN' || l === 'system') {
          locale = l
          setLocaleModeFromString(l)
        } else {
          setLocaleMode('system')
        }
      } catch (e) {
        console.warn('getLocale failed:', e)
        setLocaleMode('system')
      }
      try {
        const t = await ipc.getTheme()
        if (t === 'light' || t === 'dark' || t === 'system') {
          theme = t
        }
      } catch (e) {
        console.warn('getTheme failed:', e)
      }
      mql = window.matchMedia('(prefers-color-scheme: dark)')
      systemPrefersDark = mql.matches
      mql.addEventListener('change', onSystemThemeChange)

      // $HOME 拿一次就够 — 用于状态栏 cwd 路径 ~ 缩写
      try {
        homeDir = (await ipc.getHomeDir()) || ''
      } catch {
        homeDir = ''
      }

      void loadAvatarLibrary()
      await startEventSubscriptions()
      backends = await ipc.listBackends()
      // 订阅 backend 开关/增删变更 — SettingsPanel 写盘后 Rust 端 emit `backends-changed`,
      // 这里重新拉一次让 BackendChooser 立刻看到最新列表(无需重启 GUI)。
      // list_backends 已读 config.toml 实时值,ctx.config 仅决定 key 集合(冷快照)。
      backendsUnlisten = await backendAdminIpc.onChanged(async () => {
        try {
          backends = await ipc.listBackends()
        } catch (e) {
          console.warn('refresh backends on changed:', e)
        }
      })
      // Phase 11.6:启动时拉 endpoints 列表(用于状态栏连接指示)
      try {
        endpoints = await endpointIpc.list()
      } catch {
        // 没有 endpoint 也不影响启动
      }
      // M4 memory:订阅 pending 数变化(后端 1.5s 轮询 + review/propose 后即时 emit)
      try {
        memoryUnlisten = await memoryIpc.onPendingCount((n) => {
          memoryPendingCount = n
        })
        remoteMemoryUnlisten = await memoryIpc.onRemotePendingCount((m) => {
          remoteMemoryPendingCounts = { ...remoteMemoryPendingCounts, [m.endpoint_id]: m.count }
        })
        // 启动时先拉一次,因为后端 watcher 只在 pending 数**变化**时 emit。
        try {
          const st = await memoryIpc.stats()
          memoryPendingCount = st.pending
        } catch {
          // memory 子系统可能未启用 — 静默
        }
      } catch (e) {
        console.warn('memory subscribe failed:', e)
      }
      // M4.2 kode-memory prompt 注入开关 — 启动时拉一次给命令面板项展示
      try {
        const ps = await memoryMcpIpc.promptStatus()
        memoryPromptEnabled = ps.enabled
        memoryPromptBytes = ps.preview_bytes
      } catch (e) {
        // memory_mcp 子模块可能未注册 — 静默,命令面板项仍可见但点击会报错
        console.warn('memoryPromptStatus failed:', e)
      }
      // M4.3 Browse filter 持久化恢复
      try {
        const bs = await memoryIpc.browseStateGet()
        if (bs) memoryBrowseFilter = bs
      } catch {
        // 无持久化或失败 — 静默,Browse 自带空默认
      }
      if (!skipPersist) {
        const persisted = await ipc.getPersistedTabs()
        if (persisted && persisted.length > 0) {
          restorable = persisted
        }
      }
      // 不自动 spawn —— 等用户在 BackendChooser 里点选,或 Cmd+T,或点 restore
    } catch (e) {
      bootError = String(e)
      console.error(e)
    }
  })

  /** memory pending 订阅 unlisten — onMount 设置,onDestroy 调用 */
  let memoryUnlisten: (() => void) | null = null
  let remoteMemoryUnlisten: (() => void) | null = null
  /** backend 开关/增删变更 unlisten — 同上 */
  let backendsUnlisten: (() => void) | null = null
  /** 文件正在拖入窗口(用于终端区高亮提示) */
  let dragOver = $state(false)

  onDestroy(() => {
    stopEventSubscriptions()
    mql?.removeEventListener('change', onSystemThemeChange)
    memoryUnlisten?.()
    remoteMemoryUnlisten?.()
    backendsUnlisten?.()
  })

  // theme 变化 → 写 <html data-theme="…">。
  // - theme=system → 不写 attribute(走 @media prefers-color-scheme)
  // - theme=light/dark → 显式 attribute,覆盖 media query
  // 注意:故意不直接写 `systemPrefersDark` 来决定 attribute,因为我们想让 CSS 的 media
  // query 全权处理 system 模式下的切换;Svelte $effect 只在 theme 改变时跑一次。
  $effect(() => {
    const root = document.documentElement
    if (theme === 'system') {
      root.removeAttribute('data-theme')
    } else {
      root.setAttribute('data-theme', theme)
    }
  })

  /// 命令面板"Memory Prompt: 预览注入内容":刷一遍状态后展开 dialog。
  /// 状态可能在 GUI 跑期间被外部改(比如直接编辑 state.json),所以每次都重拉。
  async function openPromptPreview() {
    try {
      const ps = await memoryMcpIpc.promptStatus()
      memoryPromptEnabled = ps.enabled
      memoryPromptBytes = ps.preview_bytes
      memoryPromptPreviewText = ps.preview
    } catch (e) {
      memoryPromptPreviewText = `(failed to load preview: ${String(e)})`
    }
  }

  /// toggle 注入开关。改完只对**下次** spawn 的 tab 生效 — UI 文案已经说清这点,
  /// 不再额外弹 toast。
  async function togglePromptEnabled() {
    const next = !memoryPromptEnabled
    try {
      await memoryMcpIpc.promptSetEnabled(next)
      memoryPromptEnabled = next
    } catch (e) {
      console.error('promptSetEnabled failed:', e)
    }
  }

  /// 三态循环(命令面板 + PathsBanner 都用这个)。写盘失败也无妨,内存里照样切换。
  function cycleTheme() {
    theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'
    ipc.setTheme(theme).catch((e) => console.warn('setTheme failed:', e))
  }

  /// 反向(命令面板 ← 用)。
  function cycleThemePrev() {
    theme = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system'
    ipc.setTheme(theme).catch((e) => console.warn('setTheme failed:', e))
  }

  /// PathsBanner 三态按钮组用 — 显式 set 到指定值。
  function setTheme(next: ThemeMode) {
    theme = next
    ipc.setTheme(next).catch((e) => console.warn('setTheme failed:', e))
  }

  function setLocale(next: LocaleMode) {
    locale = next
    setLocaleMode(next)
    ipc.setLocale(next).catch((e) => console.warn('setLocale failed:', e))
  }

  /// 状态栏右下角的 cwd 路径压缩。
  /// 1. $HOME 前缀替换成 ~
  /// 2. 长度 ≤ maxLen 直接返回
  /** Phase 11.6:当前 active tab 走的远端 endpoint(local tab → null)。
   *  用于状态栏连接指示器。 */
  const activeRemoteEndpoint = $derived((() => {
    const eid = $activeTab?.endpointId
    if (!eid || eid.kind !== 'remote') return null
    return endpoints.find((e) => e.id === eid.id) ?? { id: eid.id, display_name: eid.id, base_url: '', connected: false }
  })())

  /// 3. 否则保头(/ 或 ~)+ 从尾巴反向贪心保留**整段文件夹名**,中间用 …/ 占位
  /// 4. 兜底:实在塞不下就保留最后一段 + … 前缀
  function compressPath(p: string, maxLen: number): string {
    if (!p) return ''
    let s = p
    if (homeDir && (s === homeDir || s.startsWith(homeDir + '/'))) {
      s = '~' + s.slice(homeDir.length)
    }
    if (s.length <= maxLen) return s

    const segs = s.split('/')
    // 头部:绝对路径 → '',~ 路径 → '~'
    const head = segs[0]
    const tail = segs.slice(1).filter((x) => x.length > 0)
    if (tail.length === 0) return s

    // 反向贪心:从最后一段开始累加,直到放不下;中间填 …/
    // 最终形态:<head>/…/<tail-k>/.../<tail-1>
    const ELLIPSIS = '…'
    let kept: string[] = []
    let lenUsed = head.length + 1 /* '/' 分隔 */ + ELLIPSIS.length /* … 占位 */
    for (let i = tail.length - 1; i >= 0; i--) {
      const seg = tail[i]
      const extra = seg.length + 1 /* '/' */
      if (lenUsed + extra > maxLen && kept.length > 0) break
      kept.unshift(seg)
      lenUsed += extra
    }

    if (kept.length === 0) {
      // 最后一段都塞不下,兜底:… + 最后一段(可能仍超长,但最起码可读)
      return ELLIPSIS + '/' + tail[tail.length - 1]
    }
    return head + '/' + ELLIPSIS + '/' + kept.join('/')
  }

  function statusLabel(t: { exited?: number | null; status?: string; attention?: string | null }): {
    cls: 'starting' | 'idle' | 'busy' | 'attention' | 'exited'
    text: string
  } {
    // 已退出最优先
    if (t.exited != null || t.status === 'exited') {
      return { cls: 'exited', text: t.exited != null ? `exited ${t.exited}` : 'exited' }
    }
    // 等待用户操作覆盖 idle/busy(语义上"需要你");business 颜色用 attention
    if (t.attention) {
      return { cls: 'attention', text: t.attention === 'plan' ? 'plan' : 'awaiting answer' }
    }
    if (t.status === 'busy') return { cls: 'busy', text: 'running' }
    if (t.status === 'starting') return { cls: 'starting', text: 'starting' }
    return { cls: 'idle', text: 'idle' }
  }

  function avatarStatusForTabStatus(status: ReturnType<typeof statusLabel>['cls']): AvatarStatus {
    if (status === 'idle') return 'idle'
    if (status === 'attention') return 'awaiting'
    if (status === 'exited') return 'error'
    return 'running'
  }

  function hasAvatarFor(status: AvatarStatus): boolean {
    return ($avatarLibrary[status] ?? []).length > 0
  }

  // ============ 键盘 ============
  // Cmd+T = 弹后端选择、Cmd+W = 关 tab、Cmd+1..9 = 跳 tab、
  // Cmd+] / Cmd+[ = 下/上、Cmd+P = 命令面板、F2 = 重命名
  // Cmd+N = 新窗口
  // Cmd+Shift+D = 切换开发者细节显示

  // release 包禁用 devtools 快捷键(双保险 —— 主防线是 Cargo devtools feature
  // 不启用,WKWebView 不可 inspect;这里挡住 F12 / Cmd+Opt+I / Ctrl+Shift+I
  // 的浏览器默认行为,避免触发 Tauri 的 internal_toggle_devtools 命令)。
  // macOS 上 Option+I 会把 e.key 改写成 'ˆ' / 'Î' 等,必须用 e.code 判物理键。
  function onContextMenu(e: MouseEvent) {
    if (import.meta.env.DEV) return
    e.preventDefault()
  }

  function onKey(e: KeyboardEvent) {
    if (!import.meta.env.DEV) {
      // F12
      if (e.key === 'F12') { e.preventDefault(); return }
      // Cmd+Opt+I (macOS) / Ctrl+Shift+I (Win/Linux) —— 用 e.code 判物理键
      // 避免 macOS Option 改写 e.key 导致漏判。
      if (e.code === 'KeyI' && ((e.metaKey && e.altKey) || (e.ctrlKey && e.shiftKey))) {
        e.preventDefault(); return
      }
      // Cmd+Opt+J / Ctrl+Shift+J (Console)、Cmd+Opt+U / Ctrl+U (View Source) 顺手挡掉
      if (e.code === 'KeyJ' && ((e.metaKey && e.altKey) || (e.ctrlKey && e.shiftKey))) {
        e.preventDefault(); return
      }
      if (e.code === 'KeyU' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); return
      }
    }
    if (e.key === 'Escape') {
      if (pickerState) { pickerState = null; e.preventDefault(); return }
      if (paletteOpen) { paletteOpen = false; e.preventDefault(); return }
      if (renameOpen) { renameOpen = false; e.preventDefault(); return }
      if (memoryPanelOpen) { memoryPanelOpen = false; e.preventDefault(); return }
      if (workspacePanelOpen) { workspacePanelOpen = false; e.preventDefault(); return }
      if (memoryPromptPreviewText !== null) { memoryPromptPreviewText = null; e.preventDefault(); return }
      if (settingsOpen) { settingsOpen = false; e.preventDefault(); return }
      if (chooserOpen && $tabs.length > 0) {
        chooserOpen = false; e.preventDefault(); return
      }
    }
    if (e.key === 'F2' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      if ($activeTab) renameOpen = true
      return
    }
    if (!e.metaKey && !e.ctrlKey) return
    // 弹层（命令面板 / 重命名 / 选后端 / memory panel / deploy / endpoints / ...）打开时，
    // 只保留 Escape（上面已处理）；其余 Cmd/Ctrl 组合键一律不响应，
    // 让事件继续冒泡到弹层自己的 input，保证 Cmd+A / Cmd+C / Cmd+V / Cmd+Z 等在弹层内可用。
    if (anyModalOpen) return
    const k = e.key
    // 用 e.code 判断物理按键,避免 macOS Option 键改写 e.key(⌥S 会变成 'ß' 等)导致匹配失败
    if (e.code === 'KeyS' && !e.shiftKey) {
      e.preventDefault()
      // ⌥⌘S 强制切换 workspace(先关闭当前再重选);⌘S 维持聚焦/打开语义
      void openSpecOps(e.altKey)
    } else if (k === 't' || k === 'T') {
      e.preventDefault()
      chooserOpen = true
    } else if (k === 'w' || k === 'W') {
      const id = $activeId
      if (id != null) {
        e.preventDefault()
        closeTab(id)
      }
    } else if (k === 'n' || k === 'N') {
      e.preventDefault()
      ipc.openNewWindow().catch((err) => console.error('open_new_window failed:', err))
    } else if (k === ']') {
      e.preventDefault()
      const arr = $tabs
      const idx = arr.findIndex((t) => t.id === $activeId)
      if (idx >= 0 && arr.length > 1) selectTab(arr[(idx + 1) % arr.length].id)
    } else if (k === '[') {
      e.preventDefault()
      const arr = $tabs
      const idx = arr.findIndex((t) => t.id === $activeId)
      if (idx >= 0 && arr.length > 1)
        selectTab(arr[(idx - 1 + arr.length) % arr.length].id)
    } else if (/^[1-9]$/.test(k)) {
      e.preventDefault()
      const n = Number(k) - 1
      const t = $tabs[n]
      if (t) selectTab(t.id)
    } else if (k === 'p' || k === 'P') {
      e.preventDefault()
      paletteOpen = true
    } else if (k === ',') {
      // ⌘,:打开 Settings 面板(backend 开关 / memory 配置聚合)
      e.preventDefault()
      settingsOpen = true
    } else if ((k === 'd' || k === 'D') && e.shiftKey) {
      e.preventDefault()
      showDevInfo = !showDevInfo
    } else if ((k === 'm' || k === 'M') && e.shiftKey) {
      // ⌘⇧M:打开 memory review queue 面板。Shift 必带,避免与子进程
      // ⌘M(macOS minimize)冲突 —— minimize 在 WKWebView 里走系统菜单,
      // 这里加 Shift 后我们独占,系统菜单不再触发。
      e.preventDefault()
      memoryPanelOpen = !memoryPanelOpen
    } else if ((k === 'b' || k === 'B') && e.shiftKey) {
      // ⌘⇧B:打开 memory browse 面板(已 approve 池)。
      e.preventDefault()
      memoryBrowseOpen = !memoryBrowseOpen
    } else if (k === 'b' || k === 'B') {
      // ⌘B / Ctrl+B:三态循环侧栏(full → compact → hidden → full)。
      // 跟 macOS 系应用语义对齐(VS Code、Mail、Notion);hidden 下仍可触发因为
      // <svelte:window onkeydown> 不依赖 sidebar DOM。
      e.preventDefault()
      cycleSidebar()
    } else if (k === ',') {
      e.preventDefault()
      pathsOpen = !pathsOpen
    }

    // ── 兜底:对所有未被上面明确处理的 Cmd/Ctrl 组合键，在终端激活且无弹层时
    //    统一调用 preventDefault()。
    //
    //    原因:WKWebView 会对收到的 Cmd/Ctrl 快捷键执行平台级默认行为:
    //      - Cmd+Z / Cmd+Y → undo/redo:WKWebView 的 undo-manager 会找到
    //        最近编辑过的 <input> 并重新聚焦它 → 焦点跳到输入框
    //      - Cmd+A → SelectAll:可能聚焦某个文本节点
    //      - Cmd+F → 触发 WebKit 内建 find-bar
    //      - 其他未定义快捷键 → 行为不可预测
    //
    //    不影响 xterm 的 copy/paste:xterm 通过 clipboard API 与 paste 事件
    //    处理复制粘贴,两者依赖 copy/paste 事件而非 keydown 的浏览器默认动作,
    //    所以 preventDefault() 不会破坏终端内的剪贴板操作。
    //
    //    $activeId != null → 只在有激活 tab 时阻断,欢迎页/BackendChooser 阶段
    //    仍允许浏览器默认(Cmd+Z 撤销 cwd 输入框内容等场景正常工作)。
    //    弹层打开时也不阻断(anyModalOpen) —— 否则 Cmd+V 粘贴、Cmd+A 全选
    //    在 DeployPanel/EndpointDialog 等弹层里失效。
    //
    //    可编辑元素(<input>/<textarea>/contenteditable)里也不阻断 —— 否则
    //    非弹层的输入框(如 shell 终端的字体输入框)里 Cmd+C / Cmd+V / Cmd+A
    //    等编辑快捷键的浏览器默认行为会被杀掉,无法复制粘贴。
    //    与 anyModalOpen 同理:让浏览器原生处理这些编辑动作。
    const target = e.target as HTMLElement | null
    const isEditable = !!target && (
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
    )
    if ($activeId != null && !anyModalOpen && !isEditable) {
      e.preventDefault()
    }
  }

  // ============ Command Palette ============
  let commands: Command[] = $derived.by(() => {
    void $currentLocale
    return [
    // ── Tab ──
    {
      id: 'close-tab',
      label: t('command.tab.close'),
      detail: '⌘W',
      group: 'tab',
      run: () => {
        if ($activeId != null) closeTab($activeId)
      },
    },
    {
      id: 'rename-tab',
      label: t('command.tab.rename'),
      detail: 'F2',
      group: 'tab',
      run: () => {
        if ($activeTab) renameOpen = true
      },
    },
    {
      id: 'new-window',
      label: t('command.tab.newWindow'),
      detail: '⌘N',
      group: 'tab',
      run: () => {
        ipc.openNewWindow().catch((e) => console.error(e))
      },
    },
    // ── View ──
    {
      id: 'paths-config',
      label: pathsOpen ? t('command.view.hidePaths') : t('command.view.showPaths'),
      group: 'view',
      run: () => { pathsOpen = !pathsOpen },
    },
    {
      id: 'toggle-sidebar',
      label: t('command.view.sidebar', { mode: sidebarMode }),
      detail: '⌘B',
      group: 'view',
      run: () => cycleSidebar(),
      cycle: { prev: () => cycleSidebarPrev(), next: () => cycleSidebar() },
    },
    {
      id: 'cycle-theme',
      label: t('command.view.theme', { theme }),
      group: 'view',
      run: () => cycleTheme(),
      cycle: { prev: () => cycleThemePrev(), next: () => cycleTheme() },
    },
    {
      id: 'toggle-workspace-panel',
      label: workspacePanelOpen ? t('command.view.hideWorkspace') : t('command.view.showWorkspace'),
      group: 'view',
      run: () => { workspacePanelOpen = !workspacePanelOpen },
    },
    // ── Memory ──
    {
      id: 'memory-review',
      label: totalMemoryPendingCount > 0
        ? t('command.memory.reviewPending', { count: totalMemoryPendingCount })
        : t('command.memory.review'),
      detail: '⌘⇧M',
      group: 'memory',
      run: () => { memoryPanelOpen = true },
    },
    {
      id: 'memory-sync',
      label: t('command.memory.sync'),
      group: 'memory',
      run: () => { memorySyncOpen = true },
    },
    {
      id: 'memory-browse',
      label: t('command.memory.browse'),
      detail: '⌘⇧B',
      group: 'memory',
      run: () => { memoryBrowseOpen = true },
    },
    {
      id: 'memory-scope-switch',
      label: t('command.memory.switchScope', { scope: memoryScope || 'auto' }),
      group: 'memory',
      run: async () => {
        memoryBrowseOpen = true
      },
    },
    {
      id: 'memory-mcp-setup',
      label: t('command.memory.mcpSetup'),
      group: 'memory',
      run: () => memoryMcpBannerRef?.show(),
    },
    {
      id: 'memory-prompt-preview',
      label: memoryPromptEnabled
        ? t('command.memory.promptPreview', { bytes: memoryPromptBytes })
        : t('command.memory.promptPreviewDisabled'),
      group: 'memory',
      run: () => openPromptPreview(),
    },
    {
      id: 'memory-prompt-toggle',
      label: memoryPromptEnabled
        ? t('command.memory.promptDisable')
        : t('command.memory.promptEnable'),
      group: 'memory',
      run: () => togglePromptEnabled(),
    },
    // ── Remote ──
    {
      id: 'endpoints-manage',
      label: t('command.remote.endpoints'),
      group: 'remote',
      run: () => { endpointsOpen = true },
    },
    {
      id: 'deploy-remote-bridge',
      label: t('command.remote.deployBridge'),
      group: 'remote',
      run: () => { deployOpen = true },
    },
    // ── Other ──
    {
      id: 'open-settings',
      label: t('command.other.settings'),
      detail: '⌘,',
      group: 'other',
      run: () => { settingsOpen = true },
    },
    {
      id: 'specops-open',
      label: specopsSession ? t('command.other.openSpecOpsWindow') : t('command.other.openSpecOpsConsole'),
      detail: '⌘S',
      group: 'other',
      run: () => { void openSpecOps() },
    },
    {
      id: 'pair-mobile',
      label: t('command.other.pairMobile'),
      group: 'other',
      run: () => { pairingOpen = true },
    },
    ]
  })

  async function doRestore() {
    const list = restorable
    restorable = [] // 先清,避免重复点
    const ok = await restoreTabs(list)
    if (ok < list.length) {
      console.warn(`restore ${ok}/${list.length} succeeded`)
    }
  }

  // ============ 同步系统窗口标题 ============
  // 标题格式: "<序号>. <active tab title>";没有 active tab 时回落到品牌名。
  // active tab 由 (tabs, activeId) 共同决定 — 任一变化都需要刷新。
  const appWindow = getCurrentWindow()
  const topbarTitle = $derived($activeTab ? $activeTab.title : 'Kill la Code')

  // 标题栏拖拽:`data-tauri-drag-region` 不会冒泡到子元素(Tauri 设计行为,
  // 保护按钮/input),所以手动监听 mousedown:左键单击 startDragging,双击 toggleMaximize
  // (对齐 macOS 标题栏行为)。跳过按钮等交互元素。
  function onTitlebarMouseDown(e: MouseEvent) {
    if (e.button !== 0) return
    const t = e.target as HTMLElement | null
    if (t?.closest('button, input, a, [role="button"], select, textarea, .no-drag')) return
    e.preventDefault()
    const act = e.detail === 2 ? appWindow.toggleMaximize() : appWindow.startDragging()
    act.catch((err) => console.error('titlebar drag/toggle failed:', err))
  }

  $effect(() => {
    const arr = $tabs
    const id = $activeId
    const idx = arr.findIndex((t) => t.id === id)
    const next = idx >= 0
      ? `${idx + 1}. ${arr[idx].title}`
      : 'Kill la Code'
    appWindow.setTitle(next).catch((e) => console.error('setTitle failed:', e))
  })
</script>

{#snippet tabRow(t: TabInfo, i: number)}
  {@const avatarStatus = avatarStatusForTabStatus(statusLabel(t).cls)}
  {@const bc = backendChip(t.backendKey)}
  {@const customAvatar = t.avatarId != null}
  <div
    class="tab"
    class:active={t.id === $activeId}
    class:has-unread={t.unread}
    class:needs-attention={t.attention != null}
    class:dragging={dragging}
    class:editing={editingId === t.id}
    data-attention={t.attention ?? ''}
    role="button"
    tabindex="0"
    aria-current={t.id === $activeId ? 'true' : undefined}
    title={`${i + 1}. ${t.title} · ${shortModelName(t.model)}`}
    onclick={() => { selectTab(t.id); if (menuOpenId !== null) closeMenu() }}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTab(t.id) } }}
    oncontextmenu={(e) => onTabContext(e, t.id)}
  >
    <div class="tab-rail">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="avatar-wrap"
        data-backend={bc.cls}
        style={`--tab-tint:${bc.tint || 'transparent'}`}
        oncontextmenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          openAvatarPicker(t.id, t.avatarId ?? null, e.currentTarget.getBoundingClientRect())
        }}
      >
        <AvatarSprite
          label={`${t.title} avatar`}
          compact={sidebarMode === 'compact'}
          status={avatarStatus}
          avatarId={t.avatarId ?? null}
          backendKey={t.backendKey}
        />
        <button
          class="avatar-edit-btn"
          title="Choose avatar"
          aria-label="Choose avatar"
          onclick={(e) => {
            e.stopPropagation()
            openAvatarPicker(t.id, t.avatarId ?? null, e.currentTarget.getBoundingClientRect())
          }}
        >
          <Icon name="pencil" size={10} />
        </button>
        {#if sidebarMode === 'compact'}
          <span class="tile-idx" title={`#${i + 1}`}>{modelAbbr(t.model)}</span>
          {#if t.attention === 'ask'}
            <span class="tile-badge attention-ask" title={tr('tab.attention.ask')}>?</span>
          {:else if t.attention === 'plan'}
            <span class="tile-badge attention-plan" title={tr('tab.attention.plan')}>!</span>
          {:else if t.unread}
            <span class="tile-badge unread" aria-label="unread"></span>
          {/if}
        {/if}
      </div>
    </div>
    <!-- compact 模式专用 overlay 已移除:idx 和 attention/unread 现在直接
         作为 .avatar-wrap(tile)的子元素,覆盖在 icon 像素上,类似 iOS app
         icon 的通知 badge。tab 高度因此可以从 58px 压缩到 52px。 -->
    <div class="tab-body">
      <div class="tab-title-row">
        <span class="tab-index">{i + 1}.</span>
        {#if editingId === t.id}
          <input
            class="tab-title-input"
            value={editValue}
            bind:this={renameInputEl}
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') { e.preventDefault(); commitRename(t.id) }
              else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
            }}
            onblur={() => commitRename(t.id)}
            oninput={(e) => (editValue = e.currentTarget.value)}
          />
        {:else}
          <span
            class="tab-title"
            role="button"
            tabindex="-1"
            aria-label={tr('tab.action.doubleClickRename')}
            ondblclick={(e) => { e.stopPropagation(); startRename(t.id, t.title) }}
          >{t.title}</span>
        {/if}
        {#if t.attention === 'ask'}
          <span class="attention-badge attention-ask" title={tr('tab.attention.ask')}>?</span>
        {:else if t.attention === 'plan'}
          <span class="attention-badge attention-plan" title={tr('tab.attention.plan')}>!</span>
        {:else if t.unread}
          <span class="unread-dot" aria-label="unread"></span>
        {/if}
      </div>
      <div class="tab-meta">
        {#if customAvatar}
          <!-- 头像已选(动画 avatar)→ 原位置显示 backend icon,不再显示 backend 文案 -->
          <span class="chip chip-backend-icon {bc.cls}" title={`backend: ${t.backendKey}`}>
            <BackendIcon backendKey={t.backendKey} size={12} />
          </span>
        {/if}
        <span class="chip chip-model" title={t.model}>{compactModelName(t.model)}</span>
        {#if t.tokens != null}
          <span class="chip chip-tokens" title={`${t.tokens} tokens`}>{formatTokens(t.tokens)} tok</span>
        {/if}
        {#if t.exited != null}
          <span class="exited-tag">exit {t.exited}</span>
        {/if}
      </div>
    </div>
    <div class="close-mask" aria-hidden="true"></div>
    <button
      class="more-btn"
      title={tr('tab.action.moreActions')}
      aria-label={tr('tab.action.moreActions')}
      aria-haspopup="menu"
      aria-expanded={menuOpenId === t.id}
      onclick={(e) => { e.stopPropagation(); toggleMenu(t.id, e.currentTarget as HTMLElement) }}
    >
      <Icon name="more-horizontal" size={14} />
    </button>
    {#if menuOpenId === t.id}
      <div class="tab-menu" role="menu" style={menuStyle}>
        <button
          role="menuitem"
          onclick={(e) => { e.stopPropagation(); startRename(t.id, t.title) }}
        >
          <Icon name="pencil" size={13} /> {tr('tab.menu.rename')}
        </button>
        <button
          role="menuitem"
          onclick={(e) => { e.stopPropagation(); duplicateTab(t.id); closeMenu() }}
        >
          <Icon name="copy" size={13} /> {tr('tab.menu.duplicate')}
        </button>
        {#if t.sessionId}
          <button
            role="menuitem"
            onclick={(e) => { e.stopPropagation(); restoreTab(t.id); closeMenu() }}
          >
            <Icon name="refresh-cw" size={13} /> {tr('tab.menu.restore')}
          </button>
        {/if}
        <div class="menu-sep"></div>
        <button
          role="menuitem"
          class="danger"
          onclick={(e) => { e.stopPropagation(); requestCloseTab(t.id, t.title); closeMenu() }}
        >
          <Icon name="x" size={13} /> {tr('tab.menu.close')}
        </button>
      </div>
    {/if}
    <button
      class="close-btn"
      title={tr('tab.action.closeTabTooltip')}
      aria-label={tr('tab.action.closeTab')}
      onclick={(e) => { e.stopPropagation(); requestCloseTab(t.id, t.title) }}
    >
      <Icon name="x" size={12} />
    </button>
  </div>
{/snippet}

<svelte:window onkeydown={onKey} oncontextmenu={onContextMenu} onmessage={onSpecOpsMessage} onclick={onGlobalClick} />

<div
  class="root"
  class:sb-compact={sidebarMode === 'compact'}
  class:sb-hidden={sidebarMode === 'hidden'}
  class:inspector-open={workspacePanelOpen}
  class:inspector-resizing={inspectorResizing}
  style={workspacePanelOpen ? `--inspector-w:${inspectorWidth}px` : ''}
>
  <div class="top-chrome-continuity" aria-hidden="true"></div>
  <aside class="sidebar" class:compact={sidebarMode === 'compact'}>
    <!-- 系统原生红绿灯(titleBarStyle: Overlay)落在这条顶栏左上角;整条 drag region。
         我们不再自绘按钮,只用 padding-left 给原生红绿灯让出位置(见 .sidebar-traffic)。 -->
    <div class="sidebar-traffic" data-tauri-drag-region onmousedown={onTitlebarMouseDown}>
      <div class="brand-text">
        <span class="brand-name">Kill la Code</span>
        <span class="brand-sub">Don't write your code.</span>
      </div>
      <button
        class="icon-btn"
        title={tr('tab.action.newTabTooltip')}
        aria-label={tr('tab.action.newTab')}
        onclick={() => (chooserOpen = true)}
      >
        <Icon name="plus" size={16} />
      </button>
    </div>

    <!-- tab-list 是滚动容器;onclick 处理空白处点击关闭侧栏。
         dndzone 已下沉到每个 .ws-group-tabs(每组独立,禁止跨 workspace 拖拽)。 -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="tab-list"
      role="toolbar"
      aria-label="Tabs"
      tabindex="-1"
      onscroll={closeMenu}
    >
      {#if bootError}
        <div class="boot-error">启动失败<br />{bootError}</div>
      {:else if $tabs.length === 0}
        <div class="placeholder">No sessions</div>
      {:else}
        <!-- 多 workspace 且非 compact:渲染可折叠的分组 header + 每组独立 dndzone。
             单 workspace / compact:跳过 header,直接堆叠各组 tab(语义不变)。
             compact 多 workspace:组间加 1px 细分隔线(VS Code/Slack 式),不占横向空间。
             外层 .ws-list 挂 workspace 级 dndzone(type: 'workspace-group'),dragHandle
             指向 .ws-group-header —— 只有 header 可拖,tab 内容不误触。
             非 grouped 模式下 .ws-group-header 不渲染,dndzone 自然无法触发,安全。 -->
        {@const useGroupedLayout = wsGrouped && sidebarMode !== 'compact'}
        <div
          class="ws-list"
          use:dragHandleZone={{ items: wsShadows, type: 'workspace-group', delayTouchStart: TAB_DRAG_LONG_PRESS_MS }}
          use:longpressGate
          onconsider={onWsDndConsider}
          onfinalize={onWsDndFinalize}
        >
          {#each wsShadows as group, gi (group.id)}
            <div class="ws-group" class:dragging={dragging} data-cwd={group.cwd} data-group-id={group.id}>
              {#if useGroupedLayout}
                <button
                  type="button"
                  class="ws-group-header"
                  class:collapsed={collapsedCwds.has(group.id)}
                  class:remote={group.endpointKind === 'remote'}
                  class:local={group.endpointKind === 'local'}
                  title={group.fullPath}
                  aria-expanded={!collapsedCwds.has(group.id)}
                  onclick={(e) => onWorkspaceHeaderClick(e, group.id)}
                  use:dragHandle
                >
                  <span class="ws-grip" aria-hidden="true"><Icon name="grip-vertical" size={14} /></span>
                  <span class="ws-chevron">
                    <Icon name={collapsedCwds.has(group.id) ? 'chevron-right' : 'chevron-down'} size={12} />
                  </span>
                  <span class="ws-icon" class:remote={group.endpointKind === 'remote'} class:local={group.endpointKind === 'local'}>
                    <Icon name={group.endpointKind === 'remote' ? 'folder-open' : 'folder'} size={13} />
                  </span>
                  <span class="ws-title">
                    <span class="ws-name">{group.name}</span>
                    {#if group.showPathHint}
                      <span class="ws-path">{group.pathHint}</span>
                    {/if}
                  </span>
                  <span class="ws-count">{group.tabs.length}</span>
                </button>
              {:else if wsGrouped && gi > 0}
                <!-- compact 多 workspace:组间细分隔线 -->
                <div class="ws-group-separator" aria-hidden="true"></div>
              {/if}
              {#if !useGroupedLayout || !collapsedCwds.has(group.id)}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  class="ws-group-tabs"
                  data-cwd={group.cwd}
                  data-group-id={group.id}
                  use:dndzone={{ items: groupShadows[group.id] ?? group.tabs, type: `ws-tab:${group.id}`, delayTouchStart: TAB_DRAG_LONG_PRESS_MS }}
                  use:longpressGate
                  onconsider={onDndConsider}
                  onfinalize={onDndFinalize}
                >
                  {#each (groupShadows[group.id] ?? group.tabs) as t (t.id)}
                    {@const i = wsGlobalIdx.get(t.id) ?? 0}
                    {@render tabRow(t, i)}
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </aside>

  <main class="main" class:drag-over={dragOver} ondragover={onMainDragOver} ondragleave={onMainDragLeave}>
    <!-- 拖拽中覆盖终端区:捕获 drop 事件,防止 xterm.js 消费 -->
    {#if dragOver}
      <div class="drag-overlay" ondragover={(e) => e.preventDefault()} ondrop={onOverlayDrop} ondragleave={() => { dragOver = false }}></div>
    {/if}
    <!-- 浮在终端区顶部的单条标题栏(与左侧红绿灯条同高 44px,同一水平线):
         hidden 时左侧补红绿灯 + 新建;中间居中蓝色标题/副标题;右侧 inspector 开关。 -->
    <header class="main-titlebar" class:sidebar-hidden={sidebarMode === 'hidden'} data-tauri-drag-region onmousedown={onTitlebarMouseDown}>
      {#if sidebarMode === 'hidden'}
        <!-- hidden 模式下 sidebar 收起,系统原生红绿灯落在这条 titlebar 左上角;
             用 .main-titlebar.sidebar-hidden 的 padding-left 让位,这里只补「新建」按钮。 -->
        <button
          class="icon-btn hidden-fallback-add"
          title={tr('tab.action.newTabTooltip')}
          aria-label={tr('tab.action.newTab')}
          onclick={() => (chooserOpen = true)}
        >
          <Icon name="plus" size={16} />
        </button>
      {/if}
      <div class="main-title-center" data-tauri-drag-region>
        <strong>{topbarTitle}</strong>
      </div>
      <div class="titlebar-actions">
        <EventCenter />
        <!-- 打开 inspector 的按钮只在关闭时显示;收起由右边栏顶部那一排的关闭按钮负责 -->
        {#if !workspacePanelOpen}
          <button
            class="titlebar-tool"
            title="Show workspace inspector"
            aria-label="Show workspace inspector"
            aria-pressed="false"
            onclick={() => (workspacePanelOpen = true)}
          >
            <Icon name="panel-right" size={15} />
          </button>
        {/if}
      </div>
    </header>
    <!-- M4.1:memory MCP 引导横幅。后端只在 (二进制+codebuddy 都齐 且未配置 且未 dismiss) 时
         才让前端显示;其它分支(binary 缺 / cli 缺)也会显示但文案不同。一直挂在 main 顶部
         不依赖任何条件,因为内部自己控制 visible。
         必须用 paths-floating(absolute + z-index 6)模式 —— 否则会被
         .term-wrapper(absolute inset:0)整个盖住,banner 看得见但点击被拦截。
         bind:this 让命令面板的"重新检测/配置"项能 forceShow banner。 -->
    <div class="memory-mcp-floating">
      <MemoryMcpBanner bind:this={memoryMcpBannerRef} />
    </div>
    {#if pathsOpen && ($tabs.length === 0 || chooserOpen)}
      <!-- 顶部 banner 仅在 welcome / chooser 时常驻;有 tab 后 term 区会全屏覆盖,
           用户可用 ⌘, 或命令面板再次打开。 -->
      <PathsBanner
        onClose={() => (pathsOpen = false)}
        {theme}
        onThemeChange={setTheme}
      />
    {/if}
    {#if pathsOpen && $tabs.length > 0 && !chooserOpen}
      <!-- 有 tab 且 banner 仍显式打开 → 浮在 main 区顶部,不挡住 term 太多 -->
      <div class="paths-floating">
        <PathsBanner
          onClose={() => (pathsOpen = false)}
          {theme}
          onThemeChange={setTheme}
        />
      </div>
    {/if}
    {#if $activeTab?.attention}
      <!-- 当前 tab 仍需要用户操作 — 顶部 banner 半透明常驻,sidebar 才是主要视觉焦点 -->
      <div class="attention-banner attention-banner-{$activeTab.attention}" role="status">
        <span class="attention-banner-icon">
          {$activeTab.attention === 'plan' ? '!' : '?'}
        </span>
        <div class="attention-banner-text">
          {#if $activeTab.attention === 'ask'}
            <strong>{tr('attention.banner.ask')}</strong>
            <span>{tr('attention.banner.askHint')}</span>
          {:else}
            <strong>{tr('attention.banner.plan')}</strong>
            <span>{tr('attention.banner.planHint')}</span>
          {/if}
        </div>
      </div>
    {/if}
    {#if bootError}
      <div class="main-error">
        <strong>Boot failed</strong>
        <pre>{bootError}</pre>
      </div>
    {:else if restorable.length > 0 && $tabs.length === 0 && !chooserOpen}
      <div class="restore-banner">
        <div class="restore-text">
          <strong>Restore last session?</strong>
          <span>{restorable.length} tab{restorable.length === 1 ? '' : 's'} from previous run</span>
        </div>
        <div class="restore-actions">
          <button class="btn-primary" onclick={doRestore}>Restore all</button>
          <button class="btn-ghost" onclick={() => (restorable = [])}>Dismiss</button>
        </div>
      </div>
    {:else if $tabs.length === 0 || chooserOpen}
      <BackendChooser
        {backends}
        onSubmit={async (opts) => {
          chooserOpen = false
          try {
            await newTab(opts.backendKey, {
              cwd: opts.cwd,
              permissionMode: opts.permissionMode,
              model: opts.model,
              endpointId: opts.endpointId,
              resumeSessionId: opts.resumeSessionId ?? null,
            })
          } catch (e) {
            console.error(e)
            bootError = String(e)
          }
        }}
      />
    {/if}
    {#each $mountedIds as id (id)}
      {@const isActive = id === $activeId && !chooserOpen}
      {@const tab = $tabs.find((t) => t.id === id)}
      <!-- inert 兜底:visibility:hidden 仍可能被 Tab 键焦点穿透,inert 完全屏蔽
           子树的焦点 / 辅助技术,确保隐藏 tab 的 xterm textarea 不会误吃键盘输入。 -->
      <div class="term-wrapper" class:visible={isActive} inert={!isActive}>
        <Terminal
          sessionId={id}
          visible={isActive}
          isDark={theme === 'dark' || (theme === 'system' && systemPrefersDark)}
          endpointId={tab?.endpointId}
        />
      </div>
    {/each}
  </main>

  <!-- 常驻渲染(不再 {#if} 挂载/卸载),让 grid 列宽过渡可以平滑展开/收起;
       关闭时列宽→0 + overflow:hidden 把内容裁掉,只在打开时才真正构建面板内容。 -->
  <div class="inspector-shell" class:open={workspacePanelOpen} aria-hidden={!workspacePanelOpen}>
    {#if workspacePanelOpen}
      <!-- 左缘可左右拖拽调宽的把手(带上下限) -->
      <div
        class="inspector-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workspace inspector"
        title="Drag to resize"
        onpointerdown={startInspectorResize}
        ondblclick={() => (inspectorWidth = 420)}
      ></div>
      <div class="inspector-content">
        <div class="inspector-workspace">
          <WorkspacePanel
            tab={$activeTab}
            {homeDir}
            onClose={() => { workspacePanelOpen = false }}
            terminalOpen={terminalPanelOpen}
            onToggleTerminal={toggleTerminalPanel}
          />
        </div>
        {#if terminalPanelOpen}
          <div
            class="terminal-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize terminal panel"
            title="Drag to resize"
            onpointerdown={startTerminalResize}
            ondblclick={() => (terminalHeight = 280)}
          ></div>
          <div class="inspector-terminal" style="height: {terminalHeight}px">
            <ShellTerminalPanel
              tab={$activeTab}
              isDark={theme === 'dark' || (theme === 'system' && systemPrefersDark)}
              onClose={() => (terminalPanelOpen = false)}
              ensureTerminalToken={terminalEnsureToken}
            />
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <footer class="status">
    <span class="status-left">
      {#if $activeTab}
        {@const s = statusLabel($activeTab)}
        <span class="status-dot dot-{s.cls}"></span>
        <span class="status-text">{s.text}</span>
        <span class="dot-sep">·</span>
        <span class="model">{shortModelName($activeTab.model)}</span>

        {#if $activeTab.inputTokens != null}
          <span class="dot-sep">·</span>
          <span class="tok-in">
            ↓ {formatTokens($activeTab.inputTokens)} in
            {#if $activeTab.cachedTokens}
              <span class="cached"> ({formatTokens($activeTab.cachedTokens)} cached)</span>
            {/if}
          </span>
        {/if}
        {#if $activeTab.outputTokens != null}
          <span class="tok-out">↑ {formatTokens($activeTab.outputTokens)} out</span>
        {/if}

        {#if $activeTab.costUsd != null}
          <span class="dot-sep">·</span>
          <span class="cost">${$activeTab.costUsd.toFixed(2)}</span>
        {/if}
      {:else}
        <span class="status-text muted">No active session</span>
      {/if}
    </span>
    <span class="status-right">
      {#if totalMemoryPendingCount > 0}
        <div
          class="mem-badge-wrap"
          onmouseenter={() => {
            if (memoryHoverTimer != null) window.clearTimeout(memoryHoverTimer)
            memoryHoverTimer = window.setTimeout(() => (memoryHoverVisible = true), 300)
          }}
          onmouseleave={() => {
            if (memoryHoverTimer != null) {
              window.clearTimeout(memoryHoverTimer)
              memoryHoverTimer = null
            }
            memoryHoverVisible = false
          }}
          role="presentation"
        >
          <button
            class="mem-badge"
            title="Memory review queue ({totalMemoryPendingCount} pending) — ⌘⇧M"
            aria-label="Open memory review"
            onclick={() => (memoryPanelOpen = true)}
          >
            <Icon name="brain" /> {totalMemoryPendingCount}
          </button>
          <MetricsHoverCard visible={memoryHoverVisible} />
        </div>
      {:else}
        <!-- 无 pending 时也允许 hover 看 metrics(但不渲染数字徽章 — 避免空徽章) -->
        <div
          class="mem-badge-wrap quiet"
          onmouseenter={() => {
            if (memoryHoverTimer != null) window.clearTimeout(memoryHoverTimer)
            memoryHoverTimer = window.setTimeout(() => (memoryHoverVisible = true), 300)
          }}
          onmouseleave={() => {
            if (memoryHoverTimer != null) {
              window.clearTimeout(memoryHoverTimer)
              memoryHoverTimer = null
            }
            memoryHoverVisible = false
          }}
          role="presentation"
        >
          <button
            class="mem-badge dim"
            title="Memory metrics — hover for stats, ⌘⇧M to review, ⌘⇧B to browse"
            aria-label="Memory metrics"
            onclick={() => (memoryBrowseOpen = true)}
          >
            <Icon name="brain" />
          </button>
          <MetricsHoverCard visible={memoryHoverVisible} />
        </div>
      {/if}
      {#if showDevInfo}
        <span class="dev-info">{$tabs.length} tab · {$mountedIds.length} mounted · v0.2-dev</span>
      {/if}
      {#if activeRemoteEndpoint}
        <!-- Phase 11.6:远端连接指示 -->
        <button
          class="remote-indicator"
          class:connected={activeRemoteEndpoint.connected}
          onclick={() => (endpointsOpen = true)}
          title="{activeRemoteEndpoint.connected ? '已连接' : '未连接'} · 点击管理 endpoints"
          aria-label="Remote endpoint: {activeRemoteEndpoint.display_name}"
        >
          <span class="remote-dot" class:on={activeRemoteEndpoint.connected}></span>
          <span class="remote-name">{activeRemoteEndpoint.display_name}</span>
        </button>
      {/if}
      {#if $activeTab?.cwd}
        <span class="cwd-path" title={$activeTab.cwd}>{compressPath($activeTab.cwd, 48)}</span>
      {/if}
    </span>
  </footer>
</div>

{#if pickerState}
  <AvatarPicker
    backendKey={pickerState.tabBackendKey}
    currentAvatarId={pickerState.avatarId}
    anchorRect={pickerState.rect}
    onPick={(id) => {
      const id_ = pickerState?.tabId
      if (id_ == null) return
      setTabAvatar(id_, id)
      pickerState = null
    }}
    onClose={closeAvatarPicker}
  />
{/if}

{#if paletteOpen}
  <CommandPalette {commands} onClose={() => (paletteOpen = false)} />
{/if}

{#if settingsOpen}
  <SettingsPanel
    onClose={() => (settingsOpen = false)}
    onOpenMemorySync={() => { memorySyncOpen = true }}
    {locale}
    onLocaleChange={setLocale}
  />
{/if}

{#if deployOpen}
  <DeployPanel
    onClose={() => (deployOpen = false)}
    onDeployed={onDeployCompleted}
  />
{/if}

{#if pairingOpen}
  <PairingDialog onClose={() => (pairingOpen = false)} />
{/if}

{#if endpointsOpen}
  <EndpointDialog onClose={async () => {
    endpointsOpen = false
    try { endpoints = await endpointIpc.list() } catch {}
  }} />
{/if}

{#if renameOpen && $activeTab}
  <RenameDialog
    initial={$activeTab.title}
    onClose={() => (renameOpen = false)}
    onSubmit={async (next) => {
      const id = $activeId
      renameOpen = false
      if (id == null) return
      const tab = $activeTab
      renameTab(id, next)
      try {
        if (!tab?.endpointId || tab.endpointId.kind === 'local') {
          await ipc.setTitle(id, next)
        }
      } catch (e) {
        console.error(e)
      }
    }}
  />
{/if}

{#if closeConfirm}
  <ConfirmDialog
    title={tr('tab.closeConfirm.title')}
    message={tr('tab.closeConfirm.message')}
    confirmLabel={tr('tab.closeConfirm.confirm')}
    cancelLabel={tr('tab.closeConfirm.cancel')}
    danger
    onConfirm={confirmCloseTab}
    onClose={cancelCloseTab}
  />
{/if}

{#if memoryPanelOpen}
  <MemoryPanel onClose={() => (memoryPanelOpen = false)} />
{/if}

{#if memorySyncOpen}
  <MemorySyncPanel onClose={() => (memorySyncOpen = false)} />
{/if}

{#if memoryBrowseOpen}
  <MemoryBrowsePanel
    onClose={() => (memoryBrowseOpen = false)}
    defaultScope={memoryScope}
    initialFilter={memoryBrowseFilter ?? undefined}
    onFilterChange={(f) => {
      memoryBrowseFilter = f
      // best-effort 写盘;失败不阻塞 UI
      memoryIpc.browseStateSet(f).catch(() => {})
    }}
  />
{/if}

<!-- M4.2 Memory Prompt 预览 dialog —— 命令面板触发,简单只读展示 + Esc 关 -->
{#if memoryPromptPreviewText !== null}
  <div
    class="prompt-preview-backdrop"
    use:outsidePressClose={{ onClose: () => (memoryPromptPreviewText = null) }}
    role="presentation"
  >
    <div
      class="prompt-preview-dialog"
      role="dialog"
      aria-label="kode-memory prompt 预览"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      tabindex="-1"
    >
      <header>
        <strong>kode-memory 注入预览</strong>
        <span class="meta">
          {#if memoryPromptEnabled}
            <Icon name="check" /> 启用中
          {:else}
            <Icon name="x" /> 已禁用
          {/if}
          · {memoryPromptBytes} B · 下次新建 tab 生效
        </span>
        <button onclick={() => (memoryPromptPreviewText = null)} aria-label="close">×</button>
      </header>
      <pre class="content">{memoryPromptPreviewText}</pre>
    </div>
  </div>
{/if}

{#if specopsError}
  <div class="specops-error" role="alert">
    <strong>SpecOps could not start</strong>
    <span>{specopsError}</span>
    <button type="button" onclick={() => (specopsError = null)}>Dismiss</button>
  </div>
{/if}

<!-- 全局 toast 通知:固定在右下角,session 退出 / turn_finished 等场景提示 -->
<ToastHost />

<!-- 文件拖入窗口时的高亮遮罩(覆盖整个窗口:sidebar + 终端 + inspector) -->
{#if dragOver}
  <div class="drag-drop-overlay" aria-hidden="true">
    <span>松开以插入 @path 到当前会话</span>
  </div>
{/if}

<style>
  .root {
    position: relative;
    display: grid;
    grid-template-columns: var(--sidebar-w, 260px) minmax(0, 1fr) var(--inspector-w, 0px);
    grid-template-rows: minmax(0, 1fr) 28px;
    height: 100vh;
    min-height: 0;
    /* 透明窗口(tauri transparent:true)下,圆角靠 .root 自己画 + overflow 裁切。
       macOS 标准窗口圆角 ~10px。 */
    border-radius: 10px;
    overflow: hidden;
    background: var(--bg-base);
    color: var(--fg-primary);
    font-family: var(--font-ui);
    font-size: var(--fs-md);
    /* 左右栏展开/收起:列宽过渡(180ms)给出顺滑的滑入滑出动画 */
    transition: grid-template-columns 180ms cubic-bezier(0.2, 0, 0, 1);
  }

  /* ── Noise texture overlay(原 body::after,迁入 .root)──
     z-index 100:在内容之上但低于所有 dialog/overlay(1000+)。 */
  .root::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 100;
    pointer-events: none;
    opacity: 0.028;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    background-repeat: repeat;
    background-size: 256px 256px;
  }

  /* 顶部 chrome 切线必须由 root 统一画,而不是只挂在 .main-titlebar 上。
     否则右侧 inspector 打开时会盖住 main 内部的标题栏阴影,形成断点。 */
  .top-chrome-continuity {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 44px;
    z-index: 8;
    pointer-events: none;
    border-bottom: 1px solid var(--bd-muted);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.05),
      inset 0 2px 0 0 color-mix(in srgb, var(--acc) 28%, transparent);
  }

  .specops-error {
    position: fixed;
    right: 16px;
    bottom: 42px;
    z-index: 90;
    width: min(440px, calc(100vw - 32px));
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 5px 12px;
    padding: 12px;
    border: 1px solid var(--st-err);
    border-radius: 6px;
    background: var(--bg-elevated);
    box-shadow: var(--sh-lg);
  }
  .specops-error strong { grid-column: 1; color: var(--st-err); }
  .specops-error span { grid-column: 1; color: var(--fg-muted); font-size: var(--fs-sm); }
  .specops-error button { grid-column: 2; grid-row: 1 / 3; align-self: center; }
  /* 宽度由 inline style(--inspector-w,拖拽状态)驱动;这里留个兜底默认值 */
  .root.inspector-open { --inspector-w: 420px; }
  /* 拖拽中关掉列宽过渡,避免跟手延迟;禁止选中文本 */
  .root.inspector-resizing {
    transition: none;
    user-select: none;
    cursor: col-resize;
  }
  /* compact 宽度必须 >= 原生红绿灯总宽(titleBarStyle Overlay,约 70px),
     否则红绿灯会溢出 sidebar 压到终端区。 */
  .root.sb-compact { --sidebar-w: 78px; }
  .root.sb-hidden  { --sidebar-w: 0px; }
  /* hidden:用列宽→0 收起(不再 display:none),配合 .sidebar overflow:hidden 平滑动画。
     收起后不可交互,且内容不换行抖动。 */
  .root.sb-hidden .sidebar {
    pointer-events: none;
    border-right-color: transparent;
  }
  .sidebar { white-space: nowrap; }

  /* ===== sidebar 顶部红绿灯条 =====
     macOS 标准:traffic 距窗口左缘 ~13px。这条顶栏:红绿灯 | Kill la Code 文字 | + 按钮。
     与右侧标题区顶条同高 → + / 红绿灯 / inspector 开关在同一水平线。
     整条 drag region,内部按钮 no-drag。 */
  /* 系统原生红绿灯(titleBarStyle: Overlay)落在窗口左上角,约占 70px 宽。
     这条顶栏用 padding-left 让位,品牌文字/+ 按钮排在红绿灯右侧。 */
  .sidebar-traffic {
    flex-shrink: 0;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 8px 0 78px;
    -webkit-app-region: drag;
    user-select: none;
    -webkit-user-select: none;
  }
  /* + 按钮:无底框,light/dark 都用 token 取色 */
  .sidebar-traffic .icon-btn {
    -webkit-app-region: no-drag;
  }

  /* ===== 浮在终端区顶部的单条标题栏 =====
     不占 grid 行(absolute),不挤压终端,无边框;高度 44px 与左侧红绿灯条一致。
     背景用纵向渐变:顶部不透明遮住标题区,底部渐隐到透明 → 与下面终端内容柔和过渡。
     顶部 1px accent 线和底部分隔线由 .top-chrome-continuity 统一画到整窗宽度,
     避免右侧 inspector 打开时截断。 */
  .main-titlebar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 5;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px;
    background: linear-gradient(
      to bottom,
      var(--bg-base) 0%,
      var(--bg-base) 60%,
      color-mix(in srgb, var(--bg-base) 70%, transparent) 82%,
      transparent 100%
    );
    -webkit-app-region: drag;
    user-select: none;
    -webkit-user-select: none;
    pointer-events: none; /* 容器本身放行点击给终端;内部交互元素再各自开 auto */
  }
  /* 标题栏下沿再向终端延伸一段渐隐,让滚动内容从上往下淡入,没有硬切线 */
  .main-titlebar::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    height: 14px;
    pointer-events: none;
    background: linear-gradient(
      to bottom,
      color-mix(in srgb, var(--bg-base) 65%, transparent) 0%,
      transparent 100%
    );
  }
  .main-titlebar[data-tauri-drag-region] { pointer-events: auto; }
  /* hidden 模式:sidebar 收起,原生红绿灯落在这条 titlebar 左上角 → 让出 70px */
  .main-titlebar.sidebar-hidden {
    padding-left: 78px;
  }
  /* hidden 模式下跟红绿灯同排的 + 按钮 */
  .main-titlebar .hidden-fallback-add {
    flex-shrink: 0;
    -webkit-app-region: no-drag;
    pointer-events: auto;
  }
  .main-title-center {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 8px;
    color: var(--fg-primary);
    text-align: center;
    -webkit-app-region: drag;
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
  }
  .main-title-center strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    font-weight: 600;
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
    /* chip 化:背景 + 圆角 + padding,Linear/Vercel 标题样式 */
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: var(--rad-md);
    background: var(--bg-chip);
    border: 1px solid var(--bd-muted);
    /* 轻微 text-shadow 增强在渐变背景上的可读性 */
    text-shadow: 0 1px 1px rgba(0, 0, 0, 0.2);
  }
  .main-title-center span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .titlebar-actions {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    -webkit-app-region: no-drag;
    pointer-events: auto;
  }
  /* inspector 开关:无底框。
     - 关闭态(closed):灰色描边 panel 图标
     - 展开态(.active):accent 色 + 右分区填充图标 + 很淡的 accent 底,明显区分 */
  .titlebar-tool {
    flex-shrink: 0;
    -webkit-app-region: no-drag;
    pointer-events: auto;
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: var(--rad-md);
    background: transparent;
    color: var(--fg-secondary);
    cursor: pointer;
    transition:
      background var(--t-fast),
      border-color var(--t-fast),
      color var(--t-fast);
  }
  .titlebar-tool:hover {
    background: var(--bg-hover);
    border-color: var(--bd-default);
    color: var(--fg-primary);
  }
  .titlebar-tool.active {
    background: var(--acc-soft);
    color: var(--acc);
  }
  .titlebar-tool.active:hover {
    background: color-mix(in srgb, var(--acc) 18%, transparent);
  }

  /* ===== sidebar ===== */
  .sidebar {
    grid-row: 1 / 2;
    grid-column: 1 / 2;
    margin: 0;
    background: var(--bg-sidebar);
    border-right: 1px solid color-mix(in srgb, var(--bd-default) 86%, transparent);
    border-radius: 0;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
    transition: border-right-color 180ms ease;
  }
  /* Kill la Code 文字:放在红绿灯右边、占中间弹性空间,把 + 推到最右 */
  .brand-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    line-height: 1.12;
    -webkit-app-region: drag;
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
  }
  .brand-name {
    font-size: 12.5px;
    font-weight: var(--fw-semi);
    color: var(--fg-primary);
    letter-spacing: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
  }
  .brand-sub {
    font-size: 10.5px;
    color: var(--fg-tertiary);
    letter-spacing: 0;
    white-space: nowrap;
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
  }
  /* 无底框图标按钮:默认只有图标,hover 时浮出一层很淡的圆形底,light/dark 自适应 */
  .icon-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--fg-secondary);
    width: 26px; height: 26px;
    border-radius: var(--rad-md);
    cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    padding: 0;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .icon-btn:hover {
    background: color-mix(in srgb, var(--fg-primary) 8%, transparent);
    color: var(--acc);
  }

  .tab-list {
    flex: 1;
    overflow-y: auto;
    padding: var(--sp-2);
  }
  .placeholder, .boot-error {
    padding: var(--sp-3);
    color: var(--fg-secondary);
    font-size: var(--fs-sm);
  }
  .boot-error { color: var(--st-err); white-space: pre-wrap; }

  /* ===== workspace 分组容器 =====
     .ws-list 是外层 dndzone 容器(workspace 级拖拽);
     .ws-group 是每个 workspace 的整体(header + tabs);
     .ws-grip 是 header 左侧的拖拽手柄视觉线索。 */
  .ws-list { display: flex; flex-direction: column; }
  .ws-group { display: flex; flex-direction: column; }
  .ws-group.dragging {
    opacity: 0.5;
    transform: scale(0.98);
    transition: opacity var(--t-fast), transform var(--t-fast);
  }

  /* ===== workspace 分组 header ===== */
  .ws-group-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 7px 8px 6px;
    margin: 6px 0 2px;
    border: 1px solid transparent;
    border-radius: var(--rad-md);
    background: transparent;
    color: var(--fg-secondary);
    font-size: var(--fs-xs, 11px);
    font-weight: 600;
    text-align: left;
    cursor: grab;
    transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
  }
  .ws-group-header:active { cursor: grabbing; }
  .ws-group-header:hover { background: var(--bg-tab-hover); color: var(--fg-primary); }
  .ws-group-header.remote {
    border-color: color-mix(in srgb, var(--acc) 14%, transparent);
    background: color-mix(in srgb, var(--acc) 4%, transparent);
  }
  .ws-group-header .ws-grip {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--fg-tertiary);
    opacity: 0.4;
    transition: opacity var(--t-fast);
  }
  .ws-group-header:hover .ws-grip { opacity: 1; }
  .ws-group-header .ws-chevron {
    display: inline-flex;
    color: var(--fg-tertiary);
    transition: transform var(--t-fast);
  }
  .ws-group-header .ws-icon {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
    color: color-mix(in srgb, var(--acc) 70%, var(--fg-secondary));
  }
  .ws-group-header .ws-icon.remote {
    color: color-mix(in srgb, var(--st-info, #8fd3ff) 82%, var(--fg-secondary));
  }
  .ws-group-header .ws-icon.remote::after {
    content: '';
    position: absolute;
    right: -2px;
    bottom: -1px;
    width: 5px;
    height: 5px;
    border: 1px solid var(--bg-sidebar);
    border-radius: 999px;
    background: color-mix(in srgb, var(--st-info, #8fd3ff) 92%, var(--acc));
  }
  .ws-group-header .ws-title {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 1px;
  }
  .ws-group-header .ws-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-ui);
    text-transform: none;
    letter-spacing: 0;
  }
  .ws-group-header .ws-path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-tertiary);
    font-size: 10px;
    font-weight: 500;
    line-height: 12px;
  }
  .ws-group-header .ws-count {
    flex-shrink: 0;
    min-width: 16px;
    height: 16px;
    padding: 0 5px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--fg-primary) 10%, transparent);
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
    line-height: 16px;
    text-align: center;
  }
  .ws-group-tabs { display: flex; flex-direction: column; }
  /* compact 多 workspace 组间分隔线:1px 细线 + 左右 margin,不占横向空间。
     参考 VS Code activity bar / Slack sidebar 的组分隔风格。 */
  .ws-group-separator {
    height: 1px;
    margin: 6px 12px;
    background: color-mix(in srgb, var(--fg-primary) 10%, transparent);
    flex-shrink: 0;
  }
  /* 折叠态:chevron 已经在模板里换成 chevron-right,这里不再额外旋转 */

  /* ===== tab item ===== */
  .tab {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    margin: 2px 0;
    border: 1px solid transparent;
    border-radius: var(--rad-lg);
    cursor: default !important;
    user-select: none;
    -webkit-user-select: none;
    transition: background var(--t-fast), border-color var(--t-fast), box-shadow var(--t-fast), transform var(--t-fast);
  }
  .tab.status-only {
    gap: 6px;
    padding-block: 5px;
  }
  .tab:hover {
    background: var(--bg-tab-hover);
    border-color: color-mix(in srgb, var(--bd-default) 76%, var(--fg-tertiary));
  }
  .tab.active {
    background: var(--bg-tab-active);
    border-color: color-mix(in srgb, var(--acc) 42%, var(--bd-default));
    box-shadow: inset 2px 0 0 0 var(--acc), 0 8px 24px rgba(0, 0, 0, 0.10);
  }
  .tab:focus-visible { outline: 2px solid var(--acc); outline-offset: -2px; }
  .tab-rail {
    width: 34px;
    flex: 0 0 34px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0;
    padding-top: 0;
  }
  .tab-rail.status-only {
    width: 10px;
    flex: 0 0 10px;
  }

  /* ===== avatar-wrap:头像 + hover 编辑按钮 + 右键 picker 触发点 ===== */
  .avatar-wrap {
    position: relative;
    width: 34px;
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .avatar-edit-btn {
    position: absolute;
    bottom: -3px;
    right: -3px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--bg-elevated);
    border: 1px solid var(--bd-default);
    color: var(--fg-secondary);
    display: none;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
    z-index: 3;
    transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
  }
  .avatar-wrap:hover .avatar-edit-btn { display: inline-flex; }
  .avatar-edit-btn:hover {
    background: var(--acc);
    color: var(--bg-elevated);
    border-color: var(--acc);
  }
  /* 拖拽进行中隐藏编辑按钮,避免误触 */
  .tab.dragging .avatar-edit-btn { display: none !important; }

  /* ===== sidebar compact 模式 =====
   * 整侧栏 78px,每个 tab 变成一个垂直 pill tile:
   *   rail(44px tile,backend-tinted 渐变填充 + 大号 icon)
   *   · 序号 chip(浮在右上角)
   *   · attention/unread 标记(角落 ribbon / dot)
   * "full-filled" 设计:icon 不再是 22px 浮在 28px 空圆里,
   * 而是占据 36×36 的彩色 tile,backend 的 tint color 浸满整块。
   */
  .compact-only { display: none; }
  /* compact:窄栏放不下原生红绿灯,这条顶栏只作占位(原生红绿灯由系统画在窗口左上)。
     隐藏 Kill la Code 文字和 + 按钮。 */
  .sidebar.compact .sidebar-traffic {
    justify-content: center;
    gap: 0;
    padding: 0;
  }
  .sidebar.compact .brand-text,
  .sidebar.compact .sidebar-traffic .icon-btn { display: none; }
  /* + 按钮在 compact 下保留(用户仍可新建 tab) */
  .sidebar.compact .tab-list {
    padding: var(--sp-1) 4px;
  }
  .sidebar.compact .tab {
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 4px 4px;
    margin: 1px 2px;
    border-radius: var(--rad-lg);
    /* tile(44) + padding(8) = 52px。idx/badge 直接 overlay 在 tile 上,
       不额外占行。tab 之间只留 2px 间隙。 */
    height: 52px;
  }
  .sidebar.compact .tab.active {
    /* 主动态:accent 内发光 + 微提升,取代细线 box-shadow */
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--acc) 55%, transparent),
      0 0 0 1px color-mix(in srgb, var(--acc) 22%, transparent),
      0 6px 18px rgba(0, 0, 0, 0.32);
    background: color-mix(in srgb, var(--acc) 8%, transparent);
  }
  .sidebar.compact .tab-rail {
    width: 44px;
    flex-basis: auto;
    justify-content: center;
    gap: 0;
    padding-top: 0;
  }
  /* tile 主体:非选中态完全透明,无框无背景,icon 自身就代表 tab。
     只有 active 才有 accent ring + tinted halo。 */
  .sidebar.compact .avatar-wrap {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    position: relative;
    background: transparent;
    border: 1px solid transparent;
    box-shadow: none;
  }
  /* active tab 的 tile:accent ring + tinted halo,让选中态清晰 */
  .sidebar.compact .tab.active .avatar-wrap {
    background:
      radial-gradient(circle at 50% 35%,
        color-mix(in srgb, var(--tab-tint) 36%, transparent) 0%,
        color-mix(in srgb, var(--tab-tint) 18%, transparent) 60%,
        transparent 100%);
    border-color: color-mix(in srgb, var(--tab-tint) 45%, var(--acc));
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--acc) 28%, transparent),
      0 2px 8px color-mix(in srgb, var(--tab-tint) 24%, transparent);
  }
  .sidebar.compact .avatar-edit-btn {
    width: 14px;
    height: 14px;
    bottom: -4px;
    right: -4px;
  }
  .sidebar.compact .tab.status-only {
    gap: 1px;
    padding: 6px 4px;
  }
  .sidebar.compact .tab-rail.status-only {
    width: 10px;
    flex: 0 0 10px;
  }
  .sidebar.compact .tab-body { display: none; }
  .sidebar.compact .close-btn { display: none; }
  .sidebar.compact .close-mask { display: none; }
  .sidebar.compact .compact-only { display: none; }
  .sidebar.compact .status-dot { margin-top: 0; }
  /* tile-idx:浮在 tile 左下角的小 chip,不挡 icon 中心像素。
     部分 chip 会贴着 tile 边缘,像 iOS app icon 的角标但放在下方。 */
  .sidebar.compact .tile-idx {
    position: absolute;
    left: -3px;
    bottom: -3px;
    font-size: 9px;
    color: var(--fg-secondary);
    font-variant-numeric: tabular-nums;
    font-family: var(--font-mono);
    padding: 0 4px;
    border-radius: 999px;
    background: var(--bg-elevated);
    border: 1px solid var(--bd-default);
    line-height: 1.4;
    min-width: 14px;
    text-align: center;
    z-index: 3;
    pointer-events: none;
    font-weight: var(--fw-med);
  }
  .sidebar.compact .tab.active .tile-idx {
    color: var(--acc);
    font-weight: var(--fw-semi);
    background: var(--bg-base);
    border-color: color-mix(in srgb, var(--acc) 50%, var(--bd-default));
    box-shadow: 0 0 6px color-mix(in srgb, var(--acc) 40%, transparent);
  }
  /* tile-badge:attention/unread 浮在 tile 右上角外侧,极小角标。
     位置和 status-dot 重叠:但有 badge 时下方 :has() 规则会隐藏
     status-dot(badge 已表达 attention/unread,冗余),所以不冲突。 */
  .sidebar.compact .tile-badge {
    position: absolute;
    right: -2px;
    top: -2px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 7.5px;
    font-weight: var(--fw-bold);
    color: var(--fg-on-accent);
    border: 1px solid var(--bg-sidebar);
    z-index: 3;
    pointer-events: none;
    line-height: 1;
  }
  .sidebar.compact .tile-badge.attention-ask {
    background: var(--st-warn);
    box-shadow: 0 0 8px color-mix(in srgb, var(--st-warn) 70%, transparent);
  }
  .sidebar.compact .tile-badge.attention-plan {
    background: var(--st-busy);
    box-shadow: 0 0 8px color-mix(in srgb, var(--st-busy) 70%, transparent);
  }
  .sidebar.compact .tile-badge.unread {
    background: var(--acc);
    box-shadow: 0 0 6px color-mix(in srgb, var(--acc) 60%, transparent);
  }
  /* status-dot:AvatarSprite 内部的 .fallback-status 在 compact 模式下
     正常显示(idle/busy/exited)。但当 tile-badge 存在(attention/unread)时,
     badge 已表达该状态,status-dot 冗余,用 :has() 隐藏避免重叠。
     :has() 在 Safari 15.4+ / Chrome 105+ 支持,Tauri WebView 都满足。 */
  .sidebar.compact .avatar-wrap :global(.fallback-status) {
    z-index: 2;
  }
  .sidebar.compact .avatar-wrap:has(.tile-badge) :global(.fallback-status) {
    display: none;
  }

  .status-dot {
    width: 8px; height: 8px; border-radius: 50%;
    flex-shrink: 0;
  }
  .dot-starting  { background: var(--fg-tertiary); }
  .dot-idle      { background: var(--st-idle); }
  .dot-busy      { background: var(--st-busy); animation: pulse 1.4s ease-in-out infinite; }
  /* attention dot:默认配色按 ask(警示黄);plan 通过 .tab[data-attention="plan"]
   * 复合选择器覆盖成火焰橙。这样不用改 statusLabel 的返回类型。 */
  .dot-attention {
    background: var(--st-warn);
    box-shadow: 0 0 0 0 rgba(230, 180, 80, 0.75);
    animation: dot-attention-pulse 1.1s ease-in-out infinite;
  }
  .tab[data-attention="plan"] .dot-attention {
    background: var(--st-busy);
    box-shadow: 0 0 0 0 rgba(230, 180, 80, 0.75);
    animation: dot-attention-pulse-plan 1.1s ease-in-out infinite;
  }
  .dot-exited    { background: var(--fg-tertiary); opacity: 0.5; }
  /* 旧的 ok/err alias:保留,避免别处误用 */
  .dot-ok        { background: var(--st-ok); }
  .dot-err       { background: var(--st-err); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  @keyframes dot-attention-pulse {
    0%, 100% {
      transform: scale(1);
      box-shadow: 0 0 0 0 rgba(230, 180, 80, 0.75);
    }
    50% {
      transform: scale(1.18);
      box-shadow: 0 0 0 5px rgba(230, 180, 80, 0);
    }
  }
  @keyframes dot-attention-pulse-plan {
    0%, 100% {
      transform: scale(1);
      box-shadow: 0 0 0 0 rgba(230, 180, 80, 0.75);
    }
    50% {
      transform: scale(1.18);
      box-shadow: 0 0 0 5px rgba(230, 180, 80, 0);
    }
  }

  .tab-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center; /* rail avatar 固定 34px,内容行高可能略小,居中对齐 */
    gap: 1px;
  }
  /* close-btn 浮在 .tab-title-row 右侧(absolute),不再给 title-row 恒定 padding-right。
   * 标题可延伸到完整宽度,空间利用率最大化;hover/active 时 close-btn 淡入并遮住标题尾部
   * (标题本身有 ellipsis,被遮的几个字在 hover 态下不影响识别)。*/
  .tab-title-row {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
  }
  .tab-index {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-tertiary);
    font-variant-numeric: tabular-nums;
    line-height: 1.4;
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
  }
  .tab.active .tab-index { color: var(--acc); font-weight: var(--fw-med); }
  .tab-title {
    font-size: var(--fs-md);
    color: var(--fg-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
    font-weight: var(--fw-med);
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
  }
  .unread-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--st-accent);
    flex-shrink: 0;
  }

  .tab.needs-attention {
    background: rgba(230, 180, 80, 0.10);
    border-color: rgba(230, 180, 80, 0.42);
    box-shadow: inset 2px 0 0 0 var(--st-warn);
    animation: tab-attention-breath 1.6s ease-in-out infinite;
  }
  .tab.needs-attention.active {
    animation: none;
    background: rgba(230, 180, 80, 0.13);
    border-color: rgba(230, 180, 80, 0.62);
    box-shadow: inset 2px 0 0 0 var(--st-warn);
  }
  @keyframes tab-attention-breath {
    0%, 100% {
      background: rgba(230, 180, 80, 0.08);
      box-shadow: inset 2px 0 0 0 var(--st-warn);
    }
    50% {
      background: rgba(230, 180, 80, 0.16);
      box-shadow: inset 2px 0 0 0 var(--st-warn), 0 0 0 2px rgba(230, 180, 80, 0.10);
    }
  }
  .attention-badge {
    flex-shrink: 0;
    width: 14px; height: 14px;
    border-radius: 50%;
    color: #18140A;
    font-size: 10px;
    font-weight: 700;
    line-height: 14px;
    text-align: center;
    animation: badge-pulse 1.1s ease-in-out infinite;
  }
  .attention-ask  { background: var(--st-warn); }
  .attention-plan { background: var(--st-busy); }
  @keyframes badge-pulse {
    0%, 100% { transform: scale(1);   box-shadow: 0 0 0 0 rgba(230, 180, 80, 0.58); }
    50%      { transform: scale(1.18); box-shadow: 0 0 0 5px rgba(230, 180, 80, 0); }
  }
  .tab[data-attention="plan"] {
    background: rgba(230, 180, 80, 0.10);
    border-color: rgba(230, 180, 80, 0.42);
    box-shadow: inset 2px 0 0 0 var(--st-busy);
    animation: tab-attention-breath-plan 1.6s ease-in-out infinite;
  }
  .tab[data-attention="plan"].active {
    animation: none;
    background: rgba(230, 180, 80, 0.13);
    border-color: rgba(230, 180, 80, 0.62);
    box-shadow: inset 2px 0 0 0 var(--st-busy);
  }
  @keyframes tab-attention-breath-plan {
    0%, 100% {
      background: rgba(230, 180, 80, 0.08);
      box-shadow: inset 2px 0 0 0 var(--st-busy);
    }
    50% {
      background: rgba(230, 180, 80, 0.16);
      box-shadow: inset 2px 0 0 0 var(--st-busy), 0 0 0 2px rgba(230, 180, 80, 0.10);
    }
  }
  .tab[data-attention="plan"] .attention-badge {
    animation: badge-pulse-plan 1.1s ease-in-out infinite;
  }
  @keyframes badge-pulse-plan {
    0%, 100% { transform: scale(1);   box-shadow: 0 0 0 0 rgba(230, 180, 80, 0.58); }
    50%      { transform: scale(1.18); box-shadow: 0 0 0 5px rgba(230, 180, 80, 0); }
  }
  /* 尊重用户偏好:Reduce Motion → 关动画,只保留高亮 */
  @media (prefers-reduced-motion: reduce) {
    .tab.needs-attention,
    .tab[data-attention="plan"],
    .attention-badge {
      animation: none;
    }
  }

  /* chips / meta row(原 tab-chips + tab-ctx 合并成一行) */
  .tab-meta {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: nowrap;
    overflow: hidden;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 10.5px;
    font-family: var(--font-mono);
    line-height: 1.4;
    white-space: nowrap;
    border: 1px solid transparent;
  }
  .chip-codebuddy { background: rgba(159, 232, 112, 0.12); color: var(--acc); border-color: rgba(159, 232, 112, 0.25); }
  .chip-claude    { background: rgba(230, 180, 80, 0.12); color: var(--st-warn); border-color: rgba(230, 180, 80, 0.25); }
  .chip-other     { background: var(--bg-tab-hover); color: var(--fg-secondary); border-color: var(--bd-default); }
  .chip-model     { background: var(--bg-tab-hover); color: var(--st-info); border-color: var(--bd-default); }
  /* 自定义 avatar 时只显示 backend icon(无文案),作为 chip 的轻量视觉锚点 */
  .chip-backend-icon {
    background: transparent;
    border: none;
    padding: 0;
    width: 14px;
    height: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  /* tokens chip:扁平无背景,信息密度优先 */
  .chip-tokens {
    background: transparent;
    color: var(--fg-tertiary);
    font-size: 9.5px;
    padding: 0 4px;
    border: none;
    font-variant-numeric: tabular-nums;
  }
  .exited-tag { color: var(--st-warn); margin-left: auto; font-size: var(--fs-xs); }

  /* 右侧渐变蒙版 + 关闭按钮。
   * 设计意图:
   *   - 默认完全不显示(包括 active tab),只在 hover 这个 tab 时淡入
   *   - X 落在 tab 最右侧,会盖住标题尾部/chips —— 渐变蒙版托底,让 X 浮在
   *     "干净背景"上,而不是直接叠在文字上读不清
   *   - 蒙版与按钮解耦:.close-mask 只负责视觉(70px 渐变,pointer-events:none);
   *     .close-btn 缩到 icon 本身大小(18×18),可点区域 = 图标本身
   *   - X 本体:18×18 方形圆角(rad-sm)的 svg,hover button 时 svg 变红底反色
   *   - 标题尾部在 hover 时被蒙版盖住是 OK 的:标题有 ellipsis,hover 态下用户关注关闭操作
   *     鼠标移开蒙版消失,标题恢复完整
   *
   * 层叠(从底到顶):.close-mask(70px 渐变,pointer-events:none)
   *                 → .close-btn(18×18 按钮,可点) → svg(hover 变红)
   */
  .close-mask {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 70px;
    background: linear-gradient(
      to left,
      var(--bg-sidebar) 0%,
      color-mix(in srgb, var(--bg-sidebar) 94%, transparent) 48%,
      color-mix(in srgb, var(--bg-sidebar) 58%, transparent) 78%,
      transparent 100%
    );
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--t-fast);
    z-index: 2;
    border-radius: 0 var(--rad-lg) var(--rad-lg) 0;
  }
  .tab:hover .close-mask {
    opacity: 1;
  }
  .close-btn {
    position: absolute;
    right: 6px;
    top: 0;
    bottom: 0;
    margin: auto 0;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--fg-secondary);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transform: translateX(2px);
    transition: opacity var(--t-fast), transform var(--t-fast);
    z-index: 3;
  }
  /* 只在 hover tab 时显示;active 不显示(用户已聚焦此 tab,关 tab 不是高频操作) */
  .tab:hover .close-btn {
    opacity: 1;
    transform: translateX(0);
  }
  /* X 内嵌按钮:方形圆角小底块,hover 时红底反色 */
  .close-btn :global(svg) {
    width: 18px;
    height: 18px;
    padding: 3px;
    box-sizing: border-box;
    border-radius: var(--rad-sm);
    background: transparent;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .close-btn:hover :global(svg) {
    background: var(--st-err);
    color: var(--fg-on-accent);
  }

  /* ===== ⋯ overflow 按钮 + 菜单 =====
   * .more-btn 不单独画渐变 —— 右侧统一由 .close-mask 的 70px 渐变蒙版覆盖,
   * 同时托住 ⋯ 和 X,避免两个渐变叠出断层。
   */
  .more-btn {
    position: absolute;
    right: 36px;
    top: 0;
    bottom: 0;
    width: 28px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--fg-secondary);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transform: translateX(2px);
    transition: opacity var(--t-fast), transform var(--t-fast), color var(--t-fast);
    z-index: 5;
    pointer-events: auto;
  }
  /* 跟 close 一样:仅 hover 当前 tab 时显示;active tab 不常驻显示 */
  .tab:hover .more-btn {
    opacity: 1;
    transform: translateX(0);
  }
  .tab.dragging .more-btn { pointer-events: none; }
  .more-btn :global(svg) {
    width: 18px;
    height: 18px;
    padding: 3px;
    box-sizing: border-box;
    border-radius: var(--rad-sm);
    transition: background var(--t-fast), color var(--t-fast), transform var(--t-fast);
  }
  .more-btn:hover :global(svg),
  .more-btn[aria-expanded="true"] :global(svg) {
    background: color-mix(in srgb, var(--acc) 18%, transparent);
    color: var(--fg-base);
    transform: translateY(-1px);
  }
  /* 菜单展开时锁定 ⋯ 可见,否则鼠标移到菜单时按钮会消失 */
  .more-btn[aria-expanded="true"] { opacity: 1; transform: translateX(0); }

  /* compact 模式 ⋯ 隐藏,由右键 contextmenu 入口替代(见 .tab oncontextmenu) */
  .sidebar.compact .more-btn { display: none; }

  .tab-menu {
    /* position/top/right 由 inline style(menuStyle)控制,用 position:fixed
       让菜单逃出 .tab-list 的 overflow:auto 裁切。这里只留视觉样式。 */
    z-index: 60;
    min-width: 168px;
    padding: 6px;
    overflow: visible;
    border: 1px solid color-mix(in srgb, var(--acc) 18%, var(--bd-default));
    border-radius: calc(var(--rad-lg) + 2px);
    background:
      linear-gradient(145deg,
        color-mix(in srgb, var(--bg-sidebar) 92%, var(--fg-primary) 8%) 0%,
        color-mix(in srgb, var(--bg-sidebar) 98%, black 8%) 100%),
      var(--bg-sidebar);
    box-shadow:
      0 18px 42px rgba(0, 0, 0, 0.38),
      0 4px 14px rgba(0, 0, 0, 0.28),
      inset 0 1px 0 rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(18px) saturate(120%);
    animation: tab-menu-in 120ms ease-out;
  }
  .tab-menu button {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-height: 32px;
    padding: 7px 9px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--fg-secondary);
    border-radius: var(--rad-md);
    cursor: pointer;
    font-size: 12px;
    font-weight: var(--fw-med);
    letter-spacing: 0.01em;
    text-align: left;
    transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast), transform var(--t-fast);
  }
  .tab-menu button :global(svg) {
    width: 20px;
    height: 20px;
    padding: 4px;
    box-sizing: border-box;
    border-radius: var(--rad-sm);
    background: color-mix(in srgb, var(--fg-secondary) 10%, transparent);
    color: var(--fg-secondary);
  }
  .tab-menu button:hover {
    background: color-mix(in srgb, var(--acc) 13%, transparent);
    border-color: color-mix(in srgb, var(--acc) 22%, transparent);
    color: var(--fg-base);
    transform: translateX(1px);
  }
  .tab-menu button:hover :global(svg) {
    background: color-mix(in srgb, var(--acc) 22%, transparent);
    color: var(--fg-base);
  }
  .tab-menu button.danger:hover {
    background: color-mix(in srgb, var(--st-err) 16%, transparent);
    border-color: color-mix(in srgb, var(--st-err) 32%, transparent);
    color: var(--st-err);
  }
  .tab-menu button.danger:hover :global(svg) {
    background: color-mix(in srgb, var(--st-err) 24%, transparent);
    color: var(--st-err);
  }
  .menu-sep {
    height: 1px;
    background: linear-gradient(
      to right,
      transparent,
      color-mix(in srgb, var(--fg-secondary) 18%, transparent),
      transparent
    );
    margin: 5px 6px;
  }
  @keyframes tab-menu-in {
    from { opacity: 0; transform: translateY(-4px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  /* ===== 行内 rename input ===== */
  .tab-title-input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    outline: none;
    color: var(--fg-base);
    font: inherit;
    border-bottom: 1px solid var(--acc);
    padding: 0 2px;
  }

  /* ===== dnd 拖拽态 ===== */
  .tab.dragging { opacity: 0.4; }

  /* ===== 长按闸门态(longpress_gate action 加的 class) =====
     .longpress-arming:按下未到 600ms,轻微缩起提示「正在识别长按」
     .longpress-armed :长按到时,dndzone 已接管,变 grab + 抬起 */
  .tab.longpress-arming,
  .ws-group-header.longpress-arming {
    transform: scale(0.98);
    box-shadow: 0 0 0 1px var(--acc) inset;
  }
  .tab.longpress-armed,
  .ws-group-header.longpress-armed {
    cursor: grabbing !important;
    transform: scale(1.02);
    box-shadow: var(--shadow-md, 0 4px 12px rgba(0,0,0,0.25));
  }

  /* ===== main 区 ===== */
  .main {
    position: relative;
    grid-row: 1 / 2;
    grid-column: 2 / 3;
    overflow: hidden;
    min-height: 0;
    background: var(--bg-base);
    box-shadow: none;
    /*
     * 终端列建立独立 stacking context:
     * `.root::before`(网格 z-index:0)/ `.root::after`(噪声 z-index:100)
     * 都挂在 .root 上,会渗进终端区域 —— dark 模式下 2% 绿网格在近黑底色上肉眼可辨。
     * `isolation: isolate` 让 .main 成为新 stacking context 的根,其内部 z-index
     * 与 .root 的装饰层不再同栈;.main 的不透明 var(--bg-base) 背景把网格盖死。
     * 同时显式 z-index:1 确保 .main 整体压在 .root::before(z-index:0)之上。
     * sidebar / inspector 仍在 .root 栈内,装饰层照常保留(符合设计意图)。
     */
    isolation: isolate;
    z-index: 1;
  }
  /* 文件拖入窗口时,终端区亮一条虚线边框 + 轻微高亮,提示可放。 */
  .main.drag-over::after {
    content: '';
    position: absolute;
    inset: 8px;
    border: 2px dashed var(--acc);
    border-radius: var(--rad-lg);
    background: color-mix(in srgb, var(--acc) 8%, transparent);
    pointer-events: none;
    z-index: 9999;
  }
  /* 拖拽中覆盖终端区:捕获 drop,防止 xterm 消费事件 */
  .drag-overlay {
    position: absolute;
    inset: 0;
    z-index: 10000;
    cursor: copy;
  }
  .inspector-shell {
    position: relative;
    grid-row: 1 / 2;
    grid-column: 3 / 4;
    min-width: 0;
    min-height: 0;
    padding: 0;
    background: var(--bg-sidebar);
    border-left: 1px solid color-mix(in srgb, var(--bd-default) 86%, transparent);
    /* 常驻渲染:关闭时列宽→0,这里裁掉内容,避免内容溢出到主区 */
    overflow: hidden;
    transition: border-left-color 180ms ease;
    display: flex;
    flex-direction: column;
  }
  .inspector-shell:not(.open) {
    border-left-color: transparent;
    pointer-events: none;
  }
  .inspector-content {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .inspector-workspace {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }
  .terminal-resizer {
    flex: 0 0 6px;
    cursor: row-resize;
    -webkit-app-region: no-drag;
    background: transparent;
    border-top: 1px solid color-mix(in srgb, var(--fg-primary) 8%, transparent);
    position: relative;
    transition: background var(--t-fast);
  }
  .terminal-resizer:hover {
    background: color-mix(in srgb, var(--acc) 12%, transparent);
  }
  .inspector-terminal {
    flex: 0 0 auto;
    min-height: 0;
    overflow: hidden;
    border-top: 1px solid color-mix(in srgb, var(--bd-default) 60%, transparent);
  }
  /* 左缘拖拽把手:6px 宽的命中区,hover/拖拽时高亮一条竖线 */
  .inspector-resizer {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 6px;
    z-index: 10;
    cursor: col-resize;
    -webkit-app-region: no-drag;
    background: transparent;
    transition: background var(--t-fast);
  }
  .inspector-resizer::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 1px;
    background: transparent;
    transition: background var(--t-fast);
  }
  .inspector-resizer:hover::before,
  .root.inspector-resizing .inspector-resizer::before {
    background: var(--acc);
  }
  .root.inspector-resizing .inspector-resizer { background: color-mix(in srgb, var(--acc) 10%, transparent); }
  .term-wrapper {
    position: absolute;
    inset: 0;
    /*
     * 左侧留白:终端内容与 sidebar 分隔线之间留一点呼吸空间,
     * 避免首列字符紧贴边界。padding 而非 margin —— xterm 的 .term-host
     * width:100% 会自动缩到 padding-box 内,FitAddon 据此重算 cols,
     * ResizeObserver 也会在 padding 变化时触发 scheduleResize。
     */
    padding-left: var(--sp-2);
    /* 顶部留出浮动标题栏(44px),避免终端首行被盖住。 */
    padding-top: 44px;
    /*
     * 不用 display:none 隐藏 inactive tab —— display:none 期间容器
     * offsetWidth/Height = 0,xterm 在该容器里 mount 时:
     *   - 内部 RenderService 初始尺寸记 0
     *   - Viewport.syncScrollArea() 把 _lastRecordedViewportHeight / scroll-area
     *     style.height 都写成 0
     * 之后切回时,xterm 内部各种 short-circuit(buffer 长度 / viewport 高度 /
     * cell 高度三者只要等于上次记录就直接 return)会让 scroll-area 永远停在
     * 0px,**滚动条不存在**(scrollbar 由 scroll-area.style.height 撑出)。
     *
     * 改用 visibility:hidden + pointer-events:none + z-index:0 隐藏:
     *   - 容器保持真实 layout 尺寸,xterm mount/refresh 时拿到的都是正确的几何值
     *   - active tab 走 visibility:visible + z-index:1,叠在最上面接管输入
     *   - 视觉上等价于切换可见性,且不会触发 xterm 的"零尺寸"边界 case
     */
    visibility: hidden;
    pointer-events: none;
    z-index: 0;
    /* 隐藏的 wrapper 也要 fade out,避免叠层时一闪 */
    opacity: 0;
    transition: opacity var(--t-fast) ease;
  }
  .term-wrapper.visible {
    visibility: visible;
    pointer-events: auto;
    z-index: 1;
    opacity: 1;
  }

  .main-error {
    padding: var(--sp-4);
    color: var(--st-err);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
  }
  .main-error pre { white-space: pre-wrap; margin-top: var(--sp-2); }

  /* paths banner 浮层模式(有 tab 时)— 不挡住 term 太多 */
  .paths-floating {
    position: absolute;
    top: 0; left: 0; right: 0;
    z-index: 6;
    pointer-events: auto;
  }
  /* M4.1:跟 paths-floating 同套机制,浮在 term-wrapper 上能被点击。
   * 与 paths-floating 在视觉上叠放(memory 在下方一点),但实际 banner 只
   * 在内部 visible=true 时占空间,所以不会跟 paths banner 重叠。 */
  .memory-mcp-floating {
    position: absolute;
    top: 0; left: 0; right: 0;
    z-index: 5;
    pointer-events: auto;
  }

  /* === main 顶部 attention banner ===
   * 当前 active tab 的 prompt 还没解除 → 顶部条带提示用户在终端里回应。
   * 浮在 term-wrapper 之上(absolute + 高 z-index),不抢终端尺寸。
   * 透明度 0.9 让文字清晰易读;sidebar 上的 tab 提示动效仍是主要视觉焦点
   * (因为它在闪、banner 不闪),banner 只补充说明位置(在终端里回应)。
   */
  .attention-banner {
    position: absolute;
    top: 0; left: 0; right: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 6px var(--sp-3);
    border-bottom: 1px solid;
    font-size: var(--fs-sm);
    opacity: 1;
    pointer-events: none;
    animation: attention-slide-down 220ms ease-out;
  }
  .attention-banner-ask {
    background: color-mix(in srgb, var(--st-warn) 92%, var(--bg-base));
    color: #18140A;
    border-bottom-color: color-mix(in srgb, var(--st-warn) 60%, var(--bd-default));
  }
  .attention-banner-plan {
    background: color-mix(in srgb, var(--st-busy) 92%, var(--bg-base));
    color: #18140A;
    border-bottom-color: color-mix(in srgb, var(--st-busy) 60%, var(--bd-default));
  }
  .attention-banner-icon {
    flex-shrink: 0;
    width: 16px; height: 16px;
    border-radius: 50%;
    color: #fff;
    text-align: center;
    line-height: 16px;
    font-weight: 700;
    font-size: 10px;
    /* 不带 pulse — sidebar 已经在闪了,这里再闪是噪声 */
  }
  .attention-banner-ask  .attention-banner-icon { background: #5B3E03; }
  .attention-banner-plan .attention-banner-icon { background: #5B3E03; }
  .attention-banner-text {
    display: flex;
    flex-direction: row;
    align-items: baseline;
    gap: 6px;
    line-height: 1.25;
    min-width: 0;
  }
  .attention-banner-text strong { font-weight: 600; font-size: 11px; }
  .attention-banner-text span { font-size: 10px; opacity: 0.85; }
  @keyframes attention-slide-down {
    from { transform: translateY(-100%); opacity: 0; }
    to   { transform: translateY(0);     opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .attention-banner { animation: none; }
  }

  /* restore banner */
  .restore-banner {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-4);
    background:
      linear-gradient(180deg, transparent, color-mix(in srgb, var(--bg-elevated) 18%, transparent));
  }
  .restore-text {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    color: var(--fg-primary);
  }
  .restore-text strong { font-size: 16px; font-weight: var(--fw-semi); }
  .restore-text span { color: var(--fg-secondary); font-size: var(--fs-sm); }
  .restore-actions { display: flex; gap: var(--sp-2); }
  .btn-primary, .btn-ghost {
    padding: 8px 16px;
    border-radius: var(--rad-lg);
    border: 1px solid var(--bd-default);
    font-size: var(--fs-md);
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast);
  }
  .btn-primary {
    background: var(--acc);
    color: var(--fg-on-accent);
    border-color: var(--acc);
    font-weight: var(--fw-semi);
  }
  .btn-primary:hover { filter: brightness(1.1); }
  .btn-ghost {
    background: transparent;
    color: var(--fg-secondary);
  }
  .btn-ghost:hover {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }

  /* ===== status bar ===== */
  .status {
    grid-row: 2 / 3;
    grid-column: 1 / 4;
    position: relative;
    /*
     * 状态栏要压在 .main(z-index:1, isolation:isolate)之上,否则
     * MetricsHoverCard 向上弹的卡片会被 .main 的 stacking context 整个遮住
     * (子元素 z-index:1200 救不了父级在 .root 栈里被压住的命运)。
     */
    z-index: 2;
    background: color-mix(in srgb, var(--bg-sidebar) 88%, var(--bg-base));
    color: var(--fg-secondary);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--sp-3);
    border-top: 1px solid var(--bd-default);
    /*
     * 不能用 overflow:hidden —— MetricsHoverCard 向上弹的 .card 在 .status 的
     * 子树里,会被裁掉。状态栏内容受控(文本/徽章),溢出风险低;真要兜底用
     * .status-left/.status-right 内部处理。
     */
    overflow: visible;
  }
  .status-left, .status-right {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    /* line-height: 1 让不同字号的文字 flex 项行盒高度=字号本身,
     * 配合 align-items: center 使所有元素的视觉中心落在同一条水平线上,
     * 避免大 line-height 文字把行盒撑高、视觉中心偏移。 */
    line-height: 1;
    /* 不要在这里 overflow:hidden — 会把 .dot-attention 的 box-shadow 脉冲裁掉。
     * 父级 .status 已有 overflow: hidden 做兜底防溢出。 */
  }
  /* 状态栏左右两侧的所有直接子项:统一 line-height 让行盒高度=字号,
   * 配合父级 align-items: center,使不同字号的文字视觉中心落在同一水平线。
   * 注意:不能给会做 text-overflow:ellipsis 的元素(.cwd-path)设 inline-flex,
   * 否则截断失效 —— 所以这里只统一 line-height,不动 display。 */
  .status-left > *,
  .status-right > * {
    line-height: 1;
  }
  .status-text { color: var(--fg-secondary); }
  .status-text.muted { color: var(--fg-tertiary); }

  /* Phase 11.6:远端连接指示器 */
  .remote-indicator {
    display: flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    padding: 1px var(--sp-2);
    cursor: pointer;
    border-radius: 999px;
    color: var(--fg-secondary);
    font: inherit;
    font-size: var(--fs-xs);
  }
  .remote-indicator:hover {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
  .remote-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--fg-tertiary);
    flex-shrink: 0;
  }
  .remote-dot.on {
    background: var(--st-ok, #9FE870);
  }
  .remote-name {
    max-width: 14ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cwd-path {
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    font-size: 11px;
    max-width: 48ch;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status .model { color: var(--st-info); font-family: var(--font-mono); }
  .status .cost { color: var(--st-tokens); font-weight: var(--fw-med); }
  .status .tok-in, .status .tok-out {
    color: var(--st-tokens);
    font-family: var(--font-mono);
  }
  .status .cached {
    color: var(--fg-tertiary);
    font-size: 10px;
  }

  .dev-info {
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
  }

  /* M4 memory pending badge:状态栏右下角,点击打开 review 面板。
   * 视觉权重比 cwd 重(它代表"有事要你看"),用 accent 描边但不闪 ——
   * 有 attention 时 sidebar 已经在闪了,这里只是一个静态计数提示。 */
  .mem-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: rgba(230, 180, 80, 0.12);
    color: var(--st-warn);
    border: 1px solid rgba(230, 180, 80, 0.38);
    border-radius: 999px;
    padding: 1px 8px;
    font-size: 10.5px;
    font-family: var(--font-mono);
    line-height: 1;
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast);
  }
  .mem-badge:hover {
    background: rgba(230, 180, 80, 0.20);
    border-color: var(--st-warn);
  }
  /* hover wrap:relative 容器让 MetricsHoverCard 用 absolute 浮上面。
   * inline-flex + align-items:center 让内部的 .mem-badge 垂直居中,
   * 与状态栏其它子项对齐(原 inline-block 会按基线对齐导致错位)。 */
  .mem-badge-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  /* 无 pending 时的 dim 徽章:暗淡,只露 brain icon,hover 才弹 metrics */
  .mem-badge.dim {
    background: transparent;
    color: var(--text-muted, #888);
    border-color: transparent;
    padding: 1px 4px;
    opacity: 0.5;
  }
  .mem-badge.dim:hover {
    opacity: 0.85;
    background: var(--bg-tab-hover);
    border-color: var(--bd-default);
  }

  /* M4.2 prompt preview dialog —— 简单 modal,无依赖 */
  .prompt-preview-backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-modal-backdrop);
    backdrop-filter: var(--blur-modal);
    -webkit-backdrop-filter: var(--blur-modal);
    z-index: 200;
    display: grid;
    place-items: center;
    padding: 32px;
  }
  .prompt-preview-dialog {
    width: min(820px, 100%);
    max-height: 80vh;
    background: var(--bg-elevated);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-xl);
    box-shadow: var(--sh-modal);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .prompt-preview-dialog header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--bd-default);
    background: var(--bg-input);
  }
  .prompt-preview-dialog header strong {
    color: var(--fg-primary);
    font-size: 13px;
  }
  .prompt-preview-dialog header .meta {
    flex: 1;
    color: var(--fg-tertiary);
    font-size: 11.5px;
  }
  .prompt-preview-dialog header button {
    width: 24px;
    height: 24px;
    border: none;
    background: transparent;
    color: var(--fg-tertiary);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    border-radius: 4px;
  }
  .prompt-preview-dialog header button:hover {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
  .prompt-preview-dialog .content {
    flex: 1 1 auto;
    margin: 0;
    padding: 14px 16px;
    overflow: auto;
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
    font-size: 12px;
    line-height: 1.55;
    color: var(--fg-primary);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
