<script lang="ts">
  /**
   * MemorySyncPanel.svelte —— Git sync 配置面板。
   *
   * 入口:Cmd+P → "Memory: Sync settings…"
   * 模态弹窗,让用户配置 remote URL / auto_push / auto_sync。
   */
  import { onMount } from 'svelte'
  import { syncIpc, type SyncConfig } from './ipc'
  import Icon, { type IconName } from './Icon.svelte'
  import { t } from './i18n'
  import { outsidePressClose } from './outside_close'

  type Props = {
    onClose: () => void
  }
  let { onClose }: Props = $props()

  let cfg: SyncConfig | null = $state(null)
  let remoteInput = $state('')
  let autoPush = $state(false)
  let autoSync = $state(false)
  let saving = $state(false)
  let syncing = $state(false)
  let error: string | null = $state(null)
  let syncResult: string | null = $state(null)

  onMount(async () => {
    try {
      cfg = await syncIpc.getConfig()
      remoteInput = cfg.remote ?? ''
      autoPush = cfg.auto_push
      autoSync = cfg.auto_sync
    } catch (e) {
      error = t('memory.sync.loadFailed', { error: String(e) })
    }
  })

  async function save() {
    saving = true
    error = null
    try {
      await syncIpc.setConfig({
        remote: remoteInput.trim() || undefined,
        auto_push: autoPush,
        auto_sync: autoSync,
      })
      cfg = await syncIpc.getConfig()
    } catch (e) {
      error = t('memory.sync.saveFailed', { error: String(e) })
    } finally {
      saving = false
    }
  }

  async function syncNow() {
    syncing = true
    syncResult = null
    error = null
    try {
      const remote = remoteInput.trim()
      const r = await syncIpc.syncNow(remote || null)
      if (r.skipped_reason) {
        syncResult = t('memory.sync.skipped', { reason: r.skipped_reason })
      } else if (r.initialized && !r.pulled && !r.pushed && r.reconciled === 0) {
        syncResult = t('memory.sync.initialized')
      } else if (r.initialized) {
        syncResult = t('memory.sync.initializedSummary', { pulled: r.pulled, pushed: r.pushed, reconciled: r.reconciled })
      } else if (!r.pulled && !r.pushed && r.reconciled === 0) {
        syncResult = t('memory.sync.noChanges')
      } else {
        syncResult = t('memory.sync.summary', { pulled: r.pulled, pushed: r.pushed, reconciled: r.reconciled })
      }
      cfg = await syncIpc.getConfig()
    } catch (e) {
      error = t('memory.sync.failed', { error: String(e) })
    } finally {
      syncing = false
    }
  }
</script>

{#snippet sectionHeader(icon: IconName, title: string)}
  <div class="section-header">
    <span class="section-icon"><Icon name={icon} /></span>
    <span class="section-title">{title}</span>
  </div>
{/snippet}

<div class="backdrop" use:outsidePressClose={{ onClose }} role="presentation">
  <div class="panel" role="dialog">
    <header>
      <span class="status-dot"></span>
      <h2>{t('memory.sync.title')}</h2>
      <button class="close-btn" onclick={onClose} aria-label={t('memory.common.close')}><Icon name="x" /></button>
    </header>

    <div class="body">
      {#if error}
        <div class="banner banner-err">{error}</div>
      {/if}
      {#if syncResult}
        <div class="banner banner-ok">{syncResult}</div>
      {/if}

      {@render sectionHeader("link", t('memory.sync.remoteUrl'))}
      <div class="row">
        <input
          type="text"
          class="input"
          placeholder="git@github.com:you/memory.git"
          bind:value={remoteInput}
          disabled={saving}
        />
      </div>
      <p class="hint">
        {t('memory.sync.remoteHint')}
        <code>cd ~/.kode-memory/vault && git remote add origin &lt;url&gt;</code>
        — {t('memory.sync.remoteHintSuffix')}
      </p>

      <!-- Behavior -->
      <div class="section-header">
        <svg class="section-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 1v2"/><path d="M12 21v2"/><path d="M4.22 4.22l1.42 1.42"/><path d="M18.36 18.36l1.42 1.42"/><path d="M1 12h2"/><path d="M21 12h2"/><path d="M4.22 19.78l1.42-1.42"/><path d="M18.36 5.64l1.42-1.42"/>
        </svg>
        <span class="section-title">{t('memory.sync.behavior')}</span>
      </div>
      <div class="row toggle-row">
        <span class="lbl">{t('memory.sync.autoSync')}</span>
        <label class="toggle">
          <input type="checkbox" bind:checked={autoSync} disabled={saving} />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <p class="hint">{t('memory.sync.autoSyncHint')}</p>

      <div class="row toggle-row">
        <span class="lbl">{t('memory.sync.autoPush')}</span>
        <label class="toggle">
          <input type="checkbox" bind:checked={autoPush} disabled={saving} />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <p class="hint">{t('memory.sync.autoPushHint')}</p>

      <!-- Actions -->
      <div class="actions">
        <button class="btn btn-primary" onclick={save} disabled={saving}>
          {saving ? t('memory.sync.saving') : t('memory.common.save')}
        </button>
        <button class="btn btn-secondary" onclick={syncNow} disabled={syncing}>
          {syncing ? t('memory.sync.syncing') : cfg?.initialized === false ? t('memory.sync.initAndSync') : t('memory.sync.syncNow')}
        </button>
      </div>
      {#if cfg && !cfg.initialized}
        <p class="hint">{t('memory.sync.firstSyncHint')}</p>
      {/if}

      <!-- Status -->
      {#if cfg}
        <div class="status-line">
          <span>{t('memory.sync.branch')} <code>{cfg.branch}</code></span>
          {#if cfg.remote}
            <span class="remote-info">{t('memory.sync.remote')} <code>{cfg.remote}</code></span>
          {/if}
        </div>
      {/if}
    </div>
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
    width: min(540px, 88vw);
    height: 100vh;
    background: var(--bg-elevated);
    color: var(--fg-primary);
    display: flex;
    flex-direction: column;
    box-shadow: var(--sh-modal);
    animation: slide 160ms ease-out;
  }
  @keyframes slide {
    from { transform: translateX(20px); opacity: 0; }
    to   { transform: translateX(0);    opacity: 1; }
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: var(--sp-4);
    border-bottom: 1px solid var(--bd-default);
  }
  header h2 {
    margin: 0;
    flex: 1;
    font-size: var(--fs-lg);
    font-weight: var(--fw-semi);
    color: var(--fg-primary);
  }
  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--st-ok);
    flex-shrink: 0;
    box-shadow: 0 0 6px color-mix(in srgb, var(--st-ok) 40%, transparent);
    animation: statusPulse 2.5s ease-in-out infinite;
  }
  @keyframes statusPulse {
    0%, 100% { box-shadow: 0 0 4px color-mix(in srgb, var(--st-ok) 30%, transparent); }
    50% { box-shadow: 0 0 10px color-mix(in srgb, var(--st-ok) 50%, transparent), 0 0 18px color-mix(in srgb, var(--st-ok) 20%, transparent); }
  }
  .close-btn {
    background: none;
    border: none;
    color: var(--fg-tertiary);
    font-size: var(--fs-lg);
    cursor: pointer;
    padding: var(--sp-1) var(--sp-2);
    border-radius: var(--rad-sm);
  }
  .close-btn:hover { background: var(--bg-tab-hover); color: var(--fg-primary); }

  .body {
    padding: var(--sp-4);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }
  .section-icon {
    flex-shrink: 0;
    color: var(--fg-tertiary);
  }
  .section-title {
    font-size: var(--fs-md);
    font-weight: var(--fw-med);
    color: var(--fg-primary);
  }
  .section-header::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--bd-muted);
  }

  .row { display: flex; align-items: center; gap: var(--sp-2); }
  .toggle-row { justify-content: space-between; }
  .lbl { color: var(--fg-secondary); font-size: var(--fs-md); }

  .input {
    flex: 1;
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg-input);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    color: var(--fg-primary);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
  }
  .input:focus { border-color: var(--acc); outline: none; box-shadow: 0 0 0 2.5px color-mix(in srgb, var(--acc) 14%, transparent); }
  .input:disabled { opacity: 0.6; }

  .hint {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
    line-height: 1.5;
  }
  .hint code {
    background: var(--bg-input);
    padding: 1px 4px;
    border-radius: var(--rad-sm);
    font-size: var(--fs-xs);
  }

  /* Toggle switch */
  .toggle {
    position: relative;
    display: inline-block;
    width: 40px;
    height: 22px;
    flex-shrink: 0;
  }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-slider {
    position: absolute;
    inset: 0;
    background: var(--bd-strong);
    border-radius: 11px;
    transition: background var(--t-fast);
    cursor: pointer;
  }
  .toggle-slider::before {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    background: var(--fg-on-accent);
    border-radius: 50%;
    transition: transform var(--t-fast);
  }
  .toggle input:checked + .toggle-slider { background: var(--acc); box-shadow: 0 0 8px color-mix(in srgb, var(--acc) 20%, transparent); }
  .toggle input:checked + .toggle-slider::before { transform: translateX(18px); }
  .toggle input:disabled + .toggle-slider { opacity: 0.5; cursor: not-allowed; }

  .actions {
    display: flex;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }
  .btn {
    flex: 1;
    padding: var(--sp-2) var(--sp-4);
    border: none;
    border-radius: var(--rad-md);
    font-size: var(--fs-md);
    font-weight: var(--fw-med);
    cursor: pointer;
    transition: background var(--t-fast);
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--acc); color: var(--fg-on-accent); box-shadow: 0 0 10px color-mix(in srgb, var(--acc) 20%, transparent); }
  .btn-primary:hover:not(:disabled) { background: var(--acc-hover); box-shadow: 0 0 16px color-mix(in srgb, var(--acc) 28%, transparent); }
  .btn-secondary {
    background: var(--bg-tab-hover);
    color: var(--fg-secondary);
    border: 1px solid var(--bd-default);
  }
  .btn-secondary:hover:not(:disabled) { background: var(--bg-tab-active); color: var(--fg-primary); }

  .banner {
    padding: var(--sp-2) var(--sp-3);
    border-radius: var(--rad-md);
    font-size: var(--fs-sm);
    line-height: 1.4;
  }
  .banner-err { background: color-mix(in srgb, var(--st-err) 12%, transparent); color: var(--st-err); border: 1px solid color-mix(in srgb, var(--st-err) 30%, transparent); }
  .banner-ok { background: color-mix(in srgb, var(--st-ok) 12%, transparent); color: var(--st-ok); border: 1px solid color-mix(in srgb, var(--st-ok) 30%, transparent); }

  .status-line {
    display: flex;
    gap: var(--sp-4);
    padding-top: var(--sp-2);
    border-top: 1px solid var(--bd-default);
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
  }
  .status-line code {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }
  .remote-info {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
