<script lang="ts">
  import type { WorkerDirectoryEntry } from './ipc'
  import Icon from './Icon.svelte'
  import { currentLocale, t } from './i18n'
  import { outsidePressClose } from './outside_close'

  type Props = {
    mode: 'worker' | 'monitor'
    workerName: string
    workers: WorkerDirectoryEntry[]
    onSelect: (mode: 'worker' | 'monitor', worker?: WorkerDirectoryEntry) => void
    onDetails: () => void
  }
  let { mode, workerName, workers, onSelect, onDetails }: Props = $props()
  let tr = $derived.by(() => {
    void $currentLocale
    return t
  })

  let open = $state(false)
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

<div class="mode-switch" use:outsidePressClose={{ onClose: close }}>
  <button
    class="trigger"
    class:open
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <Icon name="monitor" size={14} />
    <span class="mode-name">{mode === 'worker' ? tr('workers.worker') : tr('workers.monitor')}</span>
    <span class="sep">·</span>
    <span class="worker-name">{workerName}</span>
    <Icon name="chevron-down" size={12} />
  </button>

  {#if open}
    <div class="menu" role="menu">
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
            class:selected={mode === 'monitor' && worker.name === workerName}
            role="menuitemradio"
            aria-checked={mode === 'monitor' && worker.name === workerName}
            onclick={() => pick('monitor', worker)}
          >
            <span class="option-icon"><Icon name="server" size={13} /></span>
            <span class="option-copy">
              <strong>{worker.name}</strong>
              <small>{worker.os ?? 'unknown OS'} · {worker.kode_version ?? 'version unavailable'}</small>
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
  .menu {
    position: absolute;
    z-index: 30;
    top: 40px;
    left: 8px;
    right: 8px;
    overflow: hidden;
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
    display: grid;
    width: 22px;
    height: 22px;
    place-items: center;
    color: var(--fg-secondary);
  }
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
