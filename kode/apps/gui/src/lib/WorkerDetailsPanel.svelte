<script lang="ts">
  /**
   * Worker details in the right inspector column (shares it with Workspace).
   * Single column: a worker picker on top, the selected worker's inventory below.
   */
  import { onMount } from 'svelte'
  import {
    ipc,
    type CloudSyncStatus,
    type WorkerDirectoryEntry,
    type WorkerInventory,
  } from './ipc'
  import Icon from './Icon.svelte'
  import { currentLocale, t } from './i18n'

  type Props = {
    onClose: () => void
    /** Worker to show first, e.g. the one being monitored. */
    initialWorkerId?: string | null
    onTitlebarMouseDown?: (e: MouseEvent) => void
  }
  let { onClose, initialWorkerId = null, onTitlebarMouseDown }: Props = $props()

  let status = $state<CloudSyncStatus | null>(null)
  let workers = $state<WorkerDirectoryEntry[]>([])
  let selectedId = $state('')
  let inventory = $state<WorkerInventory | null>(null)
  let loadingDirectory = $state(true)
  let loadingInventory = $state(false)
  let error = $state('')
  let inventoryError = $state('')
  let tr = $derived.by(() => {
    void $currentLocale
    return t
  })

  let selected = $derived(workers.find((worker) => worker.worker_id === selectedId) ?? null)
  let memUsed = $derived.by(() => {
    const r = inventory?.resources
    return r && r.memory_total > 0 ? Math.min(100, ((r.memory_total - r.memory_available) / r.memory_total) * 100) : 0
  })

  onMount(() => {
    void refresh()
  })

  async function refresh() {
    loadingDirectory = true
    error = ''
    try {
      status = await ipc.cloudSyncStatus()
      const directory = await ipc.cloudSyncWorkers()
      workers = directory.workers ?? []
      const preferred =
        workers.find((worker) => worker.worker_id === selectedId) ??
        workers.find((worker) => worker.worker_id === initialWorkerId) ??
        workers.find((worker) => worker.worker_id === status?.device_id) ??
        workers.find((worker) => worker.online) ??
        workers[0]
      selectedId = preferred?.worker_id ?? ''
      if (preferred) await selectWorker(preferred, false)
      else {
        inventory = null
        inventoryError = ''
      }
    } catch (reason) {
      error = String(reason)
      workers = []
      inventory = null
    } finally {
      loadingDirectory = false
    }
  }

  async function selectWorker(worker: WorkerDirectoryEntry, showLoading = true) {
    if (selectedId === worker.worker_id && inventory && !showLoading) return
    selectedId = worker.worker_id
    inventory = null
    inventoryError = ''
    if (!worker.online) {
      inventoryError = tr('workers.offlineInventory')
      return
    }
    if (!worker.inventory_capable) {
      inventoryError = tr('workers.legacyInventory')
      return
    }
    loadingInventory = showLoading
    try {
      inventory = await ipc.cloudSyncWorkerInventory(worker.worker_id)
    } catch (reason) {
      inventoryError = String(reason)
    } finally {
      loadingInventory = false
    }
  }

  function formatBytes(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0 B'
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let amount = value
    let unit = 0
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024
      unit += 1
    }
    return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`
  }

  function formatAge(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return 'unknown'
    if (seconds < 60) return `${Math.floor(seconds)}s`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
    return `${Math.floor(seconds / 86400)}d`
  }

  function formatTime(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return 'never'
    return new Date(ms).toLocaleString()
  }

  function pick(event: Event) {
    const worker = workers.find((w) => w.worker_id === (event.currentTarget as HTMLSelectElement).value)
    if (worker) void selectWorker(worker)
  }
</script>

<section class="worker-panel" aria-label={tr('workers.title')}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="nav-top" data-tauri-drag-region onmousedown={onTitlebarMouseDown}>
    <div class="nav-title">
      <Icon name="server" size={14} />
      <span>{tr('workers.title')}</span>
    </div>
    <div class="nav-top-actions">
      <button
        class="tool"
        title={tr('workers.refresh')}
        aria-label={tr('workers.refresh')}
        disabled={loadingDirectory}
        onclick={() => void refresh()}
      >
        <Icon name="refresh-cw" size={14} />
      </button>
      <button class="tool" title={tr('memory.common.close')} aria-label={tr('memory.common.close')} onclick={onClose}>
        <Icon name="x" size={14} />
      </button>
    </div>
  </div>

  {#if error}
    <div class="error" role="alert">{error}</div>
  {/if}

  <div class="scroll">
    {#if loadingDirectory && workers.length === 0}
      <div class="empty"><span class="spinner"></span>{tr('workers.loading')}</div>
    {:else if workers.length === 0}
      <div class="empty column">
        <Icon name="server" size={20} />
        <span>{tr('workers.empty')}</span>
      </div>
    {:else}
      <div class="picker">
        <span class="dot" class:online={selected?.online}></span>
        <select aria-label={tr('workers.list')} value={selectedId} onchange={pick}>
          {#each workers as worker (worker.worker_id)}
            <option value={worker.worker_id}>
              {worker.name}{worker.bound ? ` · ${tr('workers.current')}` : ''}{worker.online ? '' : ` · ${tr('devices.offline')}`}
            </option>
          {/each}
        </select>
        <Icon name="chevron-down" size={12} />
      </div>

      {#if selected}
        <div class="detail-head">
          <div class="head-copy">
            <h3>{selected.name}</h3>
            <p>
              {selected.os ?? tr('workers.unknownOs')} · {selected.arch ?? '?'}
              · <span class="mono">{selected.kode_version ?? tr('workers.versionUnavailable')}</span>
            </p>
          </div>
          <span class="state" class:online={selected.online}>
            {selected.online ? tr('workers.online') : tr('workers.lastSeen', { time: formatTime(selected.last_seen_at) })}
          </span>
        </div>

        {#if loadingInventory}
          <div class="empty"><span class="spinner"></span>{tr('workers.reading')}</div>
        {:else if inventoryError}
          <div class="notice" role="status">
            <Icon name="alert-triangle" size={16} />
            <span>{inventoryError}</span>
          </div>
        {:else if inventory}
          <div class="summary-grid">
            <div>
              <span class="label">{tr('workers.system')}</span>
              <strong>{inventory.worker.details?.name ?? inventory.worker.os}</strong>
              <small>{inventory.worker.details?.os_version ?? inventory.worker.os} · {inventory.worker.arch}</small>
            </div>
            <div>
              <span class="label">{tr('workers.kode')}</span>
              <strong>{inventory.worker.kode_version}</strong>
              <small>{tr('workers.uptime', { age: formatAge(inventory.worker.uptime_seconds) })}</small>
            </div>
            <div>
              <span class="label">{tr('workers.cpu')}</span>
              <strong>{tr('workers.cores', { count: inventory.resources.cpu_count })}</strong>
              <small title={inventory.resources.cpu_brand ?? ''}>{inventory.resources.cpu_brand ?? tr('workers.unknownCpu')}</small>
            </div>
            <div>
              <span class="label">{tr('workers.load')}</span>
              <strong>{inventory.resources.load_1m.toFixed(2)}</strong>
              <small>{inventory.resources.load_5m.toFixed(2)} / {inventory.resources.load_15m.toFixed(2)}</small>
            </div>
          </div>

          <section class="section">
            <div class="section-head">
              <h4>{tr('workers.resources')}</h4>
              <span>{tr('workers.observed', { time: formatTime(inventory.observed_at) })}</span>
            </div>
            <div class="meter-row">
              <div class="meter-label">
                <span>{tr('workers.memory')}</span>
                <span class="mono">{tr('workers.freeOf', {
                  free: formatBytes(inventory.resources.memory_available),
                  total: formatBytes(inventory.resources.memory_total),
                })}</span>
              </div>
              <div class="meter" class:hot={memUsed >= 90}><span style={`width:${memUsed}%`}></span></div>
            </div>
            {#each inventory.resources.disks as disk}
              {@const diskUsed = disk.total > 0 ? Math.min(100, ((disk.total - disk.available) / disk.total) * 100) : 0}
              <div class="meter-row">
                <div class="meter-label">
                  <span class="mount" title={disk.mount}>{disk.mount}</span>
                  <span class="mono">{tr('workers.freeOf', { free: formatBytes(disk.available), total: formatBytes(disk.total) })}</span>
                </div>
                <div class="meter" class:hot={diskUsed >= 90}><span style={`width:${diskUsed}%`}></span></div>
              </div>
            {/each}
          </section>

          <section class="section">
            <div class="section-head">
              <h4>{tr('workers.agents')}</h4>
              <span>{tr('workers.availableCount', { count: inventory.agents.filter((agent) => agent.available).length })}</span>
            </div>
            <div class="table">
              {#each inventory.agents as agent}
                <div class="table-row">
                  <span class="agent-copy">
                    <span class="agent-key">{agent.key}</span>
                    <span class="agent-version" class:dim={!agent.available}>
                      {agent.version ?? (agent.available ? tr('workers.versionUnavailable') : tr('workers.notInstalled'))}
                    </span>
                  </span>
                  <span class="pill" class:off={!agent.available} class:muted={agent.available && !agent.enabled}>
                    {agent.available ? (agent.enabled ? tr('workers.ready') : tr('workers.disabled')) : tr('workers.missing')}
                  </span>
                </div>
              {/each}
            </div>
          </section>

          <section class="section">
            <div class="section-head">
              <h4>{tr('workers.adbDevices')}</h4>
              <span>{inventory.adb.version ?? (inventory.adb.available ? tr('workers.adbReady') : tr('workers.adbMissing'))}</span>
            </div>
            {#if inventory.adb.devices.length === 0}
              <div class="inline-empty">{inventory.adb.available ? tr('workers.noDevices') : tr('workers.noAdb')}</div>
            {:else}
              <div class="device-list">
                {#each inventory.adb.devices as device}
                  <div class="device-row">
                    <span class="device-state" class:ready={device.state === 'device'}></span>
                    <span class="device-copy">
                      <strong>{device.serial}</strong>
                      <small>{[device.model, device.product, device.connection].filter(Boolean).join(' · ') || tr('workers.androidDevice')}</small>
                    </span>
                    <span class="pill" class:off={device.state !== 'device'}>{device.state}</span>
                  </div>
                {/each}
              </div>
            {/if}
          </section>
        {/if}
      {/if}
    {/if}
  </div>
</section>

<style>
  .worker-panel {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--fg-primary);
    font: var(--fs-md) var(--font-ui);
  }
  /* Same 44px top bar as WorkspacePanel so the inspector lines up with the main titlebar. */
  .nav-top {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: 44px;
    padding: 0 8px 0 12px;
    border-bottom: 1px solid color-mix(in srgb, var(--fg-primary) 8%, transparent);
    -webkit-app-region: drag;
    user-select: none;
    -webkit-user-select: none;
  }
  .nav-title {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    color: var(--fg-secondary);
    font-size: var(--fs-sm);
    font-weight: 600;
  }
  .nav-top-actions { display: flex; gap: 2px; -webkit-app-region: no-drag; }
  .tool {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    color: var(--fg-secondary);
    background: transparent;
    border: 0;
    border-radius: var(--rad-sm);
    cursor: pointer;
  }
  .tool:hover:not(:disabled) { color: var(--fg-primary); background: var(--bg-tab-hover); }
  .tool:disabled { opacity: 0.5; cursor: default; }
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }
  .picker {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 12px 0;
    padding: 0 10px;
    height: 32px;
    color: var(--fg-secondary);
    background: var(--bg-input);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-sm);
  }
  .picker:hover { border-color: var(--bd-strong); }
  .picker select {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    color: var(--fg-primary);
    background: transparent;
    border: 0;
    outline: none;
    font: 600 var(--fs-sm) var(--font-ui);
    appearance: none;
    cursor: pointer;
  }
  .label {
    display: block;
    margin-bottom: 3px;
    color: var(--fg-tertiary);
    font: 10px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .dot,
  .device-state {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--fg-tertiary);
  }
  .dot.online,
  .device-state.ready { background: var(--st-ok); }
  .detail-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 12px 10px;
  }
  .head-copy { min-width: 0; }
  .detail-head h3 {
    margin: 0;
    overflow: hidden;
    font-size: var(--fs-md);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail-head p {
    margin: 3px 0 0;
    overflow: hidden;
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pill,
  .state {
    flex: 0 0 auto;
    padding: 1px 7px;
    color: var(--fg-secondary);
    font: 10px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid var(--bd-default);
    border-radius: 999px;
    white-space: nowrap;
  }
  .state.online,
  .pill:not(.off):not(.muted) {
    color: var(--st-ok);
    border-color: color-mix(in srgb, var(--st-ok) 45%, var(--bd-default));
  }
  .pill.off { color: var(--st-warn); }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    padding: 0 12px 12px;
  }
  .summary-grid > div {
    min-width: 0;
    padding: 8px 10px;
    background: var(--bg-card);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-sm);
  }
  .summary-grid strong,
  .summary-grid small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .summary-grid strong { font-size: var(--fs-sm); }
  .summary-grid small { margin-top: 2px; color: var(--fg-tertiary); font-size: var(--fs-xs); }
  .section {
    padding: 12px;
    border-top: 1px solid var(--bd-muted);
  }
  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }
  .section-head h4 {
    margin: 0;
    font-size: var(--fs-sm);
    font-weight: 600;
  }
  .section-head span {
    overflow: hidden;
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meter-row { display: grid; gap: 4px; padding: 5px 0; }
  .meter-label {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    color: var(--fg-secondary);
    font-size: var(--fs-xs);
  }
  .meter-label .mono { color: var(--fg-tertiary); white-space: nowrap; }
  .mount { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meter {
    height: 4px;
    overflow: hidden;
    background: var(--bg-input);
    border-radius: 999px;
  }
  .meter span { display: block; height: 100%; background: var(--acc); }
  .meter.hot span { background: var(--st-warn); }
  .table,
  .device-list { display: grid; }
  .table-row,
  .device-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    border-top: 1px solid var(--bd-muted);
  }
  .table-row:first-child,
  .device-row:first-child { border-top: 0; }
  .agent-copy,
  .device-copy {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 1px;
  }
  .agent-key,
  .device-copy strong {
    overflow: hidden;
    font-size: var(--fs-sm);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-version,
  .device-copy small {
    overflow: hidden;
    color: var(--fg-tertiary);
    font: var(--fs-xs) var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty,
  .notice,
  .inline-empty {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 14px 12px;
    color: var(--fg-secondary);
    font-size: var(--fs-sm);
  }
  .inline-empty { padding: 4px 0; color: var(--fg-tertiary); font-size: var(--fs-xs); }
  .empty.column {
    flex-direction: column;
    justify-content: center;
    padding: 48px 16px;
    color: var(--fg-tertiary);
    text-align: center;
  }
  .notice { margin: 0 12px; color: var(--st-warn); }
  .error {
    padding: 8px 12px;
    color: var(--st-warn);
    font-size: var(--fs-xs);
    background: color-mix(in srgb, var(--st-err) 8%, transparent);
    border-bottom: 1px solid var(--bd-default);
  }
  .spinner {
    width: 13px;
    height: 13px;
    border: 2px solid var(--bd-default);
    border-top-color: var(--acc);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .mono { font-family: var(--font-mono, monospace); }
  .dim { color: var(--fg-tertiary); }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
