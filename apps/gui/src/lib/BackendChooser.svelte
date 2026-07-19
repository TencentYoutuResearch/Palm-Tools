<script lang="ts">
  /**
   * BackendChooser.svelte —— 启动 / 新建 tab 时的后端选择面板。
   *
   * 两阶段:
   *   1. **List 阶段**:
   *      - **本地 backends** 单层列表,数字键 1..9 quick-pick(直接 Start)
   *      - **远端 endpoints** 折叠分组,展开后 lazy 拉远端 backend 列表(11.5)
   *      点 backend 行 → 进入 Configure 阶段
   *   2. **Configure 阶段**:展开 cwd 输入(Browse 仅 Local 可用)+ bypass toggle
   *      + Start/Back/Cancel
   *
   * 默认值:
   *   - cwd 预填全局 session_cwd(从 ipc.getPathsConfig)— **仅 Local**;
   *     Remote backend 不预填(server 端的"默认 cwd"由用户手填或留空让 server 兜底)
   *   - bypass = false(default mode)
   *
   * 行为约束:
   *   - cwd 不验证目录存在(后端 spawn 失败再报错;给用户写到尚未存在路径的自由)
   *   - Local Browse 走 @tauri-apps/plugin-dialog 的 open({ directory: true })
   *   - Remote 不能调本地 dialog;Phase 11.5.4 加 RemoteCwdPicker 走 fs.list 协议
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
  import { onMount, onDestroy } from 'svelte'
  import { open } from '@tauri-apps/plugin-dialog'
  import RemoteCwdPicker from './RemoteCwdPicker.svelte'
  import Combobox from './Combobox.svelte'
  import BackendIcon from './BackendIcon.svelte'

  type Props = {
    backends: BackendInfo[]
    /// 提交回调。
    /// quick-pick(1..9 数字键)时 cwd 仍是预填的默认,permissionMode = 'default',model = undefined。
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
    }) => void | Promise<void>
  }
  let { backends, onSubmit }: Props = $props()

  type Phase = 'list' | 'configure'
  let phase: Phase = $state('list')

  /// 选中的 backend + 它属于的 endpoint(Local 或 Remote)。
  /// configure / start 都看这两个。
  let selected: BackendInfo | null = $state(null)
  let selectedEndpoint: EndpointId = $state(ENDPOINT_LOCAL)

  let cwd = $state('')
  let bypass = $state(false)
  let submitting = $state(false)
  let defaultCwd = $state('') // 从 PathsConfig 拉的全局默认,用于 reset 按钮(仅 Local)

  // cwd 历史(top 5):进入 configure 阶段时按 bucket 拉。
  // 本地 bucket = 'local';远端 bucket = endpoint_id。
  // 点历史项 → 填进 cwd 输入框(不自动 start,用户可能还要改 model/mode)。
  let cwdHistory: string[] = $state([])

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
        : await ipc.discoverBackendModels(b.key)
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
    if (!customModelAllowed && selectedModelValue === '__custom__') selectedModelValue = ''
    modelNotice = result.warning ?? ''
  }

  // Phase 11.5:远端 endpoints + 每个 endpoint 的展开/loading/backends 状态。
  // 第一次展开才拉(lazy);折叠后缓存保留,再展开直接显示(同一打开周期内)。
  let endpoints = $state<EndpointSummary[]>([])
  let endpointError = $state('') // 拉 endpoint 列表失败
  let endpointRefreshHandler: (() => void) | null = null
  type RemoteState = {
    expanded: boolean
    loading: boolean
    error: string
    backends: RemoteBackendInfo[]
  }
  let remoteStates = $state<Record<string, RemoteState>>({})

  // Phase 11.5.4:RemoteCwdPicker 的 open 标志 + 起始路径。
  // 仅 selectedEndpoint.kind === 'remote' 时可弹。
  let cwdPickerOpen = $state(false)

  // session 历史列表:进入 configure 阶段后,输入 cwd 自动查询
  let sessions = $state<SessionSummary[]>([])
  let sessionsLoading = $state(false)
  let sessionsError = $state('')
  let sessionsFetchId = 0 // 递增 id,防止竞态(旧的 fetch 回来后覆盖新结果)

  /// 当 cwd 变化时(debounce 500ms)查询该目录下的历史 session。
  /// Local 直接扫本机 jsonl;Remote 通过 endpoint 协议扫 server 侧 jsonl。
  $effect(() => {
    const dir = cwd.trim()
    const key = selected?.key
    const ep = selectedEndpoint
    // 只有 configure 阶段 + 有 backend 和绝对 cwd 才查
    if (phase !== 'configure' || !key || !dir || !dir.startsWith('/')) {
      sessions = []
      sessionsError = ''
      return
    }
    const fetchId = ++sessionsFetchId
    sessionsLoading = true
    sessionsError = ''
    const timer = setTimeout(async () => {
      try {
        const result = ep.kind === 'remote'
          ? await endpointIpc.listSessionsForCwd(ep.id, key, dir)
          : await ipc.listSessionsForCwd(key, dir)
        if (fetchId === sessionsFetchId) {
          sessions = result
          sessionsLoading = false
        }
      } catch (e) {
        if (fetchId === sessionsFetchId) {
          sessionsError = String(e)
          sessionsLoading = false
        }
      }
    }, 500)
    return () => clearTimeout(timer)
  })

  /// 进入 configure 阶段时拉对应 bucket 的 cwd 历史(top 5)。
  /// 远端 bucket = endpoint_id;本地 bucket = 'local'。
  $effect(() => {
    if (phase !== 'configure') {
      cwdHistory = []
      return
    }
    const bucket = currentBucket()
    let cancelled = false
    void bucket // 依赖
    cwdHistoryIpc
      .get(bucket)
      .then((list) => {
        if (!cancelled) cwdHistory = list
      })
      .catch(() => {
        if (!cancelled) cwdHistory = []
      })
    return () => {
      cancelled = true
    }
  })

  async function refreshEndpoints() {
    try {
      endpoints = await endpointIpc.list()
      endpointError = ''
    } catch (e) {
      endpointError = String(e)
    }
  }

  // 每次进入 chooser 都拉一次最新默认 cwd —— 用户可能在 PathsBanner 里改过
  onMount(async () => {
    try {
      const cfg = await ipc.getPathsConfig()
      defaultCwd = cfg.session_cwd ?? ''
      cwd = defaultCwd
    } catch (e) {
      console.warn('getPathsConfig failed:', e)
    }
    // 拉远端 endpoints — 没有 endpoint 也没事,UI 这块不渲染。
    await refreshEndpoints()
    endpointRefreshHandler = () => {
      void refreshEndpoints()
    }
    window.addEventListener('kode:endpoints-changed', endpointRefreshHandler)
  })

  function pickBackend(b: BackendInfo, ep: EndpointId, initialCwd?: string | null) {
    selected = b
    selectedEndpoint = ep
    bypass = false
    // Local 用全局 default cwd 预填;Remote 只使用远端协议返回的 default_cwd。
    // 不能把本机 session_cwd 塞给 Remote:两台机器路径空间通常不一致。
    cwd = ep.kind === 'local' ? defaultCwd : (initialCwd?.trim() ?? '')
    modelOptions = modelsFor(b.key)
    modelLoading = false
    modelNotice = ''
    modelSource = 'compatibility presets'
    customModelAllowed = true
    selectedModelValue = ''
    customModel = ''
    phase = 'configure'
    void probeModels(b, ep)
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
      await onSubmit(opts)
    } finally {
      submitting = false
    }
  }

  function quickStart(b: BackendInfo) {
    if (submitting) return
    // 1..9 数字键直接启动:用全局默认 cwd / default mode / 不指定 model,跳过 Configure
    // **只对本地 backend 有效** — 远端 backend 没快捷键(也不预填 cwd)
    void submitOnce({
      backendKey: b.key,
      cwd: defaultCwd || undefined,
      permissionMode: 'default',
      endpointId: ENDPOINT_LOCAL,
    })
  }

  async function toggleEndpoint(ep: EndpointSummary) {
    const cur = remoteStates[ep.id]
    if (cur?.expanded) {
      remoteStates[ep.id] = { ...cur, expanded: false }
      return
    }
    // 展开:若已有缓存的 backends 直接复用;否则 lazy fetch
    if (cur?.backends && cur.backends.length > 0) {
      remoteStates[ep.id] = { ...cur, expanded: true }
      return
    }
    remoteStates[ep.id] = {
      expanded: true,
      loading: true,
      error: '',
      backends: [],
    }
    try {
      const list = await endpointIpc.getRemoteBackends(ep.id)
      // 过滤掉远端 server 报告 disabled 的 backend。
      // `b.enabled !== false`:旧 server 不返回 enabled 字段 → 视为开启(向后兼容)。
      const visible = list.filter((b) => b.enabled !== false)
      remoteStates[ep.id] = {
        expanded: true,
        loading: false,
        error: '',
        backends: visible,
      }
    } catch (e) {
      remoteStates[ep.id] = {
        expanded: true,
        loading: false,
        error: String(e),
        backends: [],
      }
    }
  }

  function pickRemoteBackend(epId: string, b: RemoteBackendInfo) {
    // RemoteBackendInfo → BackendInfo 适配(model_catalog 用 b.key 做 lookup;
    // 远端不知道 default_model,留空让 BackendChooser 自动给一个安全默认)
    const adapted: BackendInfo = {
      key: b.key,
      command: '(remote)',
      default_model: null,
      model_flag: b.model_flag ?? '--model',
    }
    pickBackend(adapted, endpointRemote(epId), b.default_cwd)
  }

  function back() {
    phase = 'list'
    selected = null
    selectedEndpoint = ENDPOINT_LOCAL
  }

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
    // 把这次用的 cwd 推进历史(top 5,去重)。失败不阻塞 start,
    // 毕竟历史只是便利功能,不该影响主流程。
    if (finalCwd) {
      cwdHistoryIpc
        .push(currentBucket(), finalCwd)
        .catch((e) => console.warn('cwd_history_push failed:', e))
    }
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
    if (phase === 'list') {
      if (submitting) return
      // 数字键 1..9 quick pick — 仅对**本地 backends** 启用
      if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const i = Number(e.key) - 1
        const b = backends[i]
        if (b) {
          e.preventDefault()
          quickStart(b)
        }
      }
    } else if (phase === 'configure') {
      if (submitting) return
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // 焦点不在按钮上时,Enter 也提交
        if ((e.target as HTMLElement)?.tagName !== 'BUTTON') {
          e.preventDefault()
          start()
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        back()
      }
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
        <h1>{phase === 'list' ? 'New session' : `Configure ${selected?.key}`}</h1>
        <span class="version">v0.2-dev</span>
      </div>
      <p class="hint">
        {#if phase === 'list'}
          Choose a backend, or press <kbd>1..9</kbd> to start with defaults
        {:else if selectedEndpoint.kind === 'remote'}
          Set <strong>remote</strong> working directory (absolute path on the server) and start
        {:else}
          Set working directory and permission mode, then press <kbd>Enter</kbd> to start
        {/if}
      </p>
    </div>

    {#if phase === 'list'}
      <!-- ======================== Local backends ======================== -->
      <h2 class="section">Local</h2>
      {#if backends.length === 0}
        <div class="empty">
          <strong>No backend configured</strong>
          <span>Edit <code>~/.config/kode/config.toml</code> to add one.</span>
        </div>
      {:else}
        <ul>
          {#each backends as b, i (b.key)}
            <li>
              <button onclick={() => pickBackend(b, ENDPOINT_LOCAL)}>
                <BackendIcon backendKey={b.key} command={b.command} size={20} />
                <div class="entry-main">
                  <span class="key">{b.key}</span>
                  {#if b.command && b.command !== b.key}
                    <code class="cmd">{b.command}</code>
                  {/if}
                </div>
                <div class="entry-side">
                  {#if b.default_model}
                    <span class="model">{b.default_model}</span>
                  {/if}
                  <kbd class="hotkey">{i + 1}</kbd>
                </div>
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      <!-- ======================== Remote endpoints ======================== -->
      {#if endpoints.length > 0}
        <h2 class="section">Remote</h2>
        <ul class="endpoints">
          {#each endpoints as ep (ep.id)}
            {@const st = remoteStates[ep.id]}
            <li class="endpoint">
              <button class="endpoint-row" onclick={() => toggleEndpoint(ep)}>
                <span class="status-dot" class:on={ep.connected}></span>
                <span class="ep-name">{ep.display_name}</span>
                <code class="ep-url">{ep.base_url}</code>
                <span class="ep-toggle">{st?.expanded ? '▾' : '▸'}</span>
              </button>
              {#if st?.expanded}
                <div class="ep-body">
                  {#if st.loading}
                    <p class="ep-msg">loading…</p>
                  {:else if st.error}
                    <p class="ep-msg ep-err">{st.error}</p>
                  {:else if st.backends.length === 0}
                    <p class="ep-msg ep-muted">no backends configured on this endpoint</p>
                  {:else}
                    <ul class="ep-backends">
                      {#each st.backends as b (b.key)}
                        <li>
                          <button onclick={() => pickRemoteBackend(ep.id, b)}>
                            <BackendIcon backendKey={b.key || b.display_name} size={18} />
                            <div class="entry-main">
                              <span class="key">{b.key}</span>
                              {#if b.default_cwd}
                                <code class="cmd">{b.default_cwd}</code>
                              {/if}
                            </div>
                          </button>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if endpointError}
        <p class="ep-msg ep-err">{endpointError}</p>
      {/if}
    {:else if phase === 'configure' && selected}
      <div class="configure">
        {#if selectedEndpoint.kind === 'remote'}
          <p class="badge">via <code>{selectedEndpoint.id}</code> (remote)</p>
        {/if}

        <div class="field">
          <label for="cwd-input">Working directory</label>
          <div class="cwd-row">
            <Combobox
              id="cwd-input"
              bind:value={cwd}
              options={cwdHistory}
              placeholder={selectedEndpoint.kind === 'remote'
                ? '/home/dev/code (server-side absolute path)'
                : (defaultCwd || '/absolute/path')}
            />
            <button class="btn ghost" onclick={browseCwd}>Browse…</button>
          </div>
          <p class="hint-line">
            {#if selectedEndpoint.kind === 'remote'}
              Path on the remote server. Leave empty to use the server's default cwd.
            {:else}
              New session's cwd. <code>{selected.command}</code> will run here.
            {/if}
          </p>
        </div>

        <div class="field">
          <div class="field-label-row">
            <label for="model-select">Model</label>
            <button class="model-refresh" type="button" disabled={modelLoading} aria-label="Refresh available models" title="Refresh available models" onclick={() => void probeModels(selected!, selectedEndpoint, true)}>
              <span class:spinning={modelLoading}>↻</span>
            </button>
          </div>
          <select
            id="model-select"
            value={selectedModelValue}
            onchange={(e) => (selectedModelValue = (e.target as HTMLSelectElement).value)}
          >
            <option value="">Use backend default</option>
            {#each modelOptions as m (m.value)}
              <option value={m.value}>{m.label}</option>
            {/each}
            {#if customModelAllowed}<option value="__custom__">Custom…</option>{/if}
          </select>
          {#if selectedModelValue === '__custom__'}
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
            {modelHint(selected)}
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
              onchange={(e) => (bypass = (e.target as HTMLInputElement).checked)}
            />
            <span class="toggle-label">Bypass permissions</span>
          </label>
          <p class="hint-line">
            Skip permission prompts when the selected backend supports a bypass launch mode.
          </p>
        </div>

        {#if selectedEndpoint.kind === 'local' || selectedEndpoint.kind === 'remote'}
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
            {:else if cwd.trim().startsWith('/')}
              <p class="sh-msg sh-muted">No existing sessions found. Start a new one below.</p>
            {/if}
          </div>
        {/if}

        <div class="actions">
          <button class="btn primary" onclick={() => start()} disabled={submitting}>
            {submitting ? 'Starting...' : 'New session'}
          </button>
          <button class="btn ghost" onclick={back} disabled={submitting}>Back</button>
        </div>
      </div>
    {/if}

    <div class="footer">
      <span class="footer-text">
        {#if phase === 'list'}
          Configure backends in <code>~/.config/kode/config.toml</code> · Manage remotes via Cmd+P → "Remote endpoints…"
        {:else if selectedEndpoint.kind === 'remote'}
          Remote endpoint: <code>{selectedEndpoint.id}</code>
        {:else}
          Default cwd: <code>{defaultCwd || '(none)'}</code>
        {/if}
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
    max-height: 90vh;
    overflow-y: auto;
    background: color-mix(in srgb, var(--bg-elevated) 94%, var(--bg-base));
    border: 1px solid var(--bd-strong);
    border-radius: var(--rad-xl);
    padding: 22px;
    box-shadow: var(--sh-lg);
    color: var(--fg-primary);
    font-family: var(--font-ui);
  }
  .header {
    margin-bottom: var(--sp-4);
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
  .hint kbd {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    padding: 1px 6px;
    border-radius: var(--rad-sm);
    background: var(--bg-tab-hover);
    border: 1px solid var(--bd-default);
    color: var(--fg-secondary);
  }

  /* 分组标题(Local / Remote) */
  .section {
    margin: 18px 0 8px;
    font-size: var(--fs-xs);
    font-weight: var(--fw-semi);
    color: var(--fg-secondary);
    text-transform: uppercase;
    letter-spacing: 0;
  }
  .section:first-of-type {
    margin-top: 0;
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

  .entry-main {
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
    min-width: 0;
    flex: 1 1 auto;
  }
  .entry-side {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-shrink: 0;
  }
  .key {
    font-weight: var(--fw-semi);
    color: var(--fg-primary);
    font-size: var(--fs-md);
  }
  .cmd {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--fg-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .model {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--st-info);
  }
  .hotkey {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: var(--rad-md);
    background: var(--bg-tab-hover);
    color: var(--fg-secondary);
    font-size: var(--fs-xs);
    font-family: var(--font-mono);
    border: 1px solid var(--bd-default);
  }
  .empty {
    color: var(--fg-secondary);
    font-size: var(--fs-sm);
    padding: var(--sp-3);
    border: 1px dashed var(--bd-default);
    border-radius: var(--rad-lg);
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    margin-bottom: var(--sp-3);
  }
  .empty strong { color: var(--st-warn); }

  /* === remote endpoint 折叠分组 === */
  .endpoints {
    margin: 0;
  }
  .endpoint {
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-lg);
    margin-bottom: var(--sp-2);
    overflow: hidden;
  }
  .endpoint > .endpoint-row {
    border: none;
    border-radius: 0;
  }
  .endpoint-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fg-tertiary);
    flex-shrink: 0;
  }
  .status-dot.on {
    background: var(--st-ok, #4ade80);
  }
  .ep-name {
    font-weight: var(--fw-semi);
    flex-shrink: 0;
  }
  .ep-url {
    flex: 1;
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ep-toggle {
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
    width: 16px;
    text-align: center;
  }
  .ep-body {
    padding: var(--sp-2) var(--sp-3) var(--sp-2);
    background: color-mix(in srgb, var(--bg-base) 88%, var(--bg-elevated));
    border-top: 1px solid var(--bd-default);
  }
  .ep-backends {
    margin: 0;
  }
  .ep-backends li {
    margin-bottom: 4px;
  }
  .ep-backends button {
    padding: var(--sp-2);
  }
  .ep-msg {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--fg-secondary);
  }
  .ep-msg.ep-err {
    color: var(--st-err, #ef4444);
  }
  .ep-msg.ep-muted {
    color: var(--fg-tertiary);
  }

  /* === configure 阶段 === */
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
  .configure {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    margin-bottom: var(--sp-3);
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
    display: flex;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
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

  /* === session history === */
  .session-history {
    border-top: 1px solid var(--bd-default);
    padding-top: var(--sp-2);
    margin-top: var(--sp-1);
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
    max-height: 220px;
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

  .footer {
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
