<script lang="ts">
  /**
   * BackendChooser.svelte —— 启动 / 新建 tab 时的单视图会话配置面板。
   *
   * 单视图表单:backend 下拉 + 工作目录 + model + bypass + 常驻的 Session history,
   * 全部一次呈现;「New session」只在 backend 与 cwd 都就绪后启用。
   * 没有阶段切换,卡片高度固定,历史区固定 208px → 整个流程不发生页面跳变。
   *
   * 默认值:
   *   - 恢复上次成功创建时的 backend / endpoint / model;
   *     cwd 优先指定工作区,其次同 endpoint 的上次目录,最后节点默认目录。
   *   - bypass = 该路径(cwd,不分 backend)勾选过则默认勾选;没记录则 false
   *     (见 project_permission.ts;Session history 的 Resume 同样沿用)
   *
   * 行为约束:
   *   - cwd 不验证目录存在(后端 spawn 失败再报错;给用户写到尚未存在路径的自由)
   *   - Local Browse 走 @tauri-apps/plugin-dialog 的 open({ directory: true })
   *   - Remote 不能调本地 dialog;RemoteCwdPicker 走 fs.list 协议
   */
  import {
    ipc,
    endpointIpc,
    cwdHistoryIpc,
    ENDPOINT_LOCAL,
    endpointRemote,
    type BackendInfo,
    type ModelDiscoveryResult,
    type EndpointId,
    type EndpointSummary,
    type PermissionMode,
    type RemoteBackendInfo,
    type SessionSummary,
  } from './ipc'
  import { modelsFor, type ModelOption } from './model_catalog'
  import { rememberBypass, rememberedBypass } from './project_permission'
  import { rememberedSelection, rememberSelection, sameEndpoint } from './chooser_preferences'
  import { onMount, onDestroy } from 'svelte'
  import { open } from '@tauri-apps/plugin-dialog'
  import RemoteCwdPicker from './RemoteCwdPicker.svelte'
  import Combobox from './Combobox.svelte'
  import BackendIcon from './BackendIcon.svelte'
  import { isAbsoluteSessionCwd } from './session_history_path'

  type Props = {
    backends: BackendInfo[]
    /** Human-readable, recoverable start failure. Keep the chooser mounted so the user can retry. */
    errorMessage?: string | null
    workspaceCwd?: string
    workspaceEndpoint?: EndpointId
    /// 提交回调。
    /// 返回 false 表示创建失败,不保存本次选择。
    onSubmit: (opts: {
      backendKey: string
      cwd?: string
      permissionMode: PermissionMode
      /// 用户选定的 model;undefined = "Use backend default",后端不注入 --model
      model?: string
      /// Phase 11.2:本次 spawn 走哪个 endpoint。undefined / Local = 本地 PTY。
      endpointId?: EndpointId
      /// 恢复已有 session(uuid)。不为空时 spawn 传 --resume <id>。
      resumeSessionId?: string
    }) => void | boolean | Promise<void | boolean>
  }
  let { backends, onSubmit, errorMessage = null, workspaceCwd, workspaceEndpoint }: Props = $props()
  const lastSelection = rememberedSelection()

  function workspacePathFor(ep: EndpointId): string | undefined {
    const target = workspaceEndpoint ?? ENDPOINT_LOCAL
    return ep.kind === target.kind && (ep.kind === 'local' || (target.kind === 'remote' && ep.id === target.id))
      ? workspaceCwd : undefined
  }

  /// 单视图下拉的一个选项。value 是复合值:local 与 remote 会有同名 key
  /// (claude / codex 等),只用 b.key 会串台,所以带上 endpoint 维度。
  type BackendOption = {
    value: string
    backend: BackendInfo
    endpoint: EndpointId
    label: string
    group: string
    /// 远端 backend 自带的默认工作目录,选中时用于回填 cwd。
    defaultCwd?: string | null
  }

  function localOption(b: BackendInfo): BackendOption {
    return {
      value: `local:${b.key}`,
      backend: b,
      endpoint: ENDPOINT_LOCAL,
      label: b.name ?? b.key,
      group: 'Local',
    }
  }

  function remoteOption(ep: EndpointSummary, b: RemoteBackendInfo): BackendOption {
    // RemoteBackendInfo → BackendInfo(model_catalog 用 b.key 查表;远端不知道
    // default_model,留空让 chooser 给一个安全默认)。
    return {
      value: `remote:${ep.id}:${b.key}`,
      backend: {
        key: b.key,
        command: '(remote)',
        default_model: null,
        model_flag: b.model_flag ?? '--model',
      },
      endpoint: endpointRemote(ep.id),
      label: b.display_name ?? b.key,
      group: `Remote · ${ep.display_name}`,
      defaultCwd: b.default_cwd,
    }
  }

  /// 复刻旧 list 阶段的三态可见性:无 workspace 全显示;本地 workspace 只本地;
  /// 远端 workspace 只该 endpoint(连 Local 都隐藏)。
  function includesLocal(): boolean {
    return workspaceCwd === undefined || workspaceEndpoint?.kind !== 'remote'
  }
  function includesEndpoint(ep: EndpointSummary): boolean {
    if (workspaceCwd === undefined) return true
    return workspaceEndpoint?.kind === 'remote' && ep.id === workspaceEndpoint.id
  }

  let remoteOptions = $state<BackendOption[]>([])
  let localOptions = $derived(includesLocal() ? backends.map(localOption) : [])
  let options = $derived([...localOptions, ...remoteOptions])
  let groupedOptions = $derived.by(() => {
    const groups = new Map<string, BackendOption[]>()
    for (const option of options) {
      const list = groups.get(option.group) ?? []
      list.push(option)
      groups.set(option.group, list)
    }
    return [...groups].map(([label, items]) => ({ label, items }))
  })

  let selectedValue = $state('')
  let selectedOption = $derived(options.find((o) => o.value === selectedValue) ?? null)
  /// 只读 derived —— 所有写入都必须走 selectedValue,不要在别处赋值。
  let selected = $derived(selectedOption?.backend ?? null)
  let selectedEndpoint = $derived(selectedOption?.endpoint ?? ENDPOINT_LOCAL)

  let cwd = $state('')
  /// 用户手动改过路径后,切换 backend 不再用记忆/默认覆盖它。
  let cwdTouched = $state(false)
  let bypass = $state(false)
  /// 用户手动改过 toggle 后,cwd 变化不再用项目记忆覆盖它。
  let bypassTouched = $state(false)
  let submitting = $state(false)
  let defaultCwd = $state('') // 从 PathsConfig 拉的全局默认

  // cwd 历史(top 5):按 bucket 拉。本地 'local';远端 endpoint_id。
  // 点历史项 → 填进 cwd 输入框(不自动 start,用户可能还要改 model/mode)。
  let cwdHistory: string[] = $state([])
  let workspaceError = $state('')

  /// 当前 bucket 名:本地 → 'local';远端 → endpoint_id
  function currentBucket(): string {
    return selectedEndpoint.kind === 'remote' ? selectedEndpoint.id : 'local'
  }

  // model 选择状态:
  //   - selectedModelValue = '' 表示 "Use backend default"(不传 --model)
  //   - selectedModelValue = '__custom__' 表示自由输入,真实值在 customModel 里
  //   - 其它值 = 直接用作 --model 参数
  let selectedModelValue = $state('')
  let customModel = $state('')
  let modelOptions: ModelOption[] = $state([])
  let modelLoading = $state(false)
  let modelNotice = $state('')
  let modelSource = $state('')
  let customModelAllowed = $state(true)
  const modelCache = new Map<string, ModelDiscoveryResult>()

  async function probeModels(b: BackendInfo, ep: EndpointId, force = false) {
    const cacheKey = ep.kind === 'remote' ? `${ep.id}:${b.key}` : `local:${b.key}`
    const cached = !force ? modelCache.get(cacheKey) : undefined
    if (cached) {
      applyDiscoveredModels(cached)
      return
    }
    modelLoading = true
    modelNotice = ''
    try {
      const result = ep.kind === 'remote'
        ? await endpointIpc.discoverBackendModels(ep.id, b.key)
        : await ipc.discoverBackendModels(b.key, force)
      const currentKey = selectedEndpoint.kind === 'remote'
        ? `${selectedEndpoint.id}:${selected?.key}`
        : `local:${selected?.key}`
      if (currentKey !== cacheKey) return
      modelCache.set(cacheKey, result)
      applyDiscoveredModels(result)
    } catch (e) {
      const currentKey = selectedEndpoint.kind === 'remote'
        ? `${selectedEndpoint.id}:${selected?.key}`
        : `local:${selected?.key}`
      if (currentKey === cacheKey) {
        modelNotice = `Live model lookup unavailable; showing compatibility presets. ${String(e)}`
      }
    } finally {
      const currentKey = selectedEndpoint.kind === 'remote'
        ? `${selectedEndpoint.id}:${selected?.key}`
        : `local:${selected?.key}`
      if (currentKey === cacheKey) modelLoading = false
    }
  }

  function applyDiscoveredModels(result: ModelDiscoveryResult) {
    modelOptions = result.models.map((m) => ({
      value: m.id,
      label: m.is_default ? `${m.label} (default)` : m.label,
      description: m.description,
    }))
    modelSource = result.source
    customModelAllowed = result.custom_allowed
    if (selectedModelValue === '__custom__' && modelOptions.some((m) => m.value === customModel)) {
      selectedModelValue = customModel
    }
    if (!customModelAllowed && selectedModelValue === '__custom__') selectedModelValue = ''
    if (selectedModelValue && selectedModelValue !== '__custom__'
      && !modelOptions.some((m) => m.value === selectedModelValue)) {
      customModel = selectedModelValue
      selectedModelValue = customModelAllowed ? '__custom__' : ''
    }
    modelNotice = result.warning ?? ''
  }

  // 远端 endpoints + 已拉到的 backend 列表。原生 <select> 无法 lazy 展开分组,
  // 所以挂载时一次性预拉,逐步填充 remoteOptions。
  let endpoints = $state<EndpointSummary[]>([])
  let endpointError = $state('') // 拉 endpoint / 远端 backend 失败
  let endpointRefreshHandler: (() => void) | null = null

  // RemoteCwdPicker 的 open 标志 + 起始路径;仅 remote endpoint 时可弹。
  let cwdPickerOpen = $state(false)

  // session 历史列表:输入 cwd 后自动查询
  let sessions = $state<SessionSummary[]>([])
  let sessionsLoading = $state(false)
  let sessionsError = $state('')
  let sessionsHasMore = $state(false)
  let sessionsLoadingMore = $state(false)
  let sessionsFetchId = 0 // 递增 id,防止竞态(旧的 fetch 回来后覆盖新结果)
  /// 首屏只解析最近几条 transcript;"More" 每次再追加一页。
  const SESSION_PAGE_SIZE = 5
  const SESSION_HISTORY_DEBOUNCE_MS = 120

  function fetchSessionPage(offset: number) {
    const key = selected?.key
    const dir = cwd.trim()
    const ep = selectedEndpoint
    if (!key) return Promise.resolve({ sessions: [], has_more: false })
    return ep.kind === 'remote'
      ? endpointIpc.listSessionsForCwd(ep.id, key, dir, offset, SESSION_PAGE_SIZE)
      : ipc.listSessionsForCwd(key, dir, offset, SESSION_PAGE_SIZE)
  }

  async function loadMoreSessions() {
    if (sessionsLoadingMore || !sessionsHasMore) return
    const fetchId = sessionsFetchId
    sessionsLoadingMore = true
    try {
      const page = await fetchSessionPage(sessions.length)
      if (fetchId !== sessionsFetchId) return
      const known = new Set(sessions.map((s) => s.session_id))
      sessions = [...sessions, ...page.sessions.filter((s) => !known.has(s.session_id))]
      sessionsHasMore = page.has_more
    } catch (e) {
      if (fetchId === sessionsFetchId) sessionsError = String(e)
    } finally {
      if (fetchId === sessionsFetchId) sessionsLoadingMore = false
    }
  }

  /// cwd 变化时按路径记忆回填 bypass 默认值(用户手动改过则不覆盖)。
  $effect(() => {
    if (bypassTouched) return
    bypass = rememberedBypass(cwd)
  })

  /// 当 cwd 变化时(debounce 500ms)查询该目录下的历史 session。
  /// Local 直接扫本机 jsonl;Remote 通过 endpoint 协议扫 server 侧 jsonl。
  $effect(() => {
    const dir = cwd.trim()
    const key = selected?.key
    const ep = selectedEndpoint
    // 有 backend 和绝对 cwd 才查;依赖读取必须同步发生在 setTimeout 之前。
    void ep // 依赖:切换 endpoint 时重新拉首页
    if (!key || !isAbsoluteSessionCwd(dir)) {
      sessionsFetchId++
      sessions = []
      sessionsHasMore = false
      sessionsLoadingMore = false
      sessionsError = ''
      return
    }
    const fetchId = ++sessionsFetchId
    sessionsLoading = true
    sessionsLoadingMore = false
    sessionsError = ''
    const timer = setTimeout(async () => {
      try {
        const page = await fetchSessionPage(0)
        if (fetchId === sessionsFetchId) {
          sessions = page.sessions
          sessionsHasMore = page.has_more
          sessionsLoading = false
        }
      } catch (e) {
        if (fetchId === sessionsFetchId) {
          sessionsError = String(e)
          sessionsLoading = false
        }
      }
    }, SESSION_HISTORY_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  })

  /// 按当前 bucket 拉 cwd 历史(top 5)。远端 bucket = endpoint_id;本地 = 'local'。
  /// 单视图下始终可拉,让路径候选在选 backend 之前就可用。
  $effect(() => {
    const bucket = currentBucket()
    workspaceError = ''
    let cancelled = false
    void bucket // 依赖
    cwdHistoryIpc
      .get(bucket)
      .then((list) => {
        if (!cancelled) { cwdHistory = list; if (!cwd && list.length === 1) cwd = list[0] }
      })
      .catch((error) => {
        if (!cancelled) { cwdHistory = []; workspaceError = String(error) }
      })
    return () => {
      cancelled = true
    }
  })

  /// 拉 endpoint 列表 + 并发预拉各 endpoint 的远端 backends,构建下拉选项。
  /// 原生 <select>/<optgroup> 没法 lazy 展开,所以一次性拉齐后整体填充。
  async function loadBackends() {
    try {
      endpoints = await endpointIpc.list()
      endpointError = ''
    } catch (e) {
      endpointError = String(e)
      endpoints = []
      return
    }
    const results = await Promise.allSettled(
      endpoints
        .filter(includesEndpoint)
        .map((ep) => endpointIpc.getRemoteBackends(ep.id).then((list) => ({ ep, list }))),
    )
    const collected: BackendOption[] = []
    for (const result of results) {
      if (result.status === 'rejected') {
        endpointError = String(result.reason)
        continue
      }
      const { ep, list } = result.value
      for (const b of list.filter((item) => item.enabled !== false)) {
        collected.push(remoteOption(ep, b))
      }
    }
    remoteOptions = collected
    // endpoint 刷新后已选中的 option 可能已下线 → 取消选择,避免按钮指向无效项。
    // 用刚构建的列表判断,不依赖 $derived 的刷新时机。
    const available = [...localOptions, ...collected]
    if (selectedValue && !available.find((o) => o.value === selectedValue)) {
      selectedValue = ''
      cwdPickerOpen = false
    }
  }

  // 每次进入 chooser 都拉一次最新默认 cwd —— 用户可能在 PathsBanner 里改过
  onMount(async () => {
    try {
      const cfg = await ipc.getPathsConfig()
      defaultCwd = cfg.session_cwd ?? ''
      cwd = workspaceCwd ?? defaultCwd
    } catch (e) {
      console.warn('getPathsConfig failed:', e)
    }
    // 先把远端 options 拉齐,再恢复上次选择 —— 否则远端 option 还没到会静默失败。
    await loadBackends()
    // Do not overwrite a selection made while the initial IPC requests were pending.
    if (selectedValue === '' && lastSelection
      && (!workspaceEndpoint || sameEndpoint(workspaceEndpoint, lastSelection.endpointId))) {
      const ep = lastSelection.endpointId
      const value = ep.kind === 'local'
        ? `local:${lastSelection.backendKey}`
        : `remote:${ep.id}:${lastSelection.backendKey}`
      const available = [...localOptions, ...remoteOptions]
      if (available.find((o) => o.value === value)) selectOption(value)
    }
    endpointRefreshHandler = () => {
      void loadBackends()
    }
    window.addEventListener('kode:endpoints-changed', endpointRefreshHandler)
  })

  /// 选中下拉项。selected / selectedEndpoint 是只读 derived,由 selectedValue 推出。
  function selectOption(value: string) {
    const option = options.find((o) => o.value === value)
    selectedValue = option ? value : ''
    cwdPickerOpen = false
    if (!option) return
    const { backend: b, endpoint: ep } = option
    modelOptions = modelsFor(b.key)
    modelLoading = false
    modelNotice = ''
    modelSource = 'compatibility presets'
    customModelAllowed = true
    selectedModelValue = ''
    customModel = ''
    const previous = lastSelection && sameEndpoint(ep, lastSelection.endpointId) ? lastSelection : null
    if (previous?.backendKey === b.key && previous.model) {
      customModel = previous.model
      selectedModelValue = modelOptions.some((m) => m.value === previous.model) ? previous.model : '__custom__'
    }
    void probeModels(b, ep)

    // An explicit workspace wins over everything; otherwise keep a path the user
    // already typed, then fall back to the remembered / remote default.
    cwd = workspacePathFor(ep) ?? (cwdTouched
      ? cwd
      : (previous?.cwd ?? option.defaultCwd ?? (ep.kind === 'local' ? defaultCwd : '')))
  }

  async function submitOnce(opts: {
    backendKey: string
    cwd?: string
    permissionMode: PermissionMode
    model?: string
    endpointId?: EndpointId
    resumeSessionId?: string
  }) {
    if (submitting) return
    submitting = true
    try {
      const success = await onSubmit(opts)
      if (success === false) return
      rememberSelection({ backendKey: opts.backendKey, endpointId: opts.endpointId ?? ENDPOINT_LOCAL,
        cwd: opts.cwd ?? '', model: opts.model })
      if (opts.cwd) rememberBypass(opts.cwd, opts.permissionMode === 'bypass')
    } finally {
      submitting = false
    }
  }

  /// 单视图没有阶段切换 / Back / 数字键 quick-pick,选择只改 selectedValue。

  /// 把 selectedModelValue + customModel 解析成最终要传给后端的 model 字符串。
  /// 返回 undefined 表示不传 model(走 backend.default_model 老语义)。
  function resolveModel(): string | undefined {
    if (selectedModelValue === '') return undefined
    if (selectedModelValue === '__custom__') {
      const t = customModel.trim()
      return t.length > 0 ? t : undefined
    }
    return selectedModelValue
  }

  function modelHint(b: BackendInfo): string {
    const flag = b.model_flag?.trim()
    if (selectedModelValue === '') {
      return b.default_model
        ? `Uses backend default model: ${b.default_model}.`
        : 'Uses the backend default unless you choose a preset or custom model.'
    }
    if (!flag) {
      return 'No model flag configured; the custom value will not be passed at launch.'
    }
    return `Passed to subprocess as ${flag} <value>. Saved per-tab; restored on next launch.`
  }

  function modelPlaceholder(): string {
    return modelOptions[0]?.value ?? 'model-id'
  }

  function start(resumeSessionId?: string) {
    if (!selected || submitting) return
    const finalCwd = cwd.trim()
    if (!finalCwd) { workspaceError = 'Select a Kode workspace before creating this session.'; return }
    void submitOnce({
      backendKey: selected.key,
      cwd: finalCwd || undefined,
      permissionMode: bypass ? 'bypass' : 'default',
      model: resolveModel(),
      endpointId: selectedEndpoint,
      resumeSessionId,
    })
  }

  function resumeSession(s: SessionSummary) {
    if (submitting) return
    start(s.session_id)
  }

  async function browseCwd() {
    if (selectedEndpoint.kind === 'remote') {
      // Phase 11.5.4:走 RemoteCwdPicker,内部调 endpoint_fs_list 协议端点
      cwdPickerOpen = true
      return
    }
    // Local:Tauri dialog 浏览本机 fs
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: cwd.trim() || defaultCwd || undefined,
        title: 'Choose working directory',
      })
      if (typeof picked === 'string' && picked) {
        cwd = picked
      }
    } catch (e) {
      console.warn('dialog open failed:', e)
    }
  }

  function handleKey(e: KeyboardEvent) {
    if (submitting) return
    // 焦点不在按钮上、且 backend + cwd 都选好时,Enter 才提交。
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey
      && selected && cwd.trim()
      && (e.target as HTMLElement)?.tagName !== 'BUTTON') {
      e.preventDefault()
      start()
    }
  }

  onMount(() => window.addEventListener('keydown', handleKey))
  onDestroy(() => {
    window.removeEventListener('keydown', handleKey)
    if (endpointRefreshHandler) {
      window.removeEventListener('kode:endpoints-changed', endpointRefreshHandler)
    }
  })

  /// 格式化 token 数(1.2k / 3.4M)
  function formatTokens(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
    return String(n)
  }

  /// 格式化 UNIX epoch 秒为相对时间
  function formatTime(secs: number): string {
    const now = Date.now() / 1000
    const diff = now - secs
    if (diff < 60) return 'just now'
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago'
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago'
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago'
    const d = new Date(secs * 1000)
    return d.toLocaleDateString()
  }
</script>

<div class="root">
  <div class="card">
    <div class="header">
      <div class="title-row">
        <h1>New session</h1>
        <span class="version">v0.2-dev</span>
      </div>
      <p class="hint">
        Choose a backend and a working directory below, then start the session.
      </p>
    </div>

    <!-- 所有可变高度的条件块都放在这个滚动区里,卡片总高保持恒定。 -->
    <div class="setup-scroll">
      {#if errorMessage}
        <div class="start-error" role="alert">
          <strong>无法启动会话</strong>
          <span>{errorMessage}</span>
          <small>检查命令路径或工作目录后重试；这不会影响左侧已有会话。</small>
        </div>
      {/if}

      {#if selectedEndpoint.kind === 'remote'}
        <p class="badge">via <code>{selectedEndpoint.id}</code> (remote)</p>
      {/if}

      <div class="field">
        <label for="backend-select">Backend</label>
        <!-- 图标 / 文字 / caret 收进同一个控件框,不再各画各的边框。 -->
        <div class="backend-control" class:empty={!selected}>
          <span class="backend-icon">
            {#if selected}
              <BackendIcon backendKey={selected.key} command={selected.command} size={18} />
            {/if}
          </span>
          <select
            id="backend-select"
            value={selectedValue}
            onchange={(e) => selectOption((e.target as HTMLSelectElement).value)}
          >
            <option value="">Select a backend…</option>
            {#each groupedOptions as group}
              <optgroup label={group.label}>
                {#each group.items as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </optgroup>
            {/each}
          </select>
          <span class="backend-caret" aria-hidden="true">▾</span>
        </div>
        <p class="hint-line">
          {#if selected}
            Runs <code>{selected.command}</code>{#if selected.default_model} · default model <code>{selected.default_model}</code>{/if}.
          {:else}
            Pick a local or remote backend to continue.
          {/if}
        </p>
        {#if options.length === 0}
          <p class="ep-msg ep-err" role="alert">
            No backend configured. Open Settings → Backends to enable or add one.
          </p>
        {/if}
        {#if endpointError}
          <p class="ep-msg ep-err">{endpointError}</p>
        {/if}
      </div>

      <div class="field">
        <label for="cwd-input">Working directory</label>
        <div class="cwd-row">
          <Combobox
            id="cwd-input"
            bind:value={cwd}
            options={cwdHistory}
            onchange={() => (cwdTouched = true)}
            placeholder={selectedEndpoint.kind === 'remote'
              ? '/home/dev/code (server-side absolute path)'
              : (defaultCwd || '/absolute/path')}
          />
          <button class="btn ghost" onclick={browseCwd}>Browse…</button>
        </div>
        <p class="hint-line">
          {#if selectedEndpoint.kind === 'remote'}
            Select a Kode workspace on this server, or browse to register one.
          {:else}
            New session's cwd.
          {/if}
        </p>
        {#if workspaceError}<p class="ep-msg ep-err" role="alert">{workspaceError}</p>{/if}
      </div>

      <div class="field">
        <div class="field-label-row">
          <label for="model-select">Model</label>
          <button class="model-refresh" type="button" disabled={!selected || modelLoading} aria-label="Refresh available models" title="Refresh available models" onclick={() => { if (selected) void probeModels(selected, selectedEndpoint, true) }}>
            <span class:spinning={modelLoading}>↻</span>
          </button>
        </div>
        <select
          id="model-select"
          value={selectedModelValue}
          disabled={!selected}
          onchange={(e) => (selectedModelValue = (e.target as HTMLSelectElement).value)}
        >
          <option value="">Use backend default</option>
          {#each modelOptions as m (m.value)}
            <option value={m.value}>{m.label}</option>
          {/each}
          {#if customModelAllowed}<option value="__custom__">Custom…</option>{/if}
        </select>
        {#if selectedModelValue === '__custom__' && selected}
          <input
            type="text"
            value={customModel}
            oninput={(e) => (customModel = (e.target as HTMLInputElement).value)}
            placeholder={modelPlaceholder()}
            spellcheck="false"
            autocomplete="off"
            class="model-custom"
          />
        {/if}
        <p class="hint-line">
          {selected ? modelHint(selected) : 'Select a backend to choose a model.'}
        </p>
        <p class="catalog-status" class:error={Boolean(modelNotice)}>
          {modelLoading ? 'Detecting available models…' : `${modelOptions.length} models · ${modelSource}`}
        </p>
        {#if modelNotice}<p class="hint-line model-notice">{modelNotice}</p>{/if}
      </div>

      <div class="field">
        <label class="toggle">
          <input
            type="checkbox"
            checked={bypass}
            disabled={!selected}
            onchange={(e) => {
              bypass = (e.target as HTMLInputElement).checked
              bypassTouched = true
            }}
          />
          <span class="toggle-label">Bypass permissions</span>
        </label>
        <p class="hint-line">
          Skip permission prompts when the selected backend supports a bypass launch mode.
        </p>
      </div>
    </div>

    <!-- 常驻固定 208px:任何选择/加载状态下都不卸载、不改变尺寸 → 页面不跳变。 -->
    <div class="session-history">
      {#if sessionsLoading}
        <p class="sh-msg">Looking for existing sessions…</p>
      {:else if sessionsError}
        <p class="sh-msg sh-err">{sessionsError}</p>
      {:else if sessions.length > 0}
        <div class="sh-label">Session history in this directory</div>
        <ul class="sh-list">
          {#each sessions as s (s.session_id)}
            <li class="sh-item">
              <div class="sh-main" onclick={() => resumeSession(s)} role="button" tabindex="0"
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    resumeSession(s)
                  }
                }}>
                <span class="sh-title">{s.title || s.session_id.slice(0, 8)}</span>
                <span class="sh-meta">
                  {#if s.model}
                    <code class="sh-model">{s.model}</code>
                  {/if}
                  {#if s.total_tokens != null}
                    <span class="sh-tokens">{formatTokens(s.total_tokens)}</span>
                  {/if}
                  <span class="sh-time">{formatTime(s.last_modified_secs)}</span>
                </span>
              </div>
              <button class="btn sh-resume" onclick={() => resumeSession(s)} disabled={submitting}>Resume</button>
            </li>
          {/each}
        </ul>
        {#if sessionsHasMore}
          <button class="btn sh-more" onclick={loadMoreSessions} disabled={sessionsLoadingMore}>
            {sessionsLoadingMore ? 'Loading…' : 'More'}
          </button>
        {/if}
      {:else if cwd.trim().startsWith('/')}
        <p class="sh-msg sh-muted">No existing sessions found. Start a new one below.</p>
      {/if}
    </div>

    <div class="actions">
      <button class="btn primary" onclick={() => start()} disabled={submitting || !selected || !cwd.trim()}>
        {submitting ? 'Starting...' : 'New session'}
      </button>
      {#if !submitting && (!selected || !cwd.trim())}
        <span class="disabled-hint">
          {#if !selected}Select a backend first.{:else}Enter a working directory.{/if}
        </span>
      {/if}
    </div>

    <div class="footer">
      <span class="footer-text">
        Configure backends in Settings → Backends · Default cwd: <code>{defaultCwd || '(none)'}</code>
      </span>
    </div>
  </div>
</div>

{#if cwdPickerOpen && selectedEndpoint.kind === 'remote'}
  <RemoteCwdPicker
    endpointId={selectedEndpoint.id}
    initialPath={cwd.trim() || '/'}
    onSubmit={(picked) => {
      cwd = picked
      cwdPickerOpen = false
    }}
    onCancel={() => (cwdPickerOpen = false)}
  />
{/if}

<style>
  .root {
    height: 100%;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--sp-6);
    box-sizing: border-box;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--bg-elevated) 18%, transparent), transparent 48%),
      var(--bg-base);
  }
  .card {
    width: 620px;
    max-width: 100%;
    /* 固定高度 + 内部滚动:任何选择/加载状态都不改变卡片几何 → 不跳变。 */
    height: min(90vh, 760px);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: color-mix(in srgb, var(--bg-elevated) 94%, var(--bg-base));
    border: 1px solid var(--bd-strong);
    border-radius: var(--rad-xl);
    padding: 22px;
    box-shadow: var(--sh-lg);
    color: var(--fg-primary);
    font-family: var(--font-ui);
  }
  .header {
    flex-shrink: 0;
    margin-bottom: var(--sp-4);
  }
  .setup-scroll {
    /* 内容自适应高度;剩余空间交给 .session-history 伸展,不留空白。 */
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    margin-bottom: var(--sp-3);
  }
  .title-row {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
  }
  h1 {
    margin: 0;
    font-size: 20px;
    font-weight: var(--fw-semi);
    color: var(--fg-primary);
    letter-spacing: 0;
  }
  .version {
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
  }
  .hint {
    margin: 6px 0 0 0;
    font-size: var(--fs-sm);
    color: var(--fg-secondary);
  }

  ul {
    list-style: none;
    padding: 0;
    margin: 0 0 var(--sp-3) 0;
  }
  li { margin-bottom: var(--sp-1); }

  /* 通用 backend 行按钮 */
  button {
    width: 100%;
    background: transparent;
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-lg);
    padding: 11px 12px;
    color: var(--fg-primary);
    font: inherit;
    text-align: left;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    transition: border-color var(--t-fast), background var(--t-fast), transform var(--t-fast), box-shadow var(--t-fast);
  }
  button:hover,
  button:focus-visible {
    border-color: color-mix(in srgb, var(--acc) 52%, var(--bd-default));
    background: var(--acc-soft);
    box-shadow: inset 2px 0 0 var(--acc);
    outline: none;
  }
  button:active { transform: scale(0.99); }

  /* backend 下拉 / 路径 / 模型 / 权限字段 */
  .ep-msg {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--fg-secondary);
  }
  .ep-msg.ep-err {
    color: var(--st-err, #ef4444);
  }

  /* === 单视图表单 === */
  .badge {
    margin: 0 0 var(--sp-2);
    font-size: var(--fs-xs);
    color: var(--st-info, #8FD3FF);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid color-mix(in srgb, var(--st-info, #8FD3FF) 36%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--st-info, #8FD3FF) 10%, transparent);
    align-self: flex-start;
    font-family: var(--font-mono);
    letter-spacing: 0.02em;
  }
  .badge::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--st-info, #8FD3FF);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--st-info, #8FD3FF) 24%, transparent);
    flex-shrink: 0;
  }
  .badge code {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }
  .backend-control {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    padding: 0 12px;
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    background: var(--bg-input);
    transition: border-color var(--t-fast), box-shadow var(--t-fast);
  }
  .backend-control:hover {
    border-color: color-mix(in srgb, var(--acc) 40%, var(--bd-default));
  }
  .backend-control:focus-within {
    border-color: var(--acc);
    box-shadow: 0 0 0 3px var(--acc-soft);
  }
  .backend-icon {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    border-radius: var(--rad-sm);
    background: var(--bg-tab-hover);
  }
  .backend-control.empty .backend-icon {
    background: transparent;
    border: 1px dashed var(--bd-default);
  }
  /* 去掉原生 select 的边框与箭头,让整个控件像一个输入框。 */
  .backend-control select {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    padding: 9px 0;
    appearance: none;
    -webkit-appearance: none;
    color: var(--fg-primary);
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  .backend-control select:focus {
    outline: none;
    border-color: transparent;
  }
  .backend-caret {
    flex-shrink: 0;
    color: var(--fg-tertiary);
    font-size: 10px;
    pointer-events: none;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field-label-row {
    min-height: 22px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .model-refresh {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--rad-sm);
    background: transparent;
    color: var(--fg-tertiary);
    font-size: 16px;
    line-height: 1;
  }
  .model-refresh:hover:not(:disabled),
  .model-refresh:focus-visible {
    border-color: var(--bd-default);
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
    box-shadow: none;
  }
  .model-refresh:disabled { opacity: .45; }
  .model-refresh .spinning { animation: model-spin .8s linear infinite; }
  .catalog-status {
    min-height: 12px;
    margin: 0;
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .catalog-status.error { color: var(--st-warn); }
  .start-error {
    display: grid;
    gap: 4px;
    margin: 0 0 var(--sp-4);
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--st-err, #ef4444) 34%, transparent);
    border-radius: var(--rad-md);
    background: color-mix(in srgb, var(--st-err, #ef4444) 8%, var(--bg-elevated));
    color: var(--fg-secondary);
    font-size: var(--fs-sm);
  }
  .start-error strong { color: var(--st-err, #ef4444); }
  .start-error small { color: var(--fg-tertiary); }
  @keyframes model-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .model-refresh .spinning { animation: none; } }
  label {
    font-size: var(--fs-xs);
    font-weight: var(--fw-med);
    color: var(--fg-secondary);
    text-transform: uppercase;
    letter-spacing: 0;
  }
  .cwd-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  input[type="text"] {
    flex: 1;
    background: var(--bg-input);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    padding: 8px 10px;
    color: var(--fg-primary);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    min-width: 0;
  }
  input[type="text"]:focus {
    outline: none;
    border-color: var(--acc);
  }
  select {
    background: var(--bg-input);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    padding: 8px 10px;
    color: var(--fg-primary);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  select:focus {
    outline: none;
    border-color: var(--acc);
  }
  .model-custom {
    margin-top: 4px;
  }
  .hint-line {
    margin: 0;
    font-size: 11px;
    color: var(--fg-tertiary);
  }
  .hint-line code {
    font-family: var(--font-mono);
    color: var(--fg-secondary);
    font-size: 10.5px;
  }

  /* cwd combobox 样式已移到 Combobox.svelte 组件内 */

  .toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    cursor: pointer;
    padding: 6px 0;
    font-size: var(--fs-sm);
    color: var(--fg-primary);
    text-transform: none;
    letter-spacing: 0;
    font-weight: var(--fw-med);
  }
  .toggle input[type="checkbox"] {
    width: 16px; height: 16px;
    accent-color: var(--acc);
    cursor: pointer;
  }
  .toggle-label {
    user-select: none;
  }

  .actions {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }
  .disabled-hint {
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
  }
  .btn {
    border: 1px solid var(--bd-default);
    background: transparent;
    color: var(--fg-secondary);
    padding: 6px 16px;
    font-size: var(--fs-sm);
    border-radius: var(--rad-md);
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast);
    width: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .btn:hover { background: var(--bg-tab-hover); color: var(--fg-primary); }
  .btn.primary {
    background: var(--acc);
    color: var(--fg-on-accent);
    border-color: var(--acc);
    font-weight: var(--fw-med);
  }
  .btn.primary:hover { filter: brightness(1.1); }
  .btn:disabled {
    opacity: .5;
    cursor: default;
  }
  .btn:disabled:hover {
    background: transparent;
    color: var(--fg-secondary);
    filter: none;
  }
  .btn.primary:disabled,
  .btn.primary:disabled:hover {
    background: var(--acc);
    color: var(--fg-on-accent);
    filter: none;
  }

  /* === session history === */
  .session-history {
    border-top: 1px solid var(--bd-default);
    padding-top: var(--sp-2);
    margin-top: var(--sp-1);
    height: 208px;
    min-height: 208px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* 吃掉表单之外的剩余高度:空白变成可多看几条历史的空间,卡片仍固定不跳。 */
    flex-grow: 1;
    flex-shrink: 0;
  }
  .sh-label {
    display: block;
    font-size: var(--fs-xs);
    font-weight: var(--fw-semi);
    color: var(--fg-secondary);
    text-transform: uppercase;
    letter-spacing: 0;
    margin-bottom: var(--sp-1);
  }
  .sh-msg {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--fg-secondary);
  }
  .sh-msg.sh-err {
    color: var(--st-err, #ef4444);
  }
  .sh-msg.sh-muted {
    color: var(--fg-tertiary);
    font-style: italic;
  }
  .sh-list {
    list-style: none;
    padding: 0;
    margin: 0;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .sh-item {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 7px 8px;
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    margin-bottom: var(--sp-1);
    transition: border-color var(--t-fast), background var(--t-fast);
  }
  .sh-item:hover {
    border-color: color-mix(in srgb, var(--acc) 40%, var(--bd-default));
    background: var(--acc-soft);
  }
  .sh-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    cursor: pointer;
    user-select: none;
  }
  .sh-title {
    font-size: var(--fs-sm);
    font-weight: var(--fw-med);
    color: var(--fg-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sh-meta {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
  }
  .sh-model {
    font-family: var(--font-mono);
    color: var(--st-info);
  }
  .sh-tokens {
    color: var(--fg-secondary);
  }
  .sh-time {
    color: var(--fg-tertiary);
  }
  .sh-resume {
    flex-shrink: 0;
    font-size: var(--fs-xs);
    padding: 3px 10px;
  }
  .sh-more {
    width: 100%;
    font-size: var(--fs-xs);
    padding: 4px 10px;
  }

  .footer {
    flex-shrink: 0;
    border-top: 1px solid var(--bd-default);
    padding-top: var(--sp-3);
  }
  .footer-text {
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
  }
  .footer-text code {
    font-family: var(--font-mono);
    color: var(--fg-secondary);
  }
</style>
