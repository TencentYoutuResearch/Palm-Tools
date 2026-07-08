<script lang="ts">
  import Icon from './Icon.svelte'
  import {
    activeAppEventCount,
    appEvents,
    clearAllAppEvents,
    clearAppEvent,
    clearResolvedAppEvents,
    type AppEvent,
  } from './app_events'
  import { selectTab, tabs } from './sessions'
  import { outsideElementPressClose } from './outside_close'
  import { currentLocale, t, type Params } from './i18n'

  let open = $state(false)

  const sortedEvents = $derived([...$appEvents].sort((a, b) => b.updatedAt - a.updatedAt))
  const activeCount = $derived($activeAppEventCount)
  const resolvedCount = $derived($appEvents.filter((event) => event.status === 'resolved').length)

  // t() 本身不读 reactive 源,直接在模板里用 `{t('x')}` 切换语言不会重渲染。
  // tr 绑定 $currentLocale → locale 变时重建 → 模板中 tr('x') 重跑。
  // 参考 App.svelte 的 tr wrapper。
  const tr = $derived.by(() => {
    void $currentLocale
    return (key: string, params?: Params) => t(key, params)
  })

  function toggle() {
    open = !open
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      open = false
    }
  }

  function eventTabTitle(event: AppEvent): string | null {
    if (event.sessionId == null) return null
    return $tabs.find((tab) => tab.id === event.sessionId)?.title ?? null
  }

  function openEvent(event: AppEvent) {
    if (event.sessionId != null && $tabs.some((tab) => tab.id === event.sessionId)) {
      selectTab(event.sessionId)
    }
    if (event.kind === 'turn_finished') {
      clearAppEvent(event.id)
    }
    open = false
  }

  function eventTime(event: AppEvent): string {
    const delta = Math.max(0, Date.now() - event.updatedAt)
    if (delta < 60_000) return tr('event_center.time.now')
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h`
    return `${Math.floor(hours / 24)}d`
  }

  function clearOne(e: MouseEvent, id: string) {
    e.stopPropagation()
    clearAppEvent(id)
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="event-center" use:outsideElementPressClose={{ onClose: () => (open = false), disabled: !open }}>
  <button
    class="event-trigger"
    class:has-active={activeCount > 0}
    title={tr('event_center.title')}
    aria-label={tr('event_center.title')}
    aria-haspopup="dialog"
    aria-expanded={open}
    onclick={toggle}
  >
    <Icon name="bell" size={16} stroke={1.65} />
    {#if activeCount > 0}
      <span class="event-dot-badge"></span>
    {/if}
  </button>

  {#if open}
    <div class="event-popover" role="dialog" tabindex="-1" aria-label={tr('event_center.title')}>
      <header class="event-header">
        <div>
          <strong>{tr('event_center.header')}</strong>
          <span>{activeCount > 0 ? tr('event_center.activeCount', { count: activeCount }) : tr('event_center.empty')}</span>
        </div>
        <div class="event-actions">
          <button
            title={tr('event_center.clearResolved')}
            aria-label={tr('event_center.clearResolved')}
            disabled={resolvedCount === 0}
            onclick={clearResolvedAppEvents}
          >
            <Icon name="check" size={13} />
          </button>
          <button
            title={tr('event_center.clearAll')}
            aria-label={tr('event_center.clearAll')}
            disabled={$appEvents.length === 0}
            onclick={clearAllAppEvents}
          >
            <Icon name="trash-2" size={13} />
          </button>
        </div>
      </header>

      {#if sortedEvents.length === 0}
        <div class="event-empty">
          <Icon name="bell" size={18} stroke={1.65} />
          <span>{tr('event_center.noEvents')}</span>
        </div>
      {:else}
        <div class="event-list">
          {#each sortedEvents as event (event.id)}
            {@const tabTitle = eventTabTitle(event)}
            <div
              class="event-row"
              class:active={event.status === 'active'}
              class:resolved={event.status === 'resolved'}
              role="button"
              tabindex="0"
              title={tabTitle ? tr('event_center.openTab', { title: tabTitle }) : tr(event.title)}
              onclick={() => openEvent(event)}
              onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  openEvent(event)
                }
              }}
            >
              <span class="event-dot {event.severity}"></span>
              <div class="event-body">
                <div class="event-title">
                  <strong>{tr(event.title)}</strong>
                  <span>{eventTime(event)}</span>
                </div>
                <div class="event-detail">
                  {event.detail ?? tabTitle ?? event.source ?? tr('event_center.fallbackSource')}
                </div>
              </div>
              <button
                class="event-clear"
                title={tr('event_center.clearOne')}
                aria-label={tr('event_center.clearOne')}
                onclick={(e) => clearOne(e, event.id)}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .event-center {
    position: relative;
    display: inline-flex;
    align-items: center;
    -webkit-app-region: no-drag;
    pointer-events: auto;
  }

  .event-trigger {
    position: relative;
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
      box-shadow var(--t-fast),
      border-color var(--t-fast),
      color var(--t-fast);
  }
  .event-trigger:hover,
  .event-trigger.has-active {
    background: var(--bg-hover);
    border-color: var(--bd-default);
    color: var(--fg-primary);
  }
  .event-trigger.has-active {
    background: color-mix(in srgb, var(--st-warn) 12%, transparent);
    border-color: color-mix(in srgb, var(--st-warn) 42%, var(--bd-default));
    color: var(--st-warn);
    animation: event-trigger-pulse 1.6s ease-in-out infinite;
  }
  .event-trigger.has-active:hover {
    background: color-mix(in srgb, var(--st-warn) 18%, transparent);
    border-color: var(--st-warn);
  }

  .event-dot-badge {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--st-warn);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--bg-base) 92%, transparent);
  }

  .event-popover {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 80;
    width: min(380px, calc(100vw - 24px));
    max-height: min(520px, calc(100vh - 72px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-lg);
    background: color-mix(in srgb, var(--bg-elevated) 96%, var(--bg-base));
    box-shadow: var(--sh-lg);
    color: var(--fg-primary);
    animation: event-pop 120ms ease-out;
  }

  @keyframes event-trigger-pulse {
    0%, 100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--st-warn) 0%, transparent);
    }
    50% {
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--st-warn) 16%, transparent);
    }
  }

  .event-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-3);
    border-bottom: 1px solid var(--bd-muted);
  }
  .event-header div:first-child {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .event-header strong {
    font-size: var(--fs-sm);
    font-weight: var(--fw-semi);
  }
  .event-header span {
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
  }

  .event-actions {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .event-actions button,
  .event-clear {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: var(--rad-sm);
    background: transparent;
    color: var(--fg-tertiary);
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
  }
  .event-actions button:hover:not(:disabled),
  .event-clear:hover {
    background: var(--bg-hover);
    border-color: var(--bd-default);
    color: var(--fg-primary);
  }
  .event-actions button:disabled {
    opacity: 0.36;
    cursor: default;
  }

  .event-empty {
    min-height: 128px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    color: var(--fg-tertiary);
    font-size: var(--fs-sm);
  }

  .event-list {
    overflow: auto;
    padding: 6px;
  }

  .event-row {
    display: grid;
    grid-template-columns: 8px minmax(0, 1fr) 24px;
    align-items: center;
    gap: var(--sp-2);
    min-height: 58px;
    padding: 8px;
    border-radius: var(--rad-md);
    color: var(--fg-secondary);
    cursor: pointer;
    outline: none;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .event-row:hover,
  .event-row:focus-visible {
    background: var(--bg-hover);
    color: var(--fg-primary);
  }
  .event-row.active {
    background: color-mix(in srgb, var(--st-warn) 9%, transparent);
  }
  .event-row.resolved {
    opacity: 0.72;
  }

  .event-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--fg-tertiary);
    align-self: start;
    margin-top: 8px;
  }
  .event-dot.info { background: var(--st-info); }
  .event-dot.warning { background: var(--st-warn); }
  .event-dot.success { background: var(--st-ok); }
  .event-dot.error { background: var(--st-err); }

  .event-body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .event-title {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .event-title strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-primary);
    font-size: var(--fs-sm);
    font-weight: var(--fw-med);
  }
  .event-title span {
    margin-left: auto;
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
  }
  .event-detail {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
  }

  @keyframes event-pop {
    from { transform: translateY(-4px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .event-popover,
    .event-trigger.has-active {
      animation: none;
    }
  }
</style>
