<script lang="ts">
  /**
   * Settings → Extensions. Kode extensions (`kode-extension.json`) add
   * features such as the dsh conversation view or team channels. Installing,
   * enabling, disabling and removing all apply immediately; nothing here
   * requires restarting Kode.
   */
  import { open } from '@tauri-apps/plugin-dialog'
  import { extensionIpc, type ExtensionInfo } from './ipc'
  import { extensions, refreshExtensions } from './extensions'
  import { currentLocale, t } from './i18n'

  const tr = $derived.by(() => {
    void $currentLocale
    return (key: string, params?: Record<string, string | number>) => t(key, params)
  })

  let busy = $state<string | null>(null)
  let error = $state('')
  let logsFor = $state<string | null>(null)
  let logs = $state<string[]>([])
  let linkMode = $state(false)

  $effect(() => {
    void refreshExtensions().catch((e) => (error = String(e)))
  })

  async function act(key: string, work: () => Promise<unknown>) {
    busy = key
    error = ''
    try {
      await work()
      await refreshExtensions()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busy = null
    }
  }

  async function install() {
    const path = await open({ directory: true, multiple: false, title: tr('extensions.pickFolder') })
    if (typeof path !== 'string') return
    await act('install', () => extensionIpc.install(path, linkMode))
  }

  async function showLogs(ext: ExtensionInfo) {
    if (logsFor === ext.id) {
      logsFor = null
      return
    }
    logsFor = ext.id
    logs = await extensionIpc.logs(ext.id).catch(() => [])
  }

  function views(ext: ExtensionInfo) {
    return ext.manifest?.contributes.sessionViews.map((view) => view.title).join(', ') ?? ''
  }
</script>

<div class="content-head">
  <div>
    <h2>{tr('extensions.title')}</h2>
    <p class="sub">{tr('extensions.description')}</p>
  </div>
  <div class="head-actions">
    <label class="link-toggle" title={tr('extensions.linkHint')}>
      <input type="checkbox" bind:checked={linkMode} />
      <span>{tr('extensions.link')}</span>
    </label>
    <button class="btn primary sm" disabled={busy !== null} onclick={install}>
      {busy === 'install' ? tr('extensions.installing') : tr('extensions.install')}
    </button>
  </div>
</div>

{#if error}
  <div class="banner err" role="alert"><pre>{error}</pre></div>
{/if}

{#if $extensions.length === 0}
  <p class="empty">{tr('extensions.empty')}</p>
{:else}
  <ul class="list">
    {#each $extensions as ext (ext.id)}
      <li class="item" class:off={!ext.enabled}>
        <div class="item-body">
          <div class="item-title">
            <span class="name">{ext.manifest?.name ?? ext.id}</span>
            {#if ext.manifest}<span class="tag">v{ext.manifest.version}</span>{/if}
            {#if ext.linked}<span class="tag dev">{tr('extensions.linked')}</span>{/if}
            {#if ext.running}<span class="tag ok">{tr('extensions.running')}</span>{/if}
          </div>
          {#if ext.manifest?.description}
            <span class="item-desc">{ext.manifest.description}</span>
          {/if}
          <span class="item-cmd">{ext.id}{views(ext) ? ` · ${tr('extensions.views', { views: views(ext) })}` : ''}</span>
          {#if ext.error}
            <span class="item-error">{ext.error}</span>
          {/if}
          {#if logsFor === ext.id}
            <pre class="logs">{logs.length ? logs.join('\n') : tr('extensions.noLogs')}</pre>
          {/if}
        </div>
        <div class="item-actions">
          {#if ext.manifest?.backend}
            <button class="btn ghost sm" onclick={() => showLogs(ext)}>{tr('extensions.logs')}</button>
          {/if}
          {#if ext.running}
            <button class="btn ghost sm" disabled={busy !== null} onclick={() => act(`restart:${ext.id}`, () => extensionIpc.restart(ext.id))}>
              {tr('extensions.restart')}
            </button>
          {/if}
          <button
            class="btn ghost sm"
            disabled={busy !== null || (!ext.enabled && !!ext.error)}
            onclick={() => act(`toggle:${ext.id}`, () => extensionIpc.setEnabled(ext.id, !ext.enabled))}
          >
            {ext.enabled ? tr('extensions.disable') : tr('extensions.enable')}
          </button>
          <button class="btn ghost sm danger" disabled={busy !== null} onclick={() => act(`remove:${ext.id}`, () => extensionIpc.uninstall(ext.id))}>
            {tr('extensions.uninstall')}
          </button>
        </div>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .content-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-3);
    margin-bottom: var(--sp-4);
  }
  .content-head h2 {
    margin: 0;
    font-size: var(--fs-xl);
    font-weight: var(--fw-semi);
    letter-spacing: -0.01em;
  }
  .sub {
    margin: 4px 0 0;
    font-size: var(--fs-sm);
    color: var(--fg-tertiary);
  }
  .head-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    flex-shrink: 0;
  }
  .link-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-sm);
    color: var(--fg-secondary);
    cursor: pointer;
  }
  .empty {
    color: var(--fg-tertiary);
    font-size: var(--fs-sm);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .item {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg-card);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
    transition: border-color var(--t-fast), opacity var(--t-fast);
  }
  .item:hover {
    border-color: var(--bd-strong);
  }
  .item.off {
    opacity: 0.55;
  }
  .item-body {
    flex: 1;
    min-width: 0;
  }
  .item-title {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .name {
    font-size: var(--fs-md);
    font-weight: var(--fw-med);
    color: var(--fg-primary);
  }
  .item-desc {
    display: block;
    margin-top: 2px;
    font-size: var(--fs-sm);
    color: var(--fg-secondary);
  }
  .item-cmd {
    display: block;
    margin-top: 2px;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .item-error {
    display: block;
    margin-top: 4px;
    font-size: var(--fs-xs);
    color: var(--st-err);
    white-space: pre-wrap;
  }
  .tag {
    font-size: 10px;
    font-weight: var(--fw-med);
    letter-spacing: 0.02em;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--bg-chip);
    color: var(--fg-secondary);
  }
  .tag.ok {
    background: color-mix(in srgb, var(--st-ok) 18%, transparent);
    color: var(--st-ok);
  }
  .tag.dev {
    background: var(--acc-soft);
    color: var(--acc);
  }
  .item-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-shrink: 0;
  }
  .logs {
    margin: var(--sp-2) 0 0;
    max-height: 220px;
    overflow: auto;
    padding: var(--sp-2);
    border-radius: var(--rad-sm);
    background: var(--bg-pre);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--fg-secondary);
    white-space: pre-wrap;
  }
  .banner.err {
    margin-bottom: var(--sp-3);
    padding: 8px var(--sp-3);
    border-radius: var(--rad-md);
    background: color-mix(in srgb, var(--st-err) 12%, transparent);
    color: var(--st-err);
  }
  .banner.err pre {
    margin: 0;
    white-space: pre-wrap;
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-ui);
    font-size: var(--fs-md);
    font-weight: var(--fw-med);
    border-radius: var(--rad-md);
    padding: 7px 14px;
    border: 1px solid transparent;
    cursor: pointer;
  }
  .btn.sm {
    padding: 5px 11px;
    font-size: var(--fs-sm);
  }
  .btn.primary {
    background: var(--acc);
    color: var(--fg-on-accent);
  }
  .btn.primary:hover:not(:disabled) {
    background: var(--acc-hover);
  }
  .btn.ghost {
    background: transparent;
    border-color: var(--bd-default);
    color: var(--fg-secondary);
  }
  .btn.ghost:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--fg-primary);
  }
  .btn.ghost.danger:hover:not(:disabled) {
    color: var(--st-err);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
