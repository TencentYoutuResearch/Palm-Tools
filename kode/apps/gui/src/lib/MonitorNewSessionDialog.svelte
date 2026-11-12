<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from './Icon.svelte'
  import { currentLocale, t } from './i18n'
  import { ipc, type WorkerBackendOption, type WorkerSessionDto } from './ipc'

  type Props = {
    workerId: string
    workerName: string
    onClose: () => void
    onCreated: (session: WorkerSessionDto) => void | Promise<void>
  }

  let { workerId, workerName, onClose, onCreated }: Props = $props()
  let backends = $state<WorkerBackendOption[]>([])
  let backendKey = $state('')
  let cwd = $state('')
  let model = $state('')
  let loading = $state(true)
  let creating = $state(false)
  let error = $state('')
  let tr = $derived.by(() => {
    void $currentLocale
    return t
  })

  onMount(() => {
    void load()
  })

  async function load() {
    loading = true
    error = ''
    try {
      const reply = await ipc.cloudSyncWorkerBackends(workerId)
      backends = (reply.backends ?? []).filter((backend) => backend.enabled !== false)
      backendKey = backends[0]?.key ?? ''
      cwd = reply.home ?? ''
    } catch (reason) {
      error = String(reason)
    } finally {
      loading = false
    }
  }

  async function create() {
    if (!backendKey || creating) return
    creating = true
    error = ''
    try {
      const session = await ipc.cloudSyncWorkerCreateSession(workerId, {
        backend_key: backendKey,
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
      })
      await onCreated(session)
    } catch (reason) {
      error = String(reason)
    } finally {
      creating = false
    }
  }
</script>

<div class="backdrop" role="presentation">
  <div
    class="dialog"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-labelledby="monitor-new-session-title"
    onkeydown={(event) => {
      if (event.key === 'Escape' && !creating) onClose()
    }}
  >
    <header>
      <div>
        <span class="eyebrow">{workerName}</span>
        <h2 id="monitor-new-session-title">{tr('monitorNew.title')}</h2>
      </div>
      <button class="icon" type="button" disabled={creating} aria-label={tr('devices.cancel')} onclick={onClose}>
        <Icon name="x" size={15} />
      </button>
    </header>

    <form
      onsubmit={(event) => {
        event.preventDefault()
        void create()
      }}
    >
      {#if loading}
        <div class="loading"><span class="spinner"></span>{tr('monitorNew.loading')}</div>
      {:else if backends.length === 0}
        <div class="empty">{tr('monitorNew.noAgents')}</div>
      {:else}
        <label>
          <span>{tr('monitorNew.agent')}</span>
          <select bind:value={backendKey} disabled={creating}>
            {#each backends as backend (backend.key)}
              <option value={backend.key}>{backend.display_name}</option>
            {/each}
          </select>
        </label>
        <label>
          <span>{tr('monitorNew.cwd')}</span>
          <input bind:value={cwd} disabled={creating} spellcheck="false" autocomplete="off" placeholder={tr('monitorNew.cwdPlaceholder')} />
        </label>
        <label>
          <span>{tr('monitorNew.model')}</span>
          <input bind:value={model} disabled={creating} spellcheck="false" autocomplete="off" placeholder={tr('monitorNew.modelPlaceholder')} />
        </label>
      {/if}

      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <footer>
        <button class="button secondary" type="button" disabled={creating} onclick={onClose}>{tr('devices.cancel')}</button>
        <button class="button primary" type="submit" disabled={loading || creating || !backendKey}>
          {#if creating}<span class="spinner"></span>{/if}
          {creating ? tr('monitorNew.creating') : tr('monitorNew.create')}
        </button>
      </footer>
    </form>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px; background: var(--bg-modal-backdrop); backdrop-filter: var(--blur-modal); }
  .dialog { width: min(480px, 94vw); overflow: hidden; border: 1px solid var(--bd-default); border-radius: var(--rad-lg); background: var(--bg-elevated); box-shadow: var(--sh-modal); color: var(--fg-primary); font: var(--fs-md) var(--font-ui); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px; border-bottom: 1px solid var(--bd-default); }
  header > div { display: grid; min-width: 0; }
  .eyebrow { overflow: hidden; color: var(--fg-tertiary); font: var(--fs-xs) var(--font-mono); letter-spacing: .05em; text-overflow: ellipsis; white-space: nowrap; }
  h2 { margin: 3px 0 0; font-size: var(--fs-lg); font-weight: 600; }
  form { display: grid; gap: 14px; padding: 18px; }
  label { display: grid; gap: 6px; color: var(--fg-secondary); font-size: var(--fs-sm); }
  input, select { width: 100%; height: 34px; padding: 0 10px; border: 1px solid var(--bd-default); border-radius: var(--rad-sm); background: var(--bg-input); color: var(--fg-primary); font: var(--fs-sm) var(--font-ui); outline: none; }
  input:focus, select:focus { border-color: var(--bd-focus); }
  .loading, .empty { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 100px; color: var(--fg-tertiary); }
  .error { margin: 0; color: var(--st-err); font-size: var(--fs-sm); }
  footer { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }
  .button { min-height: 32px; padding: 0 14px; border: 1px solid var(--bd-default); border-radius: var(--rad-sm); font: var(--fs-sm) var(--font-ui); cursor: pointer; }
  .button.secondary { background: transparent; color: var(--fg-secondary); }
  .button.primary { border-color: var(--acc); background: var(--acc); color: var(--fg-on-accent); }
  .button:disabled, .icon:disabled { opacity: .5; cursor: default; }
  .icon { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--rad-sm); background: transparent; color: var(--fg-secondary); cursor: pointer; }
  .icon:hover:not(:disabled) { background: var(--bg-hover); color: var(--fg-primary); }
  .spinner { width: 13px; height: 13px; border: 2px solid color-mix(in srgb, currentColor 28%, transparent); border-top-color: currentColor; border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
