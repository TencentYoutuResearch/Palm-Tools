<script lang="ts">
  /**
   * MemoryBrowsePanel.svelte —— Phase 10.9-13:浏览/搜索已 approve 的 fact。
   *
   * 触发:命令面板"Memory: Browse facts…"或快捷键 Cmd+Shift+B(在 App.svelte 注册)。
   *
   * 与 MemoryPanel(待审队列)的关系:
   *   - MemoryPanel 是写入路径(review queue)
   *   - MemoryBrowsePanel 是读取路径(已 approve 池)
   *   两者各自是独立模态,不共享状态;CommandPalette 各自有入口。
   *
   * 布局:左侧搜索 + filter,中间结果列表(snippet/score),右侧 MemoryFactDetail
   * (复用 fact + backlinks 渲染)。
   *
   * 反馈环:点击 hit → 调 memory_bump_recall → 后台聚合 task 把 click 写进
   * facts.recall_clicked_count_30d → 同 query 下次该 fact 排名上升。
   */
  import { onMount, onDestroy } from 'svelte'
  import {
    endpointIpc,
    memoryIpc,
    type EndpointSummary,
    type MemorySearchHit,
    type MemorySearchArgs,
  } from './ipc'
  import Icon from './Icon.svelte'
  import MemoryFactDetail from './MemoryFactDetail.svelte'
  import { formatLocalDateMedium, formatLocalDateTimeFull } from './time'
  import { t } from './i18n'
  import { outsidePressClose } from './outside_close'

  type Props = {
    onClose: () => void
    /** 默认 scope(由 App.svelte 的 memoryScope 传入) */
    defaultScope?: string
    /** 持久化回调:filter 变化时父组件存到 PersistedState */
    onFilterChange?: (state: BrowseFilterState) => void
    /** 初始 filter(从 PersistedState 恢复) */
    initialFilter?: BrowseFilterState
  }
  export type BrowseFilterState = {
    last_scope: string | null
    last_kinds: string[]
    include_deprecated: boolean
  }
  let {
    onClose,
    defaultScope = '',
    onFilterChange,
    initialFilter,
  }: Props = $props()

  // ── filter 状态 ────────────────────────────────────────────────────
  // initialFilter / defaultScope 只取初始快照:面板打开后由用户在 UI 改,
  // 不应被父组件后续变化覆盖。
  let query = $state('')
  // svelte-ignore state_referenced_locally
  let scope = $state(initialFilter?.last_scope ?? defaultScope ?? '')
  // svelte-ignore state_referenced_locally
  let kinds = $state<string[]>(initialFilter?.last_kinds ?? [])
  let subsystem = $state('')
  // svelte-ignore state_referenced_locally
  let includeDeprecated = $state(initialFilter?.include_deprecated ?? false)

  // ── 来源选择(local / all / remote:<id>)─────────────────────────────
  // 'all' = 聚合本地 + 所有已配置远端;'local' = 仅本地;'remote:<id>' = 单远端
  let endpoints = $state<EndpointSummary[]>([])
  let sourceSel = $state<'all' | 'local' | string>('local')
  /// 各远端拉取失败的局部提示(失败隔离,不整体清空)
  let sourceErrors = $state<{ label: string; detail: string }[]>([])

  /** 「按项目过滤」下拉的可选 scope 列表(去掉 shared,project:* 排序) */
  let projectScopes = $state<string[]>([])

  let hits: MemorySearchHit[] = $state([])
  let searching = $state(false)
  let selectedId: string | null = $state(null)
  let lastErr: string | null = $state(null)
  /** 当前列表是否来自 list_recent(空 query 兜底)— 影响顶部提示文案 */
  let isRecentMode = $state(false)
  let timer: number | null = null
  let toast: { kind: 'ok' | 'err'; msg: string } | null = $state(null)
  let toastTimer: number | null = null
  /** scope 编辑态 */
  let scopeEditMode = $state(false)
  let scopeEditValue = $state('')

  /** 给 onLink 切换详情 */
  function gotoFact(id: string) {
    selectedId = id
    // 也尝试加入结果列表头(若没在)
    if (!hits.find((h) => h.id === id)) {
      // best-effort:再触发一次搜索把它捞出来
      // 简化:不做,用户能看到详情就行
    }
  }

  function showToast(kind: 'ok' | 'err', msg: string) {
    toast = { kind, msg }
    if (toastTimer != null) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => (toast = null), 2200)
  }

  // MCP memory 的 5 种 kind(对应 kode-memory 的 Kind enum)。
  // 注意:feedback/project/reference 是 file-based auto-memory 的体系,MCP fact 不会命中,故不列。
  const ALL_KINDS = ['gotcha', 'invariant', 'recipe', 'dead_end', 'preference']

  async function loadScopes() {
    try {
      const all = await memoryIpc.listScopes()
      // 下拉只放 project:* 选项(shared / All 作为固定项另列),按字典序
      projectScopes = all.filter((s) => s.startsWith('project:')).sort()
    } catch {
      projectScopes = []
    }
  }

  function toggleKind(k: string) {
    if (kinds.includes(k)) {
      kinds = kinds.filter((x) => x !== k)
    } else {
      kinds = [...kinds, k]
    }
  }

  $effect(() => {
    // 持久化 filter(scope/kinds/include_deprecated 变化时)
    const _q = query   // 不参与持久化但需要触发,留意以免收敛
    void _q
    onFilterChange?.({
      last_scope: scope || null,
      last_kinds: kinds,
      include_deprecated: includeDeprecated,
    })
  })

  $effect(() => {
    // 任何 filter 变化 → debounce 200ms 后搜
    void query
    void scope
    void kinds
    void subsystem
    void includeDeprecated
    void sourceSel
    if (timer != null) window.clearTimeout(timer)
    timer = window.setTimeout(doSearch, 200)
  })

  /// 当前选中来源要拉哪些 endpoint(空数组 = 仅本地)。
  function selectedRemoteEndpoints(): EndpointSummary[] {
    if (sourceSel === 'local') return []
    if (sourceSel === 'all') return endpoints
    const id = sourceSel.replace(/^remote:/, '')
    return endpoints.filter((e) => e.id === id)
  }

  function wantLocal(): boolean {
    return sourceSel === 'all' || sourceSel === 'local'
  }

  /// 客户端过滤(list_recent / 远端结果不支持服务端 kind/subsystem 过滤)
  function clientFilter(arr: MemorySearchHit[]): MemorySearchHit[] {
    let r = arr
    if (kinds.length > 0) r = r.filter((h) => kinds.includes(h.kind))
    if (subsystem.trim()) r = r.filter((h) => h.subsystem === subsystem.trim())
    return r
  }

  async function doSearch() {
    searching = true
    lastErr = null
    const errs: { label: string; detail: string }[] = []
    const recentMode = !query.trim()
    isRecentMode = recentMode
    const merged: MemorySearchHit[] = []

    // 本地分支
    const localTask = (async () => {
      if (!wantLocal()) return true
      try {
        if (recentMode) {
          const recent = await memoryIpc.listRecent({ scope: scope || undefined, limit: 20 })
          for (const h of clientFilter(recent)) merged.push({ ...h, origin: { kind: 'local' } })
        } else {
          const args: MemorySearchArgs = {
            query: query.trim(),
            top_k: 50,
            include_deprecated: includeDeprecated,
          }
          if (scope) args.scope = scope
          if (kinds.length > 0) args.kinds = kinds
          if (subsystem.trim()) args.subsystem = subsystem.trim()
          const r = await memoryIpc.search(args)
          for (const h of r) merged.push({ ...h, origin: { kind: 'local' } })
        }
        return true
      } catch (e) {
        errs.push({ label: t('memory.common.local'), detail: String(e) })
        return false
      }
    })()

    // 远端分支(各自隔离失败)
    const remoteTasks = selectedRemoteEndpoints().map(async (ep) => {
      try {
        const raw = recentMode
          ? await memoryIpc.listRecentRemote(ep.id, scope || undefined, 20)
          : await memoryIpc.searchRemote(ep.id, query.trim(), scope || undefined, 50)
        for (const h of clientFilter(raw))
          merged.push({ ...h, origin: { kind: 'remote', endpointId: ep.id } })
        return true
      } catch (e) {
        errs.push({ label: t('memory.common.remote', { name: ep.display_name || ep.id }), detail: String(e) })
        return false
      }
    })

    const results = await Promise.all([localTask, ...remoteTasks])
    const anyOk = results.some((r) => r)

    // recent 模式按 created 倒序;search 模式按 score 倒序
    merged.sort((a, b) =>
      recentMode
        ? a.created < b.created ? 1 : a.created > b.created ? -1 : 0
        : b.score - a.score,
    )
    hits = merged
    sourceErrors = errs
    lastErr = !anyOk && errs.length > 0 ? errs.map((e) => `${e.label}: ${e.detail}`).join('\n') : null

    if (hits.length > 0 && (!selectedId || !hits.find((h) => h.id === selectedId))) {
      selectedId = hits[0].id
    } else if (hits.length === 0) {
      selectedId = null
    }
    searching = false
  }

  /// 当前选中 hit(用于 detail 路由:本地走 MemoryFactDetail,远端走 inline fallback)
  function selectedHit(): MemorySearchHit | null {
    if (!selectedId) return null
    return hits.find((h) => h.id === selectedId) ?? null
  }

  async function selectHit(h: MemorySearchHit) {
    selectedId = h.id
    // Phase 10.13:点击 = recall 反馈 → 写 SQLite 列 + metrics。仅本地 fact 有此通路。
    if ((h.origin ?? { kind: 'local' }).kind === 'remote') return
    try {
      await memoryIpc.bumpRecall(h.id, query.trim() || undefined)
    } catch {
      // 不阻塞用户
    }
  }

  async function deprecateSelected() {
    if (!selectedId) return
    // 用 inline 输入代替 prompt(WKWebView 限制)
    const reasonEl = document.getElementById('browse-deprecate-reason') as HTMLInputElement | null
    const reason = (reasonEl?.value || '').trim() || 'manually deprecated by user'
    try {
      await memoryIpc.deprecate(selectedId, reason)
      showToast('ok', `deprecated ${selectedId.slice(0, 10)}…`)
      // 重新搜一遍,deprecated 默认不显示
      doSearch()
      if (reasonEl) reasonEl.value = ''
    } catch (e) {
      showToast('err', String(e))
    }
  }

  function startScopeEdit() {
    const currentHit = hits.find((h) => h.id === selectedId)
    scopeEditValue = currentHit?.scope ?? ''
    scopeEditMode = true
    requestAnimationFrame(() => {
      const el = document.getElementById('browse-scope-input')
      if (el) (el as HTMLInputElement).focus()
    })
  }

  function cancelScopeEdit() {
    scopeEditMode = false
    scopeEditValue = ''
  }

  async function saveScope() {
    if (!selectedId) return
    const newScope = scopeEditValue.trim()
    if (!newScope) return
    try {
      await memoryIpc.updateScope(selectedId, newScope)
      // 更新本地 hits 列表里的 scope 显示
      hits = hits.map((h) =>
        h.id === selectedId ? { ...h, scope: newScope } : h,
      )
      scopeEditMode = false
      scopeEditValue = ''
      showToast('ok', `scope → ${newScope}`)
    } catch (e) {
      showToast('err', String(e))
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      // Cmd+K 把焦点移回搜索框
      e.preventDefault()
      const q = document.getElementById('browse-query-input')
      if (q) (q as HTMLInputElement).focus()
    } else if (!e.metaKey && !e.ctrlKey && hits.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'j') {
        if ((e.target as HTMLElement)?.tagName === 'INPUT') return
        e.preventDefault()
        const idx = hits.findIndex((h) => h.id === selectedId)
        const next = hits[Math.min(hits.length - 1, idx + 1)] ?? hits[0]
        if (next) selectHit(next)
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        if ((e.target as HTMLElement)?.tagName === 'INPUT') return
        e.preventDefault()
        const idx = hits.findIndex((h) => h.id === selectedId)
        const prev = hits[Math.max(0, idx - 1)] ?? hits[0]
        if (prev) selectHit(prev)
      }
    }
  }

  onMount(async () => {
    // 先拉 endpoint 列表(给来源下拉),失败不阻塞
    try {
      endpoints = await endpointIpc.list()
    } catch {
      endpoints = []
    }
    // 进来立刻拉 recent — 让用户打开就能看到池子里的东西,不必先输入
    doSearch()
    loadScopes()
    requestAnimationFrame(() => {
      const q = document.getElementById('browse-query-input')
      if (q) (q as HTMLInputElement).focus()
    })
  })

  onDestroy(() => {
    if (timer != null) window.clearTimeout(timer)
    if (toastTimer != null) window.clearTimeout(toastTimer)
  })

  function compactText(s: string | null | undefined): string {
    return (s ?? '').replace(/\s+/g, ' ').trim()
  }

  function cardSource(h: MemorySearchHit): string {
    return compactText(h.body) || compactText(h.snippet) || h.id
  }

  function cardDate(s: string): string {
    return formatLocalDateMedium(s)
  }

  function kindLabel(kind: string): string {
    if (kind === 'dead_end') return 'Dead end'
    return kind.charAt(0).toUpperCase() + kind.slice(1)
  }

  function originLabel(o: MemorySearchHit['origin']): string {
    if (!o || o.kind === 'local') return t('memory.common.local')
    const ep = endpoints.find((e) => e.id === o.endpointId)
    return t('memory.common.remote', { name: ep?.display_name || o.endpointId })
  }

  function groupedHits() {
    const order = ['gotcha', 'invariant', 'recipe', 'dead_end', 'preference']
    const map = new Map<string, MemorySearchHit[]>()
    for (const h of hits) {
      const key = h.kind || 'gotcha'
      map.set(key, [...(map.get(key) ?? []), h])
    }
    return [...map.entries()]
      .sort(([a], [b]) => {
        const ia = order.indexOf(a)
        const ib = order.indexOf(b)
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
      })
      .map(([kind, items]) => ({ kind, items }))
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" use:outsidePressClose={{ onClose }} role="presentation">
  <div class="panel" role="dialog" aria-label={t('memory.browse.title')} tabindex="-1">
    <header class="topbar">
      <Icon name="brain" size="16" />
      <h2 class="topbar-title">{t('memory.browse.title')}</h2>
      <span class="topbar-count">{hits.length}</span>
      <div class="topbar-spacer"></div>
      {#if endpoints.length > 0}
        <select class="scope-select source-select" bind:value={sourceSel} title="Memory source">
          <option value="all">{t('memory.browse.allSources')}</option>
          <option value="local">{t('memory.common.local')}</option>
          {#each endpoints as ep (ep.id)}
            <option value={`remote:${ep.id}`}>{t('memory.common.remote', { name: ep.display_name || ep.id })}</option>
          {/each}
        </select>
      {/if}
      <select class="scope-select" bind:value={scope} title="Filter by project / scope">
        <option value="">{t('memory.browse.allScopes')}</option>
        <option value="shared">shared</option>
        {#each projectScopes as ps}
          <option value={ps}>{ps.replace('project:', '')}</option>
        {/each}
        {#if scope && scope !== 'shared' && !projectScopes.includes(scope)}
          <option value={scope}>{scope.replace('project:', '')}</option>
        {/if}
      </select>
      <button class="x-btn" title={t('memory.common.close')} aria-label={t('memory.common.close')} onclick={onClose}>
        <Icon name="x" size="15" />
      </button>
    </header>

    <div class="search-bar">
      <div class="search-wrap">
        <span class="search-icon"><Icon name="search" size="15" /></span>
        <input
          id="browse-query-input"
          class="search-input"
          bind:value={query}
          placeholder={t('memory.browse.searchPlaceholder')}
          spellcheck="false"
        />
        {#if query}
          <button class="search-clear" onclick={() => (query = '')} aria-label={t('memory.browse.clear')}><Icon name="x" size="12" /></button>
        {/if}
      </div>
      <div class="filter-chips">
        <button class="chip" class:active={kinds.length === 0} onclick={() => (kinds = [])}>{t('memory.browse.allKinds')}</button>
        {#each ALL_KINDS as k}
          <button class="chip {k}" class:active={kinds.includes(k)} onclick={() => toggleKind(k)}>{kindLabel(k)}</button>
        {/each}
      </div>
      <label class="dep" title={t('memory.browse.includeDeprecated')}>
        <input type="checkbox" bind:checked={includeDeprecated} />
        deprecated
      </label>
    </div>

    <div class="body main-split">
      <aside class="memory-list-panel">
        <div class="memory-list">
          {#if sourceErrors.length > 0 && hits.length > 0}
            {#each sourceErrors as se (se.label)}
              <div class="src-error" title={se.detail}>
                <Icon name="alert-triangle" size="12" /> {se.label} unavailable
              </div>
            {/each}
          {/if}
          {#if searching}
            <div class="empty muted">{t('memory.browse.searching')}</div>
          {:else if lastErr}
            <div class="boot-error">{lastErr}</div>
          {:else if hits.length === 0}
            {#if !query.trim()}
              <div class="empty">
                <Icon name="brain" size="28" />
                <span>{t('memory.browse.noFacts')}</span>
                <span class="muted small">
                  Wait for agents to propose, or run<br/>
                  <code>kode-memory init --with-baseline</code>
                </span>
              </div>
            {:else}
              <div class="empty muted">{t('memory.browse.noMatches', { query })}</div>
            {/if}
          {:else}
            {#each groupedHits() as group (group.kind)}
              <div class="type-group">
                <div class="type-group-header">
                  <span class="group-dot {group.kind}"></span>
                  {kindLabel(group.kind)}
                  <span class="group-count">{group.items.length}</span>
                </div>
                {#each group.items as h (h.id)}
                  <button
                    class="memory-card"
                    class:active={h.id === selectedId}
                    onclick={() => selectHit(h)}
                  >
                    <span class="card-rail {h.kind}"></span>
                    <div class="card-text">{cardSource(h)}</div>
                    <div class="card-meta">
                      {#if (h.origin ?? { kind: 'local' }).kind === 'remote'}
                        <span class="card-origin" title={originLabel(h.origin)}>{originLabel(h.origin)}</span>
                      {/if}
                      {#if h.subsystem}<span class="card-sub">{h.subsystem}</span>{/if}
                      {#if h.confidence < 0.7}<span class="card-lowconf" title={t('memory.browse.lowConfidence')}>{h.confidence.toFixed(2)}</span>{/if}
                      <span class="card-date" title={formatLocalDateTimeFull(h.created)}>{cardDate(h.created)}</span>
                    </div>
                  </button>
                {/each}
              </div>
            {/each}
          {/if}
        </div>
      </aside>

      <section class="detail-panel detail">
        {#if selectedId && (selectedHit()?.origin ?? { kind: 'local' }).kind === 'remote'}
          <!-- 远端 hit:没有 read_with_backlinks 通路,用 search hit 字段直接渲染只读详情 -->
          {@const rh = selectedHit()!}
          <div class="remote-detail">
            <div class="remote-detail-head">
              <span class="group-dot {rh.kind}"></span>
              <span class="rd-kind">{kindLabel(rh.kind)}</span>
              <span class="rd-origin">{originLabel(rh.origin)}</span>
            </div>
            <pre class="rd-body">{rh.body || rh.snippet}</pre>
            <div class="rd-meta">
              <span>scope: {rh.scope}</span>
              {#if rh.subsystem}<span>· {rh.subsystem}</span>{/if}
              <span>· conf {rh.confidence.toFixed(2)}</span>
              {#if rh.author}<span>· {rh.author}</span>{/if}
              {#if rh.created}<span title={formatLocalDateTimeFull(rh.created)}>· {formatLocalDateTimeFull(rh.created)}</span>{/if}
            </div>
            {#if rh.tags.length > 0}
              <div class="rd-tags">
                {#each rh.tags as t}<span class="tag-chip">#{t}</span>{/each}
              </div>
            {/if}
            <p class="remote-note">{t('memory.browse.remoteNote')}</p>
          </div>
        {:else if selectedId}
          <MemoryFactDetail factId={selectedId} onLink={gotoFact} />
          <footer class="actions">
            {#if scopeEditMode}
              <div class="scope-edit-row">
                <div class="scope-presets">
                  <button class="preset-btn" onclick={() => (scopeEditValue = 'shared')} title={t('memory.browse.sharedPool')}>shared</button>
                </div>
                <input
                  id="browse-scope-input"
                  class="reason"
                  bind:value={scopeEditValue}
                  placeholder={t('memory.browse.scopePlaceholder')}
                  spellcheck="false"
                  onkeydown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); saveScope() }
                    else if (e.key === 'Escape') { e.preventDefault(); cancelScopeEdit() }
                  }}
                />
                <button class="btn btn-ok" onclick={saveScope}>{t('memory.common.save')}</button>
                <button class="btn" onclick={cancelScopeEdit}>{t('memory.common.cancel')}</button>
              </div>
            {:else}
              <span class="current-scope" title={t('memory.browse.currentScope')}>
                scope: {hits.find((h) => h.id === selectedId)?.scope ?? ''}
              </span>
              <button class="btn" onclick={startScopeEdit}>
                <Icon name="pencil" /> Scope
              </button>
              <input
                id="browse-deprecate-reason"
                class="reason"
                placeholder={t('memory.browse.deprecatePlaceholder')}
                spellcheck="false"
              />
              <button class="btn btn-warn" onclick={deprecateSelected}>
                <Icon name="archive" /> Deprecate
              </button>
            {/if}
          </footer>
        {:else}
          <div class="d-empty muted">{t('memory.browse.selectDetail')}</div>
        {/if}
      </section>
    </div>

    {#if toast}
      <div class="toast toast-{toast.kind}">{toast.msg}</div>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-modal-backdrop);
    backdrop-filter: var(--blur-modal);
    -webkit-backdrop-filter: var(--blur-modal);
    z-index: 1100;
    display: flex;
    justify-content: flex-end;
    animation: fade 120ms ease-out;
  }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .panel {
    width: min(1100px, 94vw);
    height: 100vh;
    background: var(--bg-elevated);
    color: var(--fg-primary);
    display: flex;
    flex-direction: column;
    box-shadow: var(--sh-modal);
    font-family: var(--font-ui);
    animation: slide 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes slide { from { transform: translateX(40px); opacity: 0.6; } to { transform: translateX(0); opacity: 1; } }

  /* ── 顶栏:只留标题 + 计数 + scope + 关闭 ── */
  .topbar {
    flex-shrink: 0;
    height: 48px;
    padding: 0 16px;
    border-bottom: 1px solid var(--bd-default);
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    color: var(--fg-secondary);
  }
  .topbar-title {
    margin: 0;
    font-size: var(--fs-lg);
    font-weight: var(--fw-semi);
    color: var(--fg-primary);
    letter-spacing: -0.01em;
  }
  .topbar-count {
    font-size: var(--fs-xs);
    font-weight: var(--fw-med);
    color: var(--acc);
    background: var(--acc-soft);
    border-radius: 999px;
    padding: 1px 8px;
    min-width: 20px;
    text-align: center;
  }
  .topbar-spacer { flex: 1; }
  .x-btn {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: none;
    color: var(--fg-tertiary);
    border-radius: var(--rad-sm);
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .x-btn:hover { background: var(--bg-hover); color: var(--fg-primary); }
  .scope-select {
    height: 30px;
    width: 150px;
    background: var(--bg-input);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    padding: 0 24px 0 10px;
    font-size: var(--fs-sm);
    font-family: var(--font-ui);
    color: var(--fg-primary);
    outline: none;
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='3'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 9px center;
  }
  .scope-select:focus {
    border-color: var(--bd-focus);
    box-shadow: 0 0 0 3px var(--acc-soft);
  }

  /* ── 搜索栏 ── */
  .search-bar {
    flex-shrink: 0;
    padding: var(--sp-3) 16px;
    border-bottom: 1px solid var(--bd-muted);
    display: flex;
    align-items: center;
    gap: var(--sp-3);
  }
  .search-wrap { flex: 1; position: relative; display: flex; align-items: center; min-width: 0; }
  .search-icon { position: absolute; left: 11px; color: var(--fg-tertiary); pointer-events: none; display: flex; }
  .search-input {
    width: 100%;
    height: 36px;
    background: var(--bg-input);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    padding: 0 32px 0 34px;
    font-size: var(--fs-md);
    color: var(--fg-primary);
    font-family: var(--font-ui);
    outline: none;
    transition: border-color var(--t-fast), box-shadow var(--t-fast);
  }
  .search-input:focus {
    border-color: var(--bd-focus);
    box-shadow: 0 0 0 3px var(--acc-soft);
  }
  .search-input::placeholder { color: var(--fg-tertiary); }
  .search-clear {
    position: absolute;
    right: 8px;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border: none;
    background: var(--bg-chip);
    border-radius: 50%;
    color: var(--fg-tertiary);
    cursor: pointer;
  }
  .search-clear:hover { color: var(--fg-primary); background: var(--bg-hover); }
  .filter-chips { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }
  .chip {
    font-size: var(--fs-sm);
    padding: 4px 11px;
    border-radius: 999px;
    border: 1px solid var(--bd-muted);
    background: transparent;
    color: var(--fg-secondary);
    cursor: pointer;
    font-weight: var(--fw-med);
    transition: all var(--t-fast);
  }
  .chip:hover { border-color: var(--bd-strong); color: var(--fg-primary); }
  /* 选中态:每种 kind 用自己的语义色 */
  .chip.active { color: var(--fg-on-accent); border-color: transparent; }
  .chip.active { background: var(--acc); }
  .chip.gotcha.active, .chip.dead_end.active { background: var(--st-err); }
  .chip.invariant.active, .chip.recipe.active { background: var(--st-ok); }
  .chip.preference.active { background: var(--st-warn); }
  .dep {
    font-size: var(--fs-sm);
    display: flex;
    gap: 5px;
    align-items: center;
    color: var(--fg-tertiary);
    white-space: nowrap;
    cursor: pointer;
  }

  /* ── 主区:列表 + 详情 ── */
  .body.main-split {
    flex: 1;
    min-height: 0;
    display: flex;
    overflow: hidden;
  }
  .memory-list-panel {
    width: 340px;
    flex-shrink: 0;
    border-right: 1px solid var(--bd-default);
    display: flex;
    flex-direction: column;
    background: var(--bg-sidebar);
    overflow: hidden;
  }
  .memory-list { flex: 1; overflow-y: auto; padding: var(--sp-2) var(--sp-2) var(--sp-3); }

  .type-group { margin-bottom: var(--sp-3); }
  .type-group-header {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 8px 4px;
    font-size: 10px;
    font-weight: var(--fw-semi);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-tertiary);
  }
  .group-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: var(--acc); }
  .group-dot.invariant, .group-dot.recipe { background: var(--st-ok); }
  .group-dot.preference { background: var(--st-warn); }
  .group-dot.gotcha, .group-dot.dead_end { background: var(--st-err); }
  .group-count {
    margin-left: auto;
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    font-size: 10px;
  }

  /* 卡片:内容是主角,元信息弱化 */
  .memory-card {
    width: 100%;
    display: block;
    padding: 9px 11px 9px 14px;
    border-radius: var(--rad-md);
    cursor: pointer;
    border: 1px solid transparent;
    margin-bottom: 2px;
    position: relative;
    background: transparent;
    color: inherit;
    text-align: left;
    transition: background var(--t-fast);
  }
  .memory-card:hover { background: var(--bg-hover); }
  .memory-card.active { background: var(--acc-soft); }
  /* 左侧色条:用 kind 语义色,选中/hover 才显 */
  .card-rail {
    position: absolute;
    left: 4px;
    top: 10px;
    bottom: 10px;
    width: 3px;
    border-radius: 999px;
    background: var(--bd-strong);
    opacity: 0;
    transition: opacity var(--t-fast);
  }
  .card-rail.invariant, .card-rail.recipe { background: var(--st-ok); }
  .card-rail.preference { background: var(--st-warn); }
  .card-rail.gotcha, .card-rail.dead_end { background: var(--st-err); }
  .memory-card:hover .card-rail { opacity: 0.5; }
  .memory-card.active .card-rail { opacity: 1; }

  .card-text {
    font-size: var(--fs-md);
    font-weight: var(--fw-med);
    color: var(--fg-primary);
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
  .card-meta {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin-top: 5px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--fg-tertiary);
  }
  .card-sub {
    color: var(--fg-secondary);
    background: var(--bg-chip);
    padding: 1px 6px;
    border-radius: var(--rad-sm);
  }
  .card-lowconf { color: var(--st-warn); }
  .card-date { margin-left: auto; }
  .card-origin {
    color: var(--st-info);
    background: color-mix(in srgb, var(--st-info) 14%, transparent);
    padding: 1px 6px;
    border-radius: var(--rad-sm);
  }
  .source-select { width: 130px; }
  .src-error {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--st-warn);
    background: color-mix(in srgb, var(--st-warn) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--st-warn) 30%, transparent);
    border-radius: var(--rad-sm);
    padding: 4px 8px;
    margin: 2px 4px 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* ── 远端 hit 只读详情 ── */
  .remote-detail { display: flex; flex-direction: column; gap: var(--sp-3); }
  .remote-detail-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: var(--fs-sm);
  }
  .rd-kind { font-weight: var(--fw-semi); color: var(--fg-primary); }
  .rd-origin {
    margin-left: auto;
    font-size: 10px;
    color: var(--st-info);
    background: color-mix(in srgb, var(--st-info) 14%, transparent);
    padding: 1px 8px;
    border-radius: 999px;
  }
  .rd-body {
    margin: 0;
    padding: var(--sp-3);
    background: var(--bg-pre, var(--bg-chip));
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--fg-primary);
  }
  .rd-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    font-size: var(--fs-sm);
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
  }
  .rd-tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .rd-tags .tag-chip {
    background: var(--bg-chip);
    color: var(--fg-secondary);
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-family: var(--font-mono);
  }
  .remote-note {
    margin: 0;
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
    font-style: italic;
  }

  /* ── 详情区 ── */
  .detail-panel {
    flex: 1;
    min-width: 0;
    overflow: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    background: var(--bg-base);
  }
  .actions {
    margin-top: auto;
    padding-top: var(--sp-3);
    border-top: 1px solid var(--bd-muted);
    display: flex;
    gap: var(--sp-2);
    align-items: center;
  }
  .reason {
    flex: 1;
    min-width: 0;
    background: var(--bg-input);
    color: var(--fg-primary);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    padding: 6px 10px;
    font-size: var(--fs-sm);
    outline: none;
  }
  .reason:focus { border-color: var(--bd-focus); box-shadow: 0 0 0 3px var(--acc-soft); }
  .btn {
    background: transparent;
    border: 1px solid var(--bd-default);
    color: var(--fg-secondary);
    border-radius: var(--rad-md);
    padding: 6px 12px;
    font-size: var(--fs-sm);
    font-family: var(--font-ui);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    transition: all var(--t-fast);
  }
  .btn:hover { background: var(--bg-hover); color: var(--fg-primary); }
  .btn-warn { color: var(--st-err); border-color: color-mix(in srgb, var(--st-err) 40%, transparent); }
  .btn-warn:hover { background: color-mix(in srgb, var(--st-err) 10%, transparent); color: var(--st-err); }
  .btn-ok { color: var(--st-ok); border-color: color-mix(in srgb, var(--st-ok) 40%, transparent); }
  .current-scope {
    font-size: var(--fs-sm);
    font-family: var(--font-mono);
    color: var(--fg-tertiary);
    flex-shrink: 0;
  }
  .scope-edit-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 100%;
    flex-wrap: wrap;
  }
  .scope-presets { display: flex; gap: 4px; flex-shrink: 0; }
  .preset-btn {
    background: var(--bg-chip);
    border: 1px solid var(--bd-default);
    color: var(--acc);
    border-radius: var(--rad-sm);
    padding: 4px 9px;
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  .preset-btn:hover { background: var(--bg-hover); }

  /* ── 空态 / 错误 / toast ── */
  .empty, .d-empty {
    padding: 40px 24px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-2);
    color: var(--fg-secondary);
  }
  .empty :global(svg) { color: var(--fg-tertiary); opacity: 0.6; }
  .empty .small { font-size: var(--fs-xs); color: var(--fg-tertiary); line-height: 1.6; }
  .muted { color: var(--fg-tertiary); }
  .empty code {
    background: var(--bg-chip);
    padding: 1px 6px;
    border-radius: var(--rad-sm);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--fg-secondary);
  }
  .d-empty { margin: auto; }
  .boot-error { color: var(--st-err); padding: 16px; font-size: var(--fs-sm); }
  .toast {
    position: absolute;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    padding: 8px 16px;
    border-radius: 999px;
    font-size: var(--fs-sm);
    font-weight: var(--fw-med);
    z-index: 10;
    background: var(--fg-primary);
    color: var(--bg-elevated);
    box-shadow: var(--sh-md);
  }
  .toast-ok { background: var(--st-ok); color: var(--fg-on-accent); }
  .toast-err { background: var(--st-err); color: #fff; }
</style>
