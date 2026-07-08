<script lang="ts">
  /**
   * MemoryMcpBanner.svelte —— 引导用户给 codebuddy / claude-internal 接上 kode-memory MCP。
   *
   * 触发逻辑(后端 memory_mcp::should_prompt 决策):
   *   - 装了的 backend 全都已配置 → 不显示
   *   - 一个 backend 都没装 → 不显示
   *   - 二进制没装 → 显示,但文案换成 "请先 cargo install …"
   *   - 都齐 + 有 backend 待启用 + 未点过 dismiss → 显示一行带启用按钮(可能两个,
   *     codebuddy 和 claude-internal 各一)
   *
   * 显示位置:App.svelte main 区顶部(在 PathsBanner 下面,attention banner 上面)。
   * 不挡 tab 区域,只是一条窄横幅。
   *
   * 不写 toast 库 —— 都成功后直接换 banner 文案两秒,然后 hide。
   */
  import { onMount, onDestroy } from 'svelte'
  import { memoryMcpIpc, type MemoryMcpCheckResult, type MemoryMcpAutoSetupReport } from './ipc'
  import type { UnlistenFn } from '@tauri-apps/api/event'
  import Icon from './Icon.svelte'
  import { t } from './i18n'

  let result: MemoryMcpCheckResult | null = $state(null)
  let busy = $state(false)
  let err: string | null = $state(null)
  /** 'just-configured' = 刚成功配完 → banner 显示成功提示 2s 后自隐 */
  let phase: 'idle' | 'just-configured' = $state('idle')
  /** 命令面板触发:无视 dismissed_at + configured 状态强制显示 banner 一次。
   *  set 为 true 后只到用户点 close / [启用]/[不再提示] 才落回 false。 */
  let forceShow = $state(false)
  /** 启动时后端自动 setup 的报告(全成功 → 弹绿色 toast;有失败 → banner 展开错因) */
  let autoReport: MemoryMcpAutoSetupReport | null = $state(null)
  let unlistens: UnlistenFn[] = []

  /** 公开方法:命令面板触发时强制弹一次 banner,无视 dismiss/configured 状态 */
  export function show() {
    forceShow = true
    refresh()
  }

  async function refresh() {
    try {
      result = await memoryMcpIpc.check()
    } catch (e) {
      err = String(e)
    }
  }

  onMount(async () => {
    await refresh()
    unlistens.push(await memoryMcpIpc.onSetupRequired((r) => (result = r)))
    unlistens.push(await memoryMcpIpc.onChanged(() => refresh()))
    // 启动后 800ms 后端自动 setup 完成 → 这里收到报告。
    // - 全成功:result 已经被 onChanged 刷成"全配好",这里只负责切一下 just-configured
    //   状态让 banner 短亮一条「已自动接入 X / Y」(2.4s 后自隐)。
    // - 有失败:autoReport 留住,banner 在 normal 模式下展开错因(err 也填上)。
    unlistens.push(
      await memoryMcpIpc.onAutoConfigured(async (r) => {
        autoReport = r
        await refresh()
        const anyFailed = r.attempts.some((a) => !a.success)
        if (anyFailed) {
          // 取第一个失败拼成 err 文案(stdout/stderr 已在 backend 拼好了)
          const failed = r.attempts.find((a) => !a.success)
          if (failed) err = `${failed.backend}: ${failed.error}`
        } else {
          phase = 'just-configured'
          setTimeout(() => {
            phase = 'idle'
          }, 2400)
        }
      })
    )
  })

  onDestroy(() => {
    for (const u of unlistens) u()
  })

  // banner 是否要显示。规则跟后端 should_prompt 镜像 —— 但这里我们也允许
  // "已配置 + just-configured" 短暂亮起一下,让用户看到成功反馈。
  let visible = $derived.by(() => {
    if (!result) return false
    if (phase === 'just-configured') return true
    if (forceShow) return true
    // 装了的 backend 全都已配置 → 不需要 banner
    const cbPending = result.codebuddy_available && !result.configured_for_codebuddy
    const ciPending = result.claude_internal_available && !result.configured_for_claude_internal
    if (!cbPending && !ciPending) return false
    if (result.dismissed_at != null) return false
    return true
  })

  /// banner 主文案与按钮分支。状态:
  ///   - just-configured → 成功提示
  ///   - binary 缺 → 安装指引 + 复制命令按钮
  ///   - 都没装 backend → cli-missing(理论上 should_prompt 已过滤,这里兜底)
  ///   - 默认 → 列出待启用 backend(codebuddy / claude-internal 各一个按钮)
  let mode = $derived.by<'success' | 'binary-missing' | 'cli-missing' | 'normal'>(() => {
    if (phase === 'just-configured') return 'success'
    if (!result?.codebuddy_available && !result?.claude_internal_available) return 'cli-missing'
    if (!result?.binary_available) return 'binary-missing'
    return 'normal'
  })

  /// 各 backend 是否还差配置(对应一个按钮要不要显示)
  let cbPending = $derived.by(() => {
    if (!result) return false
    return result.codebuddy_available && !result.configured_for_codebuddy
  })
  let ciPending = $derived.by(() => {
    if (!result) return false
    return result.claude_internal_available && !result.configured_for_claude_internal
  })

  const INSTALL_CMD = 'cargo install --path crates/kode-memory --bin kode-memory-mcp' // dev fallback only

  async function enableCodebuddy() {
    if (busy) return
    busy = true
    err = null
    try {
      console.log('[memory-mcp] invoke setupCodebuddy …')
      await memoryMcpIpc.setupCodebuddy()
      console.log('[memory-mcp] setupCodebuddy OK')
      // 后端会 emit memory-mcp-changed 触发 refresh。两家都配好了才走 success 文案;
      // 否则 banner 仍然 visible 来配剩下的那家。
      await refresh()
      if (result && !cbPending && !ciPending) {
        phase = 'just-configured'
        setTimeout(() => { phase = 'idle' }, 2400)
      }
    } catch (e) {
      err = String(e)
      console.error('[memory-mcp] setupCodebuddy failed:', e)
    } finally {
      busy = false
    }
  }

  async function enableClaudeInternal() {
    if (busy) return
    busy = true
    err = null
    try {
      console.log('[memory-mcp] invoke setupClaudeInternal …')
      await memoryMcpIpc.setupClaudeInternal()
      console.log('[memory-mcp] setupClaudeInternal OK')
      await refresh()
      if (result && !cbPending && !ciPending) {
        phase = 'just-configured'
        setTimeout(() => { phase = 'idle' }, 2400)
      }
    } catch (e) {
      err = String(e)
      console.error('[memory-mcp] setupClaudeInternal failed:', e)
    } finally {
      busy = false
    }
  }

  async function dismiss() {
    if (busy) return
    busy = true
    try {
      await memoryMcpIpc.dismiss()
      await refresh()
    } catch (e) {
      err = String(e)
    } finally {
      busy = false
    }
  }

  async function copyInstallCmd() {
    try {
      await navigator.clipboard.writeText(INSTALL_CMD)
    } catch {
      /* fail silently — 用户能看到命令文本,自己选择复制 */
    }
  }
</script>

{#if visible}
  <div class="banner" role="status" aria-live="polite">
    {#if mode === 'success'}
      <span class="ico"><Icon name="check" /></span>
      <span class="msg">
        {#if autoReport && autoReport.attempts.length > 0}
          {t('memory.mcp.successAuto', { backends: autoReport.attempts.filter((a) => a.success).map((a) => a.backend).join(' + ') })}
        {:else}
          {t('memory.mcp.success')}
        {/if}
      </span>
    {:else if mode === 'cli-missing'}
      <span class="ico warn"><Icon name="alert-triangle" /></span>
      <span class="msg">
        {t('memory.mcp.cliMissing')}
      </span>
      <button class="btn" onclick={dismiss} disabled={busy}>{t('memory.mcp.dismiss')}</button>
    {:else if mode === 'binary-missing'}
      <span class="ico warn"><Icon name="alert-triangle" /></span>
      <span class="msg">
        {t('memory.mcp.binaryMissing')}
        <code class="cmd">{INSTALL_CMD}</code>
      </span>
      <button class="btn" onclick={copyInstallCmd}>{t('memory.mcp.copyCommand')}</button>
      <button class="btn" onclick={dismiss} disabled={busy}>{t('memory.mcp.dismiss')}</button>
    {:else}
      <span class="ico"><Icon name="star" /></span>
      <span class="msg">
        <strong>{t('memory.mcp.enableTitle')}</strong> —
        {t('memory.mcp.enableDescription')}
        {#if cbPending && ciPending}
          {t('memory.mcp.pendingBoth')}
        {:else if cbPending}
          {t('memory.mcp.pendingOne', { backend: 'codebuddy' })}
        {:else if ciPending}
          {t('memory.mcp.pendingOne', { backend: 'claude-internal' })}
        {/if}
      </span>
      {#if cbPending}
        <button class="btn primary" onclick={enableCodebuddy} disabled={busy}>
          {busy ? t('memory.mcp.configuring') : t('memory.mcp.enableBackend', { backend: 'codebuddy' })}
        </button>
      {/if}
      {#if ciPending}
        <button class="btn primary" onclick={enableClaudeInternal} disabled={busy}>
          {busy ? t('memory.mcp.configuring') : t('memory.mcp.enableBackend', { backend: 'claude-internal' })}
        </button>
      {/if}
      <button class="btn" onclick={dismiss} disabled={busy}>{t('memory.mcp.dismiss')}</button>
    {/if}
    {#if err}
      <pre class="err" title={err}>{t('memory.mcp.failed', { error: err })}</pre>
    {/if}
    <!-- close 按钮(临时,不写盘):在 forceShow 模式或者已显示 success 时让用户能手动关。 -->
    <button class="close" aria-label={t('memory.common.close')} title={t('memory.mcp.closeTitle')} onclick={() => { forceShow = false; phase = 'idle'; err = null; }}><Icon name="x" /></button>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--bd-default);
    box-shadow: 0 1px 0 color-mix(in srgb, var(--acc) 6%, transparent);
    font-size: 12.5px;
    color: var(--fg-secondary);
    flex-wrap: wrap;
  }
  .ico {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--acc-soft);
    color: var(--acc);
  }
  .ico.warn {
    background: color-mix(in srgb, var(--st-err) 18%, transparent);
    color: var(--st-err);
  }
  .msg {
    flex: 1 1 auto;
    min-width: 220px;
    color: var(--fg-primary);
  }
  .msg code {
    background: var(--bg-base);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 11.5px;
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  }
  .msg .cmd {
    display: inline-block;
    margin-left: 4px;
    padding: 2px 7px;
    color: var(--fg-primary);
    border: 1px solid var(--bd-default);
  }
  .btn {
    flex: 0 0 auto;
    padding: 4px 10px;
    background: transparent;
    color: var(--fg-secondary);
    border: 1px solid var(--bd-default);
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    transition: background var(--t-fast, 150ms), border-color var(--t-fast, 150ms), color var(--t-fast, 150ms);
  }
  .btn:hover:not(:disabled) {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn.primary {
    background: var(--acc);
    color: var(--fg-on-accent);
    border-color: var(--acc);
  }
  .btn.primary:hover:not(:disabled) {
    background: var(--acc-hover);
  }
  .err {
    flex: 1 0 100%;
    color: var(--st-err);
    font-size: 11.5px;
    margin: 4px 0 0;
    padding: 6px 8px;
    background: color-mix(in srgb, var(--st-err) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--st-err) 30%, transparent);
    border-radius: 4px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 180px;
    overflow: auto;
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  }
  .close {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--fg-tertiary);
    cursor: pointer;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .close:hover { background: var(--bg-tab-hover); color: var(--fg-primary); }
</style>
