<script lang="ts">
  import type { WorkerDirectoryEntry } from './ipc'
  import Icon from './Icon.svelte'
  import { currentLocale, t } from './i18n'
  import { outsideElementPressClose } from './outside_close'

  type Props = {
    mode: 'worker' | 'monitor'
    workerName: string
    /** Monitored worker id; null in Worker mode. */
    selectedId: string | null
    workers: WorkerDirectoryEntry[]
    onSelect: (mode: 'worker' | 'monitor', worker?: WorkerDirectoryEntry) => void
    onDetails: () => void
    /** `icon`: a single tile for the compact sidebar (Cmd+B) or the titlebar when the sidebar is hidden. */
    variant?: 'full' | 'icon'
    /** Where the menu opens relative to the trigger. */
    placement?: 'below' | 'right'
  }
  let {
    mode,
    workerName,
    selectedId,
    workers,
    onSelect,
    onDetails,
    variant = 'full',
    placement = 'below',
  }: Props = $props()
  let tr = $derived.by(() => {
    void $currentLocale
    return t
  })

  let open = $state(false)
  let triggerEl: HTMLButtonElement | undefined = $state()
  /** The sidebar clips overflow, so the menu is fixed-positioned from the trigger's rect. */
  let menuStyle = $state('')

  function toggle() {
    if (!open && triggerEl) {
      const r = triggerEl.getBoundingClientRect()
      const top = placement === 'right' ? r.top : r.bottom + 4
      const left = placement === 'right' ? r.right + 8 : r.left
      const width = variant === 'icon' ? 260 : Math.max(r.width, 220)
      menuStyle = `top:${top}px;left:${left}px;width:${width}px;max-height:calc(100vh - ${top + 12}px)`
    }
    open = !open
  }
  let local = $derived(workers.find((worker) => worker.bound) ?? workers[0])
  let remote = $derived(workers.filter((worker) => worker !== local))

  function close() {
    open = false
  }

  function pick(mode: 'worker' | 'monitor', worker?: WorkerDirectoryEntry) {
    onSelect(mode, worker)
    close()
  }
</script>

<div class="mode-switch" class:icon={variant === 'icon'} use:outsideElementPressClose={{ onClose: close, disabled: !open }}>
  {#if variant === 'icon'}
    <button
      bind:this={triggerEl}
      class="tile"
      class:open
      class:monitor={mode === 'monitor'}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`${mode === 'worker' ? tr('workers.worker') : tr('workers.monitor')} · ${workerName}`}
      title={`${mode === 'worker' ? tr('workers.worker') : tr('workers.monitor')} · ${workerName}`}
      onclick={toggle}
    >
      <Icon name={mode === 'worker' ? 'terminal' : 'server'} size={15} />
      <span class="tile-badge" aria-hidden="true"></span>
    </button>
  {:else}
    <button
      bind:this={triggerEl}
      class="trigger"
      class:open
      aria-haspopup="menu"
      aria-expanded={open}
      onclick={toggle}
    >
      <Icon name={mode === 'worker' ? 'terminal' : 'server'} size={14} />
      <span class="mode-name">{mode === 'worker' ? tr('workers.worker') : tr('workers.monitor')}</span>
      <span class="sep">·</span>
      <span class="worker-name">{workerName}</span>
      <Icon name="chevron-down" size={12} />
    </button>
  {/if}

  {#if open}
    <div class="menu" role="menu" style={menuStyle}>
      <div class="menu-label">{tr('workers.local')}</div>
      <button
        class="option"
        class:selected={mode === 'worker'}
        role="menuitemradio"
        aria-checked={mode === 'worker'}
        onclick={() => pick('worker', local)}
      >
        <span class="option-icon"><Icon name="terminal" size={13} /></span>
        <span class="option-copy">
          <strong>{tr('workers.localWorker')}</strong>
          <small>{local?.name ?? workerName}</small>
        </span>
      </button>

      {#if remote.length > 0}
        <div class="menu-label">{tr('workers.monitor')}</div>
        {#each remote as worker (worker.worker_id)}
          <button
            class="option"
            class:selected={mode === 'monitor' && worker.worker_id === selectedId}
            role="menuitemradio"
            aria-checked={mode === 'monitor' && worker.worker_id === selectedId}
            onclick={() => pick('monitor', worker)}
          >
            <span class="option-icon">
              <Icon name="server" size={13} />
              <span class="presence" class:online={worker.online}></span>
            </span>
            <span class="option-copy">
              <strong>{worker.name}</strong>
              {#if worker.os || worker.kode_version}
                <small>{worker.os ?? 'unknown OS'} · {worker.kode_version ?? 'version unavailable'}</small>
              {:else}
                <!-- Account desktops report presence only. -->
                <small>{worker.online ? tr('devices.online') : tr('devices.offline')}</small>
              {/if}
            </span>
          </button>
        {/each}
      {/if}

      <div class="menu-foot">
        <button class="details" role="menuitem" onclick={() => { close(); onDetails() }}>
          <Icon name="info" size={13} />
          {tr('workers.deviceDetails')}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .mode-switch {
    position: relative;
    flex-shrink: 0;
    padding: 6px 8px 2px;
  }
  .trigger {
    width: 100%;
    height: 30px;
    display: grid;
    grid-template-columns: 16px auto 8px minmax(0, 1fr) 14px;
    gap: 6px;
    align-items: center;
    padding: 0 8px;
    color: var(--fg-secondary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--rad-sm);
    cursor: pointer;
    text-align: left;
  }
  .trigger:hover,
  .trigger.open {
    color: var(--fg-primary);
    background: var(--bg-tab-hover);
  }
  .mode-name {
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0;
  }
  .sep {
    color: var(--fg-tertiary);
    text-align: center;
  }
  .worker-name {
    min-width: 0;
    overflow: hidden;
    font-size: var(--fs-xs);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mode-switch.icon {
    display: flex;
    justify-content: center;
    padding: 4px 0;
  }
  .tile {
    position: relative;
    width: 36px;
    height: 32px;
    display: grid;
    place-items: center;
    color: var(--fg-secondary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--rad-sm);
    cursor: pointer;
    -webkit-app-region: no-drag;
  }
  .tile:hover,
  .tile.open {
    color: var(--fg-primary);
    background: var(--bg-tab-hover);
  }
  .tile.monitor { color: var(--acc); }
  /* Monitor mode is the unusual state: mark it so a collapsed sidebar still tells you. */
  .tile-badge {
    position: absolute;
    right: 5px;
    bottom: 5px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: transparent;
  }
  .tile.monitor .tile-badge { background: var(--acc); box-shadow: 0 0 0 2px var(--bg-sidebar); }
  .menu {
    position: fixed;
    z-index: 900;
    overflow: auto;
    white-space: normal;
    padding: 6px;
    color: var(--fg-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    box-shadow: var(--sh-lg);
  }
  .menu-label {
    padding: 7px 8px 5px;
    color: var(--fg-tertiary);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .option {
    width: 100%;
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    gap: 7px;
    align-items: center;
    padding: 7px 8px;
    color: var(--fg-primary);
    background: transparent;
    border: 0;
    border-radius: var(--rad-sm);
    cursor: pointer;
    text-align: left;
  }
  .option:hover,
  .option.selected {
    background: var(--bg-tab-hover);
  }
  .option-icon {
    position: relative;
    display: grid;
    width: 22px;
    height: 22px;
    place-items: center;
    color: var(--fg-secondary);
  }
  .presence {
    position: absolute;
    right: 0;
    bottom: 1px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--fg-tertiary);
    box-shadow: 0 0 0 2px var(--bg-elevated);
  }
  .presence.online { background: var(--st-ok); }
  .option-copy {
    min-width: 0;
    display: grid;
    gap: 2px;
  }
  .option-copy strong,
  .option-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .option-copy strong {
    font-size: var(--fs-sm);
    font-weight: 600;
  }
  .option-copy small {
    color: var(--fg-tertiary);
    font-size: 10px;
  }
  .menu-foot {
    margin-top: 5px;
    padding-top: 5px;
    border-top: 1px solid var(--bd-default);
  }
  .details {
    width: 100%;
    height: 30px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 8px;
    color: var(--fg-secondary);
    background: transparent;
    border: 0;
    border-radius: var(--rad-sm);
    cursor: pointer;
    font-size: var(--fs-xs);
  }
  .details:hover {
    color: var(--fg-primary);
    background: var(--bg-tab-hover);
  }
</style>
