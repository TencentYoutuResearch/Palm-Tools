<script lang="ts">
  /**
   * BackendAddPicker.svelte —— Settings → Backends → Add 的选择器。
   *
   * 列出全部已知 CLI 及本机状态:已安装 → 一键配置;未安装 → 二次确认(展示本平台
   * 实际要执行的安装命令)后自动安装,安装日志实时滚动,装完自动配置。平台差异
   * (macOS/Linux 登录 shell vs Windows PowerShell)由后端 `backend_install` 决定。
   */
  import { onMount, onDestroy, tick } from 'svelte'
  import type { UnlistenFn } from '@tauri-apps/api/event'
  import { backendAdminIpc, type BackendCatalogEntry, type BackendConfigureOutcome } from './ipc'
  import BackendIcon from './BackendIcon.svelte'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import { currentLocale, t } from './i18n'

  type Props = {
    onBack: () => void
    onCustom: () => void
    onDone: (message: string) => void
    onError: (message: string) => void
    /** 从列表「安装」按钮进来时,直接弹该 key 的安装确认。 */
    initialKey?: string | null
    /** 有确认框或安装进行中时为 true,父级 Esc 处理据此让路。 */
    locked?: boolean
  }
  let { onBack, onCustom, onDone, onError, initialKey = null, locked = $bindable(false) }: Props = $props()

  let entries: BackendCatalogEntry[] | null = $state(null)
  let working: string | null = $state(null)
  let confirming: BackendCatalogEntry | null = $state(null)
  let log: string[] = $state([])
  let logEl: HTMLPreElement | undefined = $state()
  let unlisten: UnlistenFn | null = null

  $effect(() => { locked = confirming !== null || working !== null })

  let tr = $derived.by(() => {
    void $currentLocale
    return (key: string, params?: Parameters<typeof t>[1]) => t(key, params)
  })

  // 已配置可用的沉底,其余按 已安装 → 可安装 → 其它 排
  function rank(e: BackendCatalogEntry): number {
    if (e.command_path && e.enabled) return 3
    if (e.command_path) return 0
    if (e.install_script) return 1
    return 2
  }
  let sorted: BackendCatalogEntry[] = $derived(
    [...(entries ?? ([] as BackendCatalogEntry[]))].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key))
  )

  async function load() {
    try {
      entries = await backendAdminIpc.catalog()
    } catch (e) {
      onError(String(e))
      entries = []
    }
  }

  onMount(async () => {
    unlisten = await backendAdminIpc.onInstallLog(async ({ key, line }) => {
      if (key !== working) return
      log = [...log.slice(-499), line]
      await tick()
      logEl?.scrollTo({ top: logEl.scrollHeight })
    })
    await load()
    const target = initialKey ? entries?.find((e) => e.key === initialKey) : null
    if (target && !target.command_path && target.install_script) confirming = target
  })

  onDestroy(() => unlisten?.())

  function finish(r: BackendConfigureOutcome) {
    onDone(r.mcp_warning
      ? tr('settings.backends.add.mcpWarning', { key: r.key, error: r.mcp_warning })
      : tr('settings.backends.add.done', { key: r.key }))
  }

  async function run(e: BackendCatalogEntry, install: boolean) {
    if (working) return
    working = e.key
    log = []
    try {
      finish(install ? await backendAdminIpc.install(e.key) : await backendAdminIpc.configure(e.key))
      await load()
    } catch (x) {
      onError(String(x))
      await load()
    } finally {
      working = null
    }
  }

  function startInstall() {
    const e = confirming
    confirming = null
    if (e) void run(e, true)
  }
</script>

<div class="content-head">
  <div>
    <h2>{tr('settings.backends.add.title')}</h2>
    <p class="sub">{tr('settings.backends.add.description')}</p>
  </div>
  <button class="btn ghost sm" onclick={onBack} disabled={working !== null}>{tr('settings.backends.add.back')}</button>
</div>

{#if entries === null}
  <p class="sub">{tr('settings.backends.add.loading')}</p>
{:else}
  <ul class="list">
    {#each sorted as e (e.key)}
      {@const ready = !!e.command_path && e.enabled}
      <li class="item" class:off={ready}>
        <div class="item-icon" class:installed={!!e.command_path}>
          <BackendIcon backendKey={e.key} command={e.command} size={20} muted={!e.command_path} />
        </div>
        <div class="item-body">
          <div class="item-title">
            <span class="name">{e.key}</span>
            {#if ready}
              <span class="tag ok">{tr('settings.backends.add.ready')}</span>
            {:else if e.command_path}
              <span class="tag ok">{tr('settings.backends.add.installed')}</span>
            {:else}
              <span class="tag warn">{tr('settings.backends.add.notInstalled')}</span>
            {/if}
          </div>
          {#if e.command_path}
            <code class="item-cmd" title={e.command_path}>{e.command_path}</code>
          {:else if e.install_script}
            <code class="item-cmd" title={e.install_script}>{e.install_script}</code>
          {:else if e.install_missing.length > 0}
            <span class="item-cmd plain">{tr('settings.backends.add.needs', { tools: e.install_missing.join(' / ') })}</span>
          {:else}
            <span class="item-cmd plain">{tr('settings.backends.add.manual')}</span>
          {/if}
        </div>
        <div class="item-actions">
          {#if working === e.key}
            <span class="sub">{e.command_path ? tr('settings.backends.add.configuring') : tr('settings.backends.add.installing')}</span>
          {:else if e.command_path && !ready && !e.read_only}
            <button class="btn primary sm" onclick={() => run(e, false)} disabled={working !== null}>{tr('settings.backends.add.configure')}</button>
          {:else if !e.command_path && e.install_script}
            <button class="btn ghost sm" onclick={() => (confirming = e)} disabled={working !== null}>{tr('settings.backends.add.install')}</button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>

  {#if working && log.length > 0}
    <div class="log-head">{tr('settings.backends.add.log')} · {working}</div>
    <pre class="log" bind:this={logEl}>{log.join('\n')}</pre>
  {/if}

  <div class="foot">
    <button class="link" onclick={onCustom} disabled={working !== null}>{tr('settings.backends.add.custom')}</button>
  </div>
{/if}

{#if confirming}
  <ConfirmDialog
    title={tr('settings.backends.add.confirmTitle', { key: confirming.key })}
    message={tr('settings.backends.add.confirmMessage', { key: confirming.key, script: confirming.install_script ?? '' })}
    confirmLabel={tr('settings.backends.add.install')}
    onConfirm={startInstall}
    onClose={() => (confirming = null)}
  />
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
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg-card);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
    transition: border-color var(--t-fast), opacity var(--t-fast);
  }
  .item:hover { border-color: var(--bd-strong); }
  .item.off { opacity: 0.55; }
  .item-icon {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: var(--rad-md);
    background: var(--bg-chip);
    color: var(--fg-secondary);
    border: 1px solid var(--bd-muted);
  }
  .item-icon.installed {
    background: var(--acc-soft);
    color: var(--acc);
    border-color: transparent;
  }
  .item-body { flex: 1; min-width: 0; }
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
  .item-cmd.plain { font-family: var(--font-ui); }
  .tag {
    font-size: 10px;
    font-weight: var(--fw-med);
    letter-spacing: 0.02em;
    padding: 1px 7px;
    border-radius: 999px;
    text-transform: uppercase;
  }
  .tag.ok { color: var(--st-ok); background: var(--acc-soft); }
  .tag.warn { color: var(--st-warn); background: var(--bg-chip); }
  .item-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-shrink: 0;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-ui);
    font-weight: var(--fw-med);
    border-radius: var(--rad-md);
    padding: 5px 11px;
    font-size: var(--fs-sm);
    cursor: pointer;
    border: 1px solid transparent;
    transition: all var(--t-fast);
  }
  .btn.primary { background: var(--acc); color: var(--fg-on-accent); }
  .btn.primary:hover:not(:disabled) { background: var(--acc-hover); }
  .btn.ghost {
    background: transparent;
    border-color: var(--bd-default);
    color: var(--fg-secondary);
  }
  .btn.ghost:hover:not(:disabled) { background: var(--bg-hover); color: var(--fg-primary); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .log-head {
    margin-top: var(--sp-4);
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
  }
  .log {
    margin: var(--sp-1) 0 0;
    max-height: 180px;
    overflow: auto;
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg-chip);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--fg-secondary);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .foot { margin-top: var(--sp-4); }
  .link {
    border: none;
    background: transparent;
    color: var(--acc);
    font-size: var(--fs-sm);
    font-family: inherit;
    cursor: pointer;
    padding: 0;
  }
  .link:hover { text-decoration: underline; }
  .link:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
