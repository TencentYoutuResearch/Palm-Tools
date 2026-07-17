<script lang="ts">
  /**
   * CLI/model token 灵动岛。数据来自 Rust 对本地历史 JSONL 的聚合，和 tab 生命周期无关。
   */
  import { onMount, onDestroy } from 'svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import type { UnlistenFn } from '@tauri-apps/api/event'
  import Icon from './Icon.svelte'
  import BackendIcon from './BackendIcon.svelte'
  import { ipc, modelMonitorIpc, modelUsageIpc, type ModelUsagePeriod, type ModelUsageSnapshot, type ThemeMode } from './ipc'
  import { formatTokens } from './model_alias'

  const periods: { id: ModelUsagePeriod; label: string }[] = [
    { id: 'today', label: 'Today' },
    { id: 'month', label: 'Month' },
    { id: 'all', label: 'All time' },
  ]

  let open = $state(false)
  let panelMounted = $state(false)
  let panelClosing = $state(false)
  let period: ModelUsagePeriod = $state('today')
  let snapshot = $state<ModelUsageSnapshot | null>(null)
  let todaySnapshot = $state<ModelUsageSnapshot | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let refreshTimer: number | null = null
  let refreshSequence = 0
  let focusUnlisten: UnlistenFn | null = null
  let themeUnlisten: UnlistenFn | null = null
  let resizeSequence = 0
  let hoverTimer: number | null = null
  let monitorPositionTimer: number | null = null

  let islandRoot = $state<HTMLDivElement>()
  const maxTokens = $derived(Math.max(1, ...((snapshot?.rows ?? []).map((row) => row.total_tokens))))
  const backendTotals = $derived.by(() => {
    const totals = new Map<string, number>()
    for (const row of snapshot?.rows ?? []) {
      totals.set(row.backend, (totals.get(row.backend) ?? 0) + row.total_tokens)
    }
    return ['codex', 'claude', 'codebuddy']
      .map((backend) => ({ backend, tokens: totals.get(backend) ?? 0 }))
      .filter((item) => item.tokens > 0)
  })
  const heatMax = $derived(Math.max(1, ...((snapshot?.daily ?? []).map((day) => day.total_tokens))))
  const trendDays = $derived((snapshot?.daily ?? []).slice(-30))
  const trendMax = $derived(Math.max(1, ...trendDays.map((day) => day.total_tokens)))
  const trendPoints = $derived.by(() => trendDays.map((day, index) => {
    const x = trendDays.length <= 1 ? 0 : index / (trendDays.length - 1) * 300
    const y = 48 - (day.total_tokens / trendMax * 42)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' '))

  async function refresh(nextPeriod = period) {
    const sequence = ++refreshSequence
    loading = true
    error = null
    try {
      const next = await modelUsageIpc.snapshot(nextPeriod)
      if (nextPeriod === 'today') todaySnapshot = next
      if (sequence === refreshSequence) snapshot = next
    } catch (cause) {
      if (sequence === refreshSequence) error = String(cause)
    } finally {
      if (sequence === refreshSequence) loading = false
    }
  }

  async function selectPeriod(next: ModelUsagePeriod) {
    if (next === period && snapshot) return
    period = next
    await refresh(next)
  }

  async function setOpen(next: boolean) {
    if (next === open) return
    const sequence = ++resizeSequence
    if (next) {
      try {
        await modelMonitorIpc.setExpanded(true)
      } catch (cause) {
        error = String(cause)
        return
      }
      if (sequence !== resizeSequence) return
      panelClosing = false
      panelMounted = true
      open = true
      void refresh()
      return
    }
    open = false
    panelClosing = true
    window.setTimeout(() => {
      if (sequence !== resizeSequence) return
      panelMounted = false
      panelClosing = false
      void modelMonitorIpc.setExpanded(false)
    }, 360)
  }

  function toggle() {
    clearHoverTimer()
    // hover 已经展开时，点击不应立刻反向折叠，否则会产生一次明显闪烁。
    if (!open) void setOpen(true)
  }

  function clearHoverTimer() {
    if (hoverTimer == null) return
    window.clearTimeout(hoverTimer)
    hoverTimer = null
  }

  function onIslandEnter() {
    clearHoverTimer()
    if (open) return
    // 收缩途中重新进入时立即反向展开，先递增 resizeSequence 取消待执行的
    // native window shrink，避免窗口先缩再放造成一次闪烁。
    if (panelClosing) {
      void setOpen(true)
      return
    }
    hoverTimer = window.setTimeout(() => {
      hoverTimer = null
      void setOpen(true)
    }, 160)
  }

  function onIslandLeave() {
    clearHoverTimer()
    if (!open) return
    hoverTimer = window.setTimeout(() => {
      hoverTimer = null
      void setOpen(false)
    }, 220)
  }

  function applyTheme(theme: ThemeMode) {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
  }

  function onWindowClick(event: MouseEvent) {
    if (islandRoot?.contains(event.target as Node)) return
    if (open) void setOpen(false)
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) {
      event.stopPropagation()
      void setOpen(false)
    }
  }

  function backendLabel(backend: string): string {
    if (backend === 'codebuddy') return 'CodeBuddy'
    if (backend === 'claude') return 'Claude'
    if (backend === 'codex') return 'Codex'
    return backend
  }

  function heatLevel(tokens: number): number {
    if (tokens <= 0) return 0
    return Math.max(1, Math.min(4, Math.ceil(tokens / heatMax * 4)))
  }

  onMount(() => {
    document.documentElement.dataset.window = 'model-monitor'
    void ipc.getTheme().then((theme) => {
      if (theme === 'light' || theme === 'dark' || theme === 'system') applyTheme(theme)
    }).catch(() => {})
    void modelMonitorIpc.onThemeChanged(applyTheme).then((unlisten) => { themeUnlisten = unlisten })
    void refresh('today')
    // macOS 显示器热插拔/主屏切换不会可靠地给透明 status window 发窗口事件，
    // 用低频位置巡检保持灵动岛跟随主窗口所在屏幕，不参与尺寸动画。
    monitorPositionTimer = window.setInterval(() => {
      void modelMonitorIpc.reposition()
    }, 1500)
    refreshTimer = window.setInterval(() => {
      if (period === 'today') void refresh('today')
    }, 60_000)
    void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused && open) void setOpen(false)
    }).then((unlisten) => { focusUnlisten = unlisten })
  })

  onDestroy(() => {
    if (refreshTimer != null) window.clearInterval(refreshTimer)
    if (monitorPositionTimer != null) window.clearInterval(monitorPositionTimer)
    clearHoverTimer()
    focusUnlisten?.()
    themeUnlisten?.()
    delete document.documentElement.dataset.window
  })
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="model-island"
  class:open
  class:expanded-surface={panelMounted}
  class:closing-surface={panelClosing}
  bind:this={islandRoot}
  onmouseenter={onIslandEnter}
  onmouseleave={onIslandLeave}
>
  <button
    type="button"
    class="island-trigger"
    aria-label="Open model token monitor"
    aria-expanded={open}
    title="Model token monitor"
    onclick={toggle}
  >
    <span class="trigger-side trigger-left">
      <span><strong>KODE</strong><small>MODEL TRAFFIC</small></span>
    </span>
    <span class="notch-gap" aria-hidden="true"></span>
    <span class="trigger-side trigger-right">
      <span><strong>{todaySnapshot ? formatTokens(todaySnapshot.totals.total_tokens) : '—'}</strong><small>TODAY</small></span>
    </span>
  </button>

  {#if panelMounted}
    <section
      class="usage-panel"
      class:closing={panelClosing}
      aria-label="Model token monitor"
    >
      <header class="panel-header">
        <div>
          <span class="eyebrow">LOCAL CLI USAGE</span>
          <h2>Model traffic</h2>
        </div>
        <button class="refresh" type="button" title="Refresh usage" aria-label="Refresh usage" onclick={() => refresh()}>
          <Icon name="refresh-cw" size={13} />
        </button>
      </header>

      <div class="period-tabs" role="tablist" aria-label="Usage period">
        {#each periods as item}
          <button
            type="button"
            role="tab"
            aria-selected={period === item.id}
            class:active={period === item.id}
            onclick={() => selectPeriod(item.id)}
          >{item.label}</button>
        {/each}
      </div>

      {#if error}
        <div class="state-message error"><Icon name="alert-triangle" size={14} />{error}</div>
      {:else if !snapshot && loading}
        <div class="state-message">Reading CLI histories…</div>
      {:else if snapshot}
        <div class="totals">
          <div class="total-primary">
            <span>Total tokens</span>
            <strong>{formatTokens(snapshot.totals.total_tokens)}</strong>
          </div>
          <div class="total-cell"><span>Input</span><strong>{formatTokens(snapshot.totals.input_tokens)}</strong></div>
          <div class="total-cell"><span>Output</span><strong>{formatTokens(snapshot.totals.output_tokens)}</strong></div>
          <div class="total-cell"><span>Cached</span><strong>{formatTokens(snapshot.totals.cached_tokens)}</strong></div>
        </div>

        <div class="cli-rail" aria-label="Usage by CLI">
          {#each backendTotals as item (item.backend)}
            <div class="cli-total">
              <BackendIcon backendKey={item.backend} size={14} />
              <span>{backendLabel(item.backend)}</span>
              <strong>{formatTokens(item.tokens)}</strong>
            </div>
          {/each}
        </div>

        <div class="history-visuals">
          <section class="trend" aria-label="Token usage over the last 30 days">
            <header><span>30-day curve</span><strong>{formatTokens(trendDays.reduce((sum, day) => sum + day.total_tokens, 0))}</strong></header>
            <svg viewBox="0 0 300 54" role="img" aria-label="Daily token usage curve">
              <line x1="0" y1="48" x2="300" y2="48"></line>
              <polygon points={`0,48 ${trendPoints} 300,48`}></polygon>
              <polyline points={trendPoints}></polyline>
            </svg>
            <footer><span>{trendDays[0]?.date.slice(5) ?? ''}</span><span>{trendDays.at(-1)?.date.slice(5) ?? ''}</span></footer>
          </section>
          <section class="heatmap" aria-label="Token usage heatmap over the last 12 weeks">
            <header><span>12-week heatmap</span><strong>Daily</strong></header>
            <div class="heat-grid">
              {#each snapshot.daily as day (day.date)}
                <span
                  class="heat-cell level-{heatLevel(day.total_tokens)}"
                  title={`${day.date} · ${formatTokens(day.total_tokens)} tokens`}
                  aria-label={`${day.date}: ${day.total_tokens} tokens`}
                ></span>
              {/each}
            </div>
            <footer><span>12 weeks ago</span><span>Today</span></footer>
          </section>
        </div>

        <div class="model-heading">
          <span>CLI / model</span>
          <span>{snapshot.rows.length} models</span>
        </div>
        <div class="model-list" class:loading aria-busy={loading}>
          {#each snapshot.rows as row (`${row.backend}:${row.model}`)}
            <div class="model-row">
              <span class="backend-icon"><BackendIcon backendKey={row.backend} size={17} /></span>
              <span class="model-copy">
                <span class="model-name"><strong>{row.model}</strong><small>{backendLabel(row.backend)}</small></span>
                <span class="usage-track"><i style={`width:${Math.max(2, row.total_tokens / maxTokens * 100)}%`}></i></span>
                <span class="token-detail">
                  {formatTokens(row.input_tokens)} in · {formatTokens(row.output_tokens)} out
                  {#if row.cached_tokens > 0} · {formatTokens(row.cached_tokens)} cached{/if}
                </span>
              </span>
              <span class="row-total"><strong>{formatTokens(row.total_tokens)}</strong></span>
            </div>
          {:else}
            <div class="empty-state">No model usage found for this period.</div>
          {/each}
        </div>

        <footer class="panel-footer">
          <span>{snapshot.scanned_files} history files scanned</span>
          <span>Codex · Claude · CodeBuddy</span>
        </footer>
      {/if}
    </section>
  {/if}
</div>

<style>
  :global(html[data-window='model-monitor']),
  :global(html[data-window='model-monitor'] body),
  :global(html[data-window='model-monitor'] #app) {
    width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent !important;
  }
  .model-island { position: relative; width: 100%; height: 34px; padding-top: 0; margin: 0 auto; box-sizing: border-box; -webkit-app-region: no-drag; pointer-events: auto; color: var(--fg-primary); }
  .model-island.expanded-surface { height: min(670px, 100%); }
  .island-trigger {
    position: relative; z-index: 3; width: 420px; height: 24px; display: grid; grid-template-columns: 1fr 116px 1fr; align-items: center;
    margin: 0 auto; padding: 0 11px; border: 1px solid var(--bd-default); border-radius: 12px;
    background: color-mix(in srgb, var(--bg-elevated) 96%, transparent); color: var(--fg-primary);
    box-shadow: none; cursor: pointer;
    transition: border-color var(--t-fast), background var(--t-fast), transform var(--t-fast);
  }
  .model-island.expanded-surface .island-trigger {
    border-color: transparent;
    background: transparent;
  }
  .model-island.open .island-trigger {
    animation: island-pill-settle 420ms cubic-bezier(.2,.8,.2,1);
  }
  .model-island.closing-surface .island-trigger {
    animation: island-pill-return 360ms both;
  }
  .island-trigger:hover { border-color: var(--bd-strong); background: var(--bg-elevated); }
  .island-trigger:active { transform: scale(.985); }
  .island-trigger:focus-visible, button:focus-visible { outline: 2px solid var(--bd-focus); outline-offset: 2px; }
  .trigger-side { min-width: 0; display: flex; align-items: center; gap: 8px; }
  .trigger-side > span:last-child { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .trigger-side strong { overflow: hidden; color: var(--fg-primary); font: 650 9px/1 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
  .trigger-side small { color: var(--fg-tertiary); font: 700 6px/1 var(--font-mono); letter-spacing: .1em; white-space: nowrap; }
  .trigger-right { justify-content: flex-end; text-align: right; }
  .trigger-right strong { color: var(--st-tokens); font-size: 10px; }
  .notch-gap { height: 20px; }
  .usage-panel {
    position: absolute; top: 0; left: 50%; width: 620px; transform: translateX(-50%);
    padding: 40px 16px 16px; border: 1px solid var(--bd-strong); border-radius: 18px;
    background: color-mix(in srgb, var(--bg-elevated) 95%, transparent); box-shadow: var(--sh-md);
    backdrop-filter: blur(24px) saturate(1.35); -webkit-backdrop-filter: blur(24px) saturate(1.35);
    z-index: 2; transform-origin: 50% 12px;
    animation: island-unfold 420ms both;
    will-change: clip-path;
  }
  .usage-panel.closing { pointer-events: none; animation: island-fold 360ms both; }
  .panel-header { display: flex; align-items: flex-start; justify-content: space-between; }
  .eyebrow { display: block; margin-bottom: 3px; color: var(--fg-tertiary); font: 700 9px var(--font-mono); letter-spacing: .16em; }
  .panel-header h2 { margin: 0; font-size: 16px; line-height: 1.2; letter-spacing: -.02em; }
  .refresh { width: 28px; height: 28px; display: grid; place-items: center; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--fg-tertiary); cursor: pointer; }
  .refresh:hover { color: var(--fg-primary); background: var(--bg-hover); border-color: var(--bd-muted); }

  .period-tabs { display: inline-flex; gap: 2px; margin: 13px 0 10px; padding: 2px; border: 1px solid var(--bd-muted); border-radius: 8px; background: var(--bg-base); }
  .period-tabs button { padding: 4px 10px; border: 0; border-radius: 5px; background: transparent; color: var(--fg-tertiary); font: 10px var(--font-ui); cursor: pointer; }
  .period-tabs button.active { background: var(--bg-elevated); color: var(--fg-primary); box-shadow: var(--sh-sm); }

  .totals { display: grid; grid-template-columns: 1.35fr repeat(3, 1fr); border: 1px solid var(--bd-muted); border-radius: 11px; overflow: hidden; background: color-mix(in srgb, var(--bg-base) 64%, transparent); }
  .total-primary, .total-cell { min-width: 0; padding: 9px 10px; border-right: 1px solid var(--bd-muted); }
  .total-cell:last-child { border-right: 0; }
  .totals span { display: block; margin-bottom: 4px; color: var(--fg-tertiary); font: 9px var(--font-mono); }
  .totals strong { font: 650 12px var(--font-mono); }
  .total-primary strong { color: var(--st-tokens); font-size: 16px; letter-spacing: -.03em; }

  .cli-rail { display: flex; align-items: center; gap: 6px; margin: 10px 0 12px; overflow-x: auto; }
  .cli-total { flex: 1 0 120px; display: grid; grid-template-columns: 16px 1fr auto; align-items: center; gap: 6px; padding: 6px 8px; border: 1px solid var(--bd-muted); border-radius: 8px; background: var(--bg-chip); }
  .cli-total span { font-size: 10px; color: var(--fg-secondary); }
  .cli-total strong { font: 600 10px var(--font-mono); color: var(--fg-primary); }

  .history-visuals { display: grid; grid-template-columns: 1.12fr .88fr; gap: 12px; margin: 2px 0 14px; }
  .history-visuals section { min-width: 0; }
  .history-visuals header, .history-visuals footer { display: flex; align-items: center; justify-content: space-between; color: var(--fg-tertiary); font: 8px var(--font-mono); }
  .history-visuals header { margin-bottom: 5px; text-transform: uppercase; letter-spacing: .07em; }
  .history-visuals header strong { color: var(--fg-secondary); font-weight: 600; }
  .history-visuals footer { margin-top: 4px; }
  .trend svg { display: block; width: 100%; height: 58px; overflow: visible; }
  .trend line { stroke: var(--bd-muted); stroke-width: 1; }
  .trend polygon { fill: color-mix(in srgb, var(--st-info) 10%, transparent); }
  .trend polyline { fill: none; stroke: var(--st-info); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
  .heat-grid { height: 58px; display: grid; grid-template-rows: repeat(7, 6px); grid-auto-flow: column; grid-auto-columns: 6px; align-content: center; justify-content: space-between; gap: 2px; }
  .heat-cell { display: block; border-radius: 1.5px; background: var(--bd-muted); }
  .heat-cell.level-1 { background: color-mix(in srgb, var(--st-tokens) 24%, var(--bd-muted)); }
  .heat-cell.level-2 { background: color-mix(in srgb, var(--st-tokens) 45%, var(--bd-muted)); }
  .heat-cell.level-3 { background: color-mix(in srgb, var(--st-tokens) 68%, var(--bd-muted)); }
  .heat-cell.level-4 { background: var(--st-tokens); }

  .model-heading { display: flex; justify-content: space-between; padding: 0 3px 6px; color: var(--fg-tertiary); font: 9px var(--font-mono); text-transform: uppercase; letter-spacing: .08em; }
  .model-list { max-height: max(120px, min(290px, calc(100vh - 420px))); overflow-y: auto; border-top: 1px solid var(--bd-muted); transition: opacity var(--t-fast); }
  .model-list.loading { opacity: .55; }
  .model-row { display: grid; grid-template-columns: 28px minmax(0,1fr) auto; gap: 9px; align-items: center; min-height: 58px; padding: 8px 4px; border-bottom: 1px solid var(--bd-muted); }
  .backend-icon { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; background: var(--bg-chip); }
  .model-copy { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .model-name { min-width: 0; display: flex; align-items: baseline; gap: 7px; }
  .model-name strong { overflow: hidden; color: var(--fg-primary); font: 600 11px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
  .model-name small { flex: 0 0 auto; color: var(--fg-tertiary); font-size: 9px; }
  .usage-track { height: 2px; overflow: hidden; border-radius: 2px; background: var(--bd-muted); }
  .usage-track i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--st-info), var(--st-tokens)); }
  .token-detail { overflow: hidden; color: var(--fg-tertiary); font: 8px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
  .row-total { display: flex; flex-direction: column; align-items: flex-end; }
  .row-total strong { color: var(--fg-primary); font: 650 11px var(--font-mono); }
  .empty-state, .state-message { min-height: 90px; display: flex; align-items: center; justify-content: center; gap: 7px; color: var(--fg-tertiary); font-size: 11px; }
  .state-message.error { color: var(--st-err); }
  .panel-footer { display: flex; justify-content: space-between; gap: 12px; padding-top: 10px; color: var(--fg-tertiary); font: 9px var(--font-mono); }

  @keyframes island-unfold {
    0% { clip-path: inset(0 100px calc(100% - 24px) 100px round 999px); }
    38% { clip-path: inset(-3px -4px -8px -4px round 15px); }
    62% { clip-path: inset(2px 3px 4px 3px round 20px); }
    80% { clip-path: inset(-1px -1px -2px -1px round 17px); }
    100% { clip-path: inset(0 round 18px); }
  }
  @keyframes island-fold {
    0% { opacity: 1; clip-path: inset(0 round 18px); }
    22% { opacity: 1; clip-path: inset(0 8px 8% 8px round 19px); }
    45% { opacity: 1; clip-path: inset(0 24px 32% 24px round 22px); }
    65% { opacity: 1; clip-path: inset(0 52px 58% 52px round 28px); }
    82% { opacity: .96; clip-path: inset(0 80px 78% 80px round 40px); }
    100% { opacity: 0; clip-path: inset(0 100px calc(100% - 24px) 100px round 999px); }
  }
  @keyframes island-pill-settle {
    0% { transform: scale(1); }
    30% { transform: scale(.975,.91); }
    58% { transform: scale(1.012,1.035); }
    78% { transform: scale(.996,.985); }
    100% { transform: scale(1); }
  }
  @keyframes island-pill-return {
    0%, 72% { border-color: transparent; background: transparent; }
    88% { border-color: color-mix(in srgb, var(--bd-default) 35%, transparent); background: color-mix(in srgb, var(--bg-elevated) 28%, transparent); }
    100% { border-color: var(--bd-default); background: color-mix(in srgb, var(--bg-elevated) 96%, transparent); }
  }
  @media (prefers-reduced-motion: reduce) {
    .usage-panel, .usage-panel.closing, .model-island.open .island-trigger, .model-island.closing-surface .island-trigger { animation: none; }
    .island-trigger { transition: none; }
  }
</style>
