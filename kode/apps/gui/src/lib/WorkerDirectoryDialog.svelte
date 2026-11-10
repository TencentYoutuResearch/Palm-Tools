<script lang="ts">
  import { onMount } from 'svelte'
  import {
    ipc,
    type CloudSyncStatus,
    type WorkerDirectoryEntry,
    type WorkerInventory,
  } from './ipc'
  import Icon from './Icon.svelte'
  import { currentLocale, t } from './i18n'
  import { outsidePressClose } from './outside_close'

  type Props = { onClose: () => void }
  let { onClose }: Props = $props()

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

  function handleKey(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    onClose()
  }
</script>

<svelte:window onkeydown={handleKey} />

<div class="backdrop" use:outsidePressClose={{ onClose }} role="presentation">
  <div class="dialog" role="dialog" aria-label={tr('workers.title')}>
    <header>
      <div>
        <span class="eyebrow">{tr('workers.syncServer')}</span>
        <h2>{tr('workers.title')}</h2>
      </div>
      <div class="header-actions">
        <button
          class="tool"
          title={tr('workers.refresh')}
          aria-label={tr('workers.refresh')}
          disabled={loadingDirectory}
          onclick={() => void refresh()}
        >
          <Icon name="refresh-cw" size={15} />
        </button>
        <button class="tool" title={tr('memory.common.close')} aria-label={tr('memory.common.close')} onclick={onClose}>
          <Icon name="x" size={15} />
        </button>
      </div>
    </header>

    {#if error}
      <div class="error" role="alert">{error}</div>
    {/if}

    <div class="body">
      <aside class="directory" aria-label={tr('workers.list')}>
        {#if loadingDirectory}
          <div class="empty"><span class="spinner"></span>{tr('workers.loading')}</div>
        {:else if workers.length === 0}
          <div class="empty">
            <Icon name="server" size={20} />
            <span>{tr('workers.empty')}</span>
          </div>
        {:else}
          {#each workers as worker (worker.worker_id)}
            <button
              class="worker-row"
              class:selected={worker.worker_id === selectedId}
              onclick={() => void selectWorker(worker)}
            >
              <span class="dot" class:online={worker.online}></span>
              <span class="worker-copy">
                <span class="worker-name">{worker.name}</span>
                <span class="worker-meta">
                  {worker.os ?? tr('workers.unknownOs')} · {worker.arch ?? '?'}
                  {#if worker.bound} · {tr('workers.current')}{/if}
                </span>
                <span class="worker-meta mono">
                  {worker.kode_version ?? tr('workers.versionUnavailable')}
                </span>
              </span>
              {#if !worker.inventory_capable && worker.online}
                <span class="compat" title={tr('workers.legacy')}>{tr('workers.legacy')}</span>
              {/if}
            </button>
          {/each}
        {/if}
      </aside>

      <section class="details">
        {#if !selected}
          <div class="empty details-empty">{tr('workers.select')}</div>
        {:else}
          <div class="detail-head">
            <div>
              <h3>{selected.name}</h3>
              <p class="mono">{selected.worker_id}</p>
            </div>
            <span class="state" class:online={selected.online}>
              {selected.online
                ? tr('workers.online')
                : tr('workers.lastSeen', { time: formatTime(selected.last_seen_at) })}
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
                <small>
                  {inventory.worker.details?.os_version ?? inventory.worker.os}
                  · {inventory.worker.arch}
                </small>
              </div>
              <div>
                <span class="label">{tr('workers.kode')}</span>
                <strong>{inventory.worker.kode_version}</strong>
                <small>{tr('workers.uptime', { age: formatAge(inventory.worker.uptime_seconds) })}</small>
              </div>
              <div>
                <span class="label">{tr('workers.cpu')}</span>
                <strong>{tr('workers.cores', { count: inventory.resources.cpu_count })}</strong>
                <small>{inventory.resources.cpu_brand ?? tr('workers.unknownCpu')}</small>
              </div>
              <div>
                <span class="label">{tr('workers.load')}</span>
                <strong>{inventory.resources.load_1m.toFixed(2)}</strong>
                <small>
                  {inventory.resources.load_5m.toFixed(2)}
                  / {inventory.resources.load_15m.toFixed(2)}
                </small>
              </div>
            </div>

            <section class="section">
              <div class="section-head">
                <h4>{tr('workers.resources')}</h4>
                <span>{tr('workers.observed', { time: formatTime(inventory.observed_at) })}</span>
              </div>
              <div class="meter-row">
                <span>{tr('workers.memory')}</span>
                <div class="meter">
                  <span
                    style={`width:${inventory.resources.memory_total > 0
                      ? Math.min(
                          100,
                          ((inventory.resources.memory_total -
                            inventory.resources.memory_available) /
                            inventory.resources.memory_total) *
                            100,
                        )
                      : 0}%`}
                  ></span>
                </div>
                <span class="mono">
                  {tr('workers.freeOf', {
                    free: formatBytes(inventory.resources.memory_available),
                    total: formatBytes(inventory.resources.memory_total),
                  })}
                </span>
              </div>
              {#each inventory.resources.disks as disk}
                <div class="meter-row">
                  <span title={disk.mount}>{disk.mount}</span>
                  <div class="meter">
                    <span
                      style={`width:${disk.total > 0
                        ? Math.min(100, ((disk.total - disk.available) / disk.total) * 100)
                        : 0}%`}
                    ></span>
                  </div>
                  <span class="mono">
                    {tr('workers.freeOf', {
                      free: formatBytes(disk.available),
                      total: formatBytes(disk.total),
                    })}
                  </span>
                </div>
              {/each}
            </section>

            <section class="section">
              <div class="section-head">
                <h4>{tr('workers.agents')}</h4>
                <span>{tr('workers.availableCount', {
                  count: inventory.agents.filter((agent) => agent.available).length,
                })}</span>
              </div>
              <div class="table">
                {#each inventory.agents as agent}
                  <div class="table-row">
                    <span class="agent-key">{agent.key}</span>
                    <span class:dim={!agent.available}>
                      {agent.version ??
                        (agent.available
                          ? tr('workers.versionUnavailable')
                          : tr('workers.notInstalled'))}
                    </span>
                    <span class="pill" class:off={!agent.available}>
                      {agent.available
                        ? agent.enabled
                          ? tr('workers.ready')
                          : tr('workers.disabled')
                        : tr('workers.missing')}
                    </span>
                  </div>
                {/each}
              </div>
            </section>

            <section class="section">
              <div class="section-head">
                <h4>{tr('workers.adbDevices')}</h4>
                <span>{inventory.adb.version ?? (inventory.adb.available
                  ? tr('workers.adbReady')
                  : tr('workers.adbMissing'))}</span>
              </div>
              {#if inventory.adb.devices.length === 0}
                <div class="inline-empty">
                  {inventory.adb.available
                    ? tr('workers.noDevices')
                    : tr('workers.noAdb')}
                </div>
              {:else}
                <div class="device-list">
                  {#each inventory.adb.devices as device}
                    <div class="device-row">
                      <span class="device-state" class:ready={device.state === 'device'}></span>
                      <span class="device-copy">
                        <strong>{device.serial}</strong>
                        <small>
                          {[device.model, device.product, device.connection]
                            .filter(Boolean)
                            .join(' · ') || tr('workers.androidDevice')}
                        </small>
                      </span>
                      <span class="pill" class:off={device.state !== 'device'}>{device.state}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </section>
          {/if}
        {/if}
      </section>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--sp-4);
    background: var(--bg-modal-backdrop);
    backdrop-filter: var(--blur-modal);
    -webkit-backdrop-filter: var(--blur-modal);
  }
  .dialog {
    width: min(1080px, 96vw);
    height: min(760px, calc(100vh - 32px));
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    overflow: hidden;
    color: var(--fg-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-lg);
    box-shadow: var(--sh-modal);
    font: var(--fs-md) var(--font-ui);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--bd-default);
  }
  header h2,
  .detail-head h3,
  .section-head h4 {
    margin: 0;
    letter-spacing: 0;
  }
  header h2 {
    font-size: var(--fs-lg);
    font-weight: 600;
  }
  .eyebrow,
  .label {
    display: block;
    margin-bottom: 3px;
    color: var(--fg-tertiary);
    font: var(--fs-xs) var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .header-actions {
    display: flex;
    gap: 6px;
  }
  .tool {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    color: var(--fg-secondary);
    background: transparent;
    border: 0;
    border-radius: var(--rad-sm);
    cursor: pointer;
  }
  .tool:hover {
    color: var(--fg-primary);
    background: var(--bg-tab-hover);
  }
  .body {
    min-height: 0;
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
  }
  .directory {
    min-height: 0;
    overflow: auto;
    padding: 8px;
    border-right: 1px solid var(--bd-default);
    background: var(--bg-input);
  }
  .worker-row {
    width: 100%;
    display: grid;
    grid-template-columns: 9px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: start;
    padding: var(--sp-2) 10px;
    text-align: left;
    color: var(--fg-primary);
    background: transparent;
    border: 0;
    border-radius: var(--rad-sm);
    cursor: pointer;
  }
  .worker-row:hover,
  .worker-row.selected {
    background: var(--bg-tab-hover);
  }
  .dot,
  .device-state {
    width: 7px;
    height: 7px;
    margin-top: 5px;
    border-radius: 50%;
    background: var(--fg-tertiary);
  }
  .dot.online,
  .device-state.ready {
    background: var(--st-ok);
  }
  .worker-copy,
  .device-copy {
    min-width: 0;
    display: grid;
    gap: 3px;
  }
  .worker-name,
  .device-copy strong {
    overflow: hidden;
    font-size: var(--fs-sm);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .worker-meta,
  .device-copy small,
  .section-head span,
  .summary-grid small {
    overflow: hidden;
    color: var(--fg-secondary);
    font-size: var(--fs-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .compat,
  .pill,
  .state {
    padding: 2px 6px;
    color: var(--fg-secondary);
    font: var(--fs-xs) var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid var(--bd-default);
    border-radius: 999px;
  }
  .state.online,
  .pill:not(.off) {
    color: var(--st-ok);
    border-color: color-mix(in srgb, var(--st-ok) 45%, var(--bd-default));
  }
  .pill.off {
    color: var(--st-warn);
  }
  .details {
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }
  .detail-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: var(--sp-4);
    border-bottom: 1px solid var(--bd-default);
  }
  .detail-head h3 {
    font-size: var(--fs-md);
    font-weight: 600;
  }
  .detail-head p {
    margin: 4px 0 0;
    color: var(--fg-secondary);
    font: var(--fs-xs) var(--font-mono);
  }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border-bottom: 1px solid var(--bd-default);
  }
  .summary-grid > div {
    min-width: 0;
    padding: var(--sp-3) var(--sp-4);
    border-right: 1px solid var(--bd-default);
  }
  .summary-grid > div:last-child {
    border-right: 0;
  }
  .summary-grid strong,
  .summary-grid small {
    display: block;
  }
  .summary-grid strong {
    overflow: hidden;
    font-size: var(--fs-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .section {
    padding: var(--sp-4);
    border-bottom: 1px solid var(--bd-default);
  }
  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 11px;
  }
  .section-head h4 {
    font-size: var(--fs-sm);
    font-weight: 600;
  }
  .meter-row {
    display: grid;
    grid-template-columns: minmax(90px, 0.8fr) minmax(120px, 1.5fr) minmax(150px, 1.2fr);
    gap: 12px;
    align-items: center;
    min-height: 28px;
    font-size: var(--fs-xs);
  }
  .meter {
    height: 5px;
    overflow: hidden;
    background: var(--bg-input);
    border-radius: 999px;
  }
  .meter span {
    display: block;
    height: 100%;
    background: var(--acc);
  }
  .table,
  .device-list {
    display: grid;
  }
  .table-row {
    display: grid;
    grid-template-columns: minmax(100px, 0.8fr) minmax(0, 1.5fr) auto;
    gap: 12px;
    align-items: center;
    min-height: 34px;
    border-top: 1px solid var(--bd-muted);
    font-size: var(--fs-xs);
  }
  .table-row:first-child {
    border-top: 0;
  }
  .agent-key {
    font-weight: 650;
  }
  .device-row {
    display: grid;
    grid-template-columns: 9px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    min-height: 46px;
    border-top: 1px solid var(--bd-muted);
  }
  .device-row:first-child {
    border-top: 0;
  }
  .device-state {
    margin-top: 0;
  }
  .empty,
  .notice,
  .inline-empty {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 18px;
    color: var(--fg-secondary);
    font-size: var(--fs-sm);
  }
  .details-empty {
    height: 100%;
    justify-content: center;
  }
  .notice,
  .error {
    color: var(--st-warn);
    border-bottom: 1px solid var(--bd-default);
  }
  .error {
    padding: 9px 18px;
    font-size: var(--fs-sm);
    background: color-mix(in srgb, var(--st-err) 8%, transparent);
  }
  .spinner {
    width: 13px;
    height: 13px;
    border: 2px solid var(--bd-default);
    border-top-color: var(--acc);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .mono {
    font-family: var(--font-mono, monospace);
  }
  .dim {
    color: var(--fg-tertiary);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (max-width: 760px) {
    .backdrop {
      padding: 10px;
    }
    .dialog {
      width: calc(100vw - 20px);
      height: calc(100vh - 20px);
    }
    .body {
      grid-template-columns: 1fr;
      grid-template-rows: 180px minmax(0, 1fr);
    }
    .directory {
      border-right: 0;
      border-bottom: 1px solid var(--bd-default);
    }
    .summary-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .summary-grid > div:nth-child(2) {
      border-right: 0;
    }
    .meter-row {
      grid-template-columns: 80px minmax(80px, 1fr);
    }
    .meter-row > :last-child {
      grid-column: 1 / -1;
    }
  }
</style>
