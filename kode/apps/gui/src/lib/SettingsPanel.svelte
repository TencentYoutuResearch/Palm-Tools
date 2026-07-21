<script lang="ts">
  /**
   * SettingsPanel.svelte —— 统一设置面板(2026-06,重做)。
   *
   * 分栏布局:左侧导航(Backends / Memory),右侧内容。把 backend 的
   * 开关 / 增删改 / PATH 探测全部整合进来,**不再跳二级 BackendManagePanel**——
   * 编辑表单 inline 展开,解决「编辑框跑到底部」的问题。
   *
   * enabled 实时性:后端 list_all_backends 读 config.toml 真实 enabled,
   * 开关 / 探测落地写盘后当前进程立刻反映;已 spawn 的 tab 不受影响,
   * BackendChooser 下次打开即生效。
   */
  import { onMount, onDestroy } from 'svelte'
  import { ipc, backendAdminIpc, memoryMcpIpc } from './ipc'
  import type {
    BackendListItem,
    DetectedBackend,
    BackendSaveRequest,
    MemoryMcpCheckResult,
    LocaleMode,
  } from './ipc'
  import type { UnlistenFn } from '@tauri-apps/api/event'
  import BackendIcon from './BackendIcon.svelte'
  import { currentLocale, systemLanguageLabel, t } from './i18n'
  import {
    TERMINAL_FONT_PRESETS,
    TERMINAL_FONT_SIZE_MAX,
    TERMINAL_FONT_SIZE_MIN,
    loadTerminalAppearance,
    saveTerminalAppearance,
    type TerminalAppearance,
    type TerminalTarget,
    type TerminalThemeMode,
  } from './terminal_settings'
  import { outsidePressClose } from './outside_close'

  type Props = {
    onClose: () => void
    onOpenMemorySync: () => void
    locale: LocaleMode
    onLocaleChange: (locale: LocaleMode) => void
  }
  let { onClose, onOpenMemorySync, locale, onLocaleChange }: Props = $props()

  type Tab = 'backends' | 'memory' | 'terminal' | 'language'
  let tab: Tab = $state('backends')

  let backends: BackendListItem[] = $state([])
  let detected: DetectedBackend[] = $state([])
  let mcp: MemoryMcpCheckResult | null = $state(null)
  let busy = $state(false)
  let err: string | null = $state(null)
  let toast: string | null = $state(null)
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  let unlistens: UnlistenFn[] = []

  /** inline 编辑表单。null = 不在编辑。 */
  let editing: BackendSaveRequest | null = $state(null)
  /** 正在编辑的是否为「新增」(决定 key 输入框是否可改)。 */
  let isNew = $state(false)

  let memoryPromptEnabled = $state(true)
  let ptyAppearance = $state<TerminalAppearance>(loadTerminalAppearance('pty'))
  let shellAppearance = $state<TerminalAppearance>(loadTerminalAppearance('shell'))

  function showToast(msg: string) {
    toast = msg
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toast = null }, 2800)
  }

  async function refreshBackends() {
    try {
      const [bs, det, m] = await Promise.all([
        ipc.listAllBackends(),
        backendAdminIpc.detect(),
        memoryMcpIpc.check(),
      ])
      backends = bs
      detected = det
      mcp = m
    } catch (e) {
      err = String(e)
    }
  }

  async function refreshMemoryPrompt() {
    try {
      const ps = await memoryMcpIpc.promptStatus()
      memoryPromptEnabled = ps.enabled
    } catch {
      /* 老后端可能没这个 command,静默 */
    }
  }

  onMount(async () => {
    window.addEventListener('keydown', onKeyCapture, { capture: true })
    await Promise.all([refreshBackends(), refreshMemoryPrompt()])
    unlistens.push(await backendAdminIpc.onChanged(refreshBackends))
    unlistens.push(await memoryMcpIpc.onChanged(refreshBackends))
  })

  onDestroy(() => {
    window.removeEventListener('keydown', onKeyCapture, { capture: true })
    for (const u of unlistens) u()
    if (toastTimer) clearTimeout(toastTimer)
  })

  // ---- backend 开关 ----
  async function toggleEnabled(b: BackendListItem) {
    if (busy) return
    busy = true
    const next = !b.enabled
    b.enabled = next // 乐观更新
    try {
      await backendAdminIpc.setEnabled(b.key, next)
      showToast(`"${b.key}" ${next ? 'enabled' : 'disabled'}`)
    } catch (e) {
      b.enabled = !next
      err = String(e)
    } finally {
      busy = false
    }
  }

  // ---- 编辑 / 新增 ----
  function newRequest(seed?: Partial<BackendSaveRequest>): BackendSaveRequest {
    return {
      key: seed?.key ?? '',
      command: seed?.command ?? '',
      args: seed?.args ?? [],
      default_model: seed?.default_model ?? null,
      model_flag: seed?.model_flag ?? '--model',
      permission_mode_flag: seed?.permission_mode_flag ?? null,
      setup_style: seed?.setup_style ?? 'none',
      setup_cli: seed?.setup_cli ?? '',
      setup_json_path: seed?.setup_json_path ?? '',
      enabled: seed?.enabled ?? null,
    }
  }

  function startAdd() {
    editing = newRequest()
    isNew = true
    err = null
  }

  function startAddFromDetected(d: DetectedBackend) {
    editing = newRequest({
      key: d.suggested_key,
      command: d.command,
      permission_mode_flag: d.suggested_key === 'codex' ? '--ask-for-approval' : '--permission-mode',
      setup_style: d.suggested_setup_style,
      setup_cli: d.suggested_setup_cli,
      setup_json_path: d.suggested_json_path ?? '',
    })
    isNew = true
    err = null
  }

  function startEdit(b: BackendListItem) {
    editing = newRequest({
      key: b.key,
      command: b.command,
      default_model: b.default_model,
    })
    isNew = false
    err = null
  }

  function cancelEdit() {
    editing = null
    err = null
  }

  async function saveEditing() {
    if (!editing) return
    const e = editing
    if (!e.key.trim()) { err = 'Key cannot be empty'; return }
    if (!e.command.trim()) { err = 'Command cannot be empty'; return }
    busy = true
    err = null
    try {
      await backendAdminIpc.save(e)
      editing = null
      showToast(`Saved "${e.key}"`)
      await refreshBackends()
    } catch (x) {
      err = String(x)
    } finally {
      busy = false
    }
  }

  async function deleteBackend(key: string) {
    if (!confirm(`Delete backend "${key}"? This removes it from config.toml.`)) return
    busy = true
    err = null
    try {
      await backendAdminIpc.delete(key)
      showToast(`Deleted "${key}"`)
      await refreshBackends()
    } catch (x) {
      err = String(x)
    } finally {
      busy = false
    }
  }

  async function toggleMemoryPrompt() {
    const next = !memoryPromptEnabled
    try {
      await memoryMcpIpc.promptSetEnabled(next)
      memoryPromptEnabled = next
      showToast(t('settings.memory.promptToast', {
        state: next ? t('settings.state.enabled') : t('settings.state.disabled'),
      }))
    } catch (e) {
      err = String(e)
    }
  }

  function changeLocale(next: LocaleMode) {
    onLocaleChange(next)
    const label = next === 'system'
      ? `${t('settings.language.system')} (${systemLanguageLabel()})`
      : next === 'zh-CN'
        ? t('settings.language.chinese')
        : t('settings.language.english')
    showToast(t('settings.language.saved', { language: label }))
  }

  function appearanceFor(target: TerminalTarget): TerminalAppearance {
    return target === 'pty' ? ptyAppearance : shellAppearance
  }

  function setAppearance(target: TerminalTarget, next: TerminalAppearance) {
    const saved = saveTerminalAppearance(target, next)
    if (target === 'pty') ptyAppearance = saved
    else shellAppearance = saved
  }

  function setTerminalFontFamily(target: TerminalTarget, value: string) {
    setAppearance(target, { ...appearanceFor(target), fontFamily: value })
  }

  function setTerminalFontSize(target: TerminalTarget, value: number) {
    setAppearance(target, { ...appearanceFor(target), fontSize: value })
  }

  function setTerminalThemeMode(target: TerminalTarget, value: TerminalThemeMode) {
    setAppearance(target, { ...appearanceFor(target), themeMode: value })
  }

  function resetTerminalAppearance(target: TerminalTarget) {
    const current = appearanceFor(target)
    const defaultFamily = target === 'pty'
      ? '"JetBrains Mono", "SF Mono", Menlo, monospace'
      : 'SF Mono'
    setAppearance(target, { ...current, fontFamily: defaultFamily, fontSize: 13, themeMode: 'system' })
  }

  function terminalTargetLabel(target: TerminalTarget): string {
    return target === 'pty' ? tr('settings.terminal.mainPty') : tr('settings.terminal.shell')
  }

  function onKeyCapture(e: KeyboardEvent) {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (editing) cancelEdit()
    else onClose()
  }

  // 派生:installed 状态 + 排序
  function isInstalled(key: string): boolean | null {
    const s = mcp?.backends?.[key]
    return s ? s.command_available : null
  }
  let sortedBackends = $derived(
    [...backends].sort((a, b) => {
      // 已安装的排前面,然后按 key
      const ia = isInstalled(a.key) === true ? 0 : 1
      const ib = isInstalled(b.key) === true ? 0 : 1
      if (ia !== ib) return ia - ib
      return a.key.localeCompare(b.key)
    })
  )
  let enabledCount = $derived(backends.filter((b) => b.enabled).length)
  // 探测到但还没加进 config 的(可一键添加)
  let addable = $derived(detected.filter((d) => !d.already_in_config))
  let needsCli = $derived.by(() => {
    const style = editing?.setup_style
    return style === 'codebuddy' || style === 'claude' || style === 'codex'
  })
  let tr = $derived.by(() => {
    void $currentLocale
    return (key: string, params?: Parameters<typeof t>[1]) => t(key, params)
  })
</script>

<div class="backdrop" use:outsidePressClose={{ onClose }} role="presentation">
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-label={tr('settings.title')}
    data-locale={$currentLocale}
    tabindex="-1"
  >
    <!-- ============ 左侧导航 ============ -->
    <nav class="nav">
      <div class="nav-brand">{tr('settings.title')}</div>
      <button class="nav-item" class:active={tab === 'backends'} onclick={() => (tab = 'backends')}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" />
          <circle cx="7" cy="7" r="0.6" fill="currentColor" /><circle cx="7" cy="17" r="0.6" fill="currentColor" />
        </svg>
        <span>{tr('settings.backends.title')}</span>
        <span class="nav-badge">{enabledCount}</span>
      </button>
      <button class="nav-item" class:active={tab === 'memory'} onclick={() => (tab = 'memory')}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v18M5 7a3 3 0 0 1 3-3h.5a3 3 0 0 1 3 3M5 7a3 3 0 0 0-3 3v4a3 3 0 0 0 3 3M19 7a3 3 0 0 0-3-3h-.5a3 3 0 0 0-3 3M19 7a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3" />
        </svg>
        <span>{tr('settings.memory.title')}</span>
      </button>
      <button class="nav-item" class:active={tab === 'terminal'} onclick={() => (tab = 'terminal')}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <span>{tr('settings.terminal.title')}</span>
      </button>
      <button class="nav-item" class:active={tab === 'language'} onclick={() => (tab = 'language')}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 5h10M9 3v2m1.5 0a12 12 0 0 1-5 9M6 9a12 12 0 0 0 5 5M14 19l4-9 4 9M15.5 16h5" />
        </svg>
        <span>{tr('settings.language.title')}</span>
      </button>
      <div class="nav-spacer"></div>
      <button class="nav-close" onclick={onClose} aria-label={tr('settings.close')}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
        <span>{tr('settings.close')}</span>
        <kbd>esc</kbd>
      </button>
    </nav>

    <!-- ============ 右侧内容 ============ -->
    <div class="content">
      {#if err}
        <div class="banner err" role="alert">
          <span>{err}</span>
          <button class="banner-x" onclick={() => (err = null)} aria-label={tr('settings.dismiss')}>✕</button>
        </div>
      {/if}

      {#if tab === 'backends'}
        {#if editing}
          <!-- ===== inline 编辑表单 ===== -->
          <div class="content-head">
            <h2>{isNew ? 'Add backend' : `Edit "${editing.key}"`}</h2>
            <p class="sub">Backends are AI CLIs launched in a new tab.</p>
          </div>

          <div class="form">
            <div class="field">
              <label for="be-key">Key</label>
              <input
                id="be-key"
                type="text"
                bind:value={editing.key}
                placeholder="codebuddy"
                spellcheck="false"
                autocomplete="off"
                disabled={!isNew}
              />
              <p class="hint">TOML section name <code>[backends.&lt;key&gt;]</code>. {isNew ? '' : 'Cannot be changed.'}</p>
            </div>

            <div class="field">
              <label for="be-cmd">Command</label>
              <input
                id="be-cmd"
                type="text"
                bind:value={editing.command}
                placeholder="codebuddy"
                spellcheck="false"
                autocomplete="off"
              />
              <p class="hint">Executable name (resolved via PATH) or an absolute path.</p>
            </div>

            <div class="field-row">
              <div class="field">
                <label for="be-mflag">Model flag</label>
                <input id="be-mflag" type="text" value={editing.model_flag ?? ''} oninput={(e) => editing && (editing.model_flag = (e.target as HTMLInputElement).value || null)} placeholder="--model" spellcheck="false" autocomplete="off" />
              </div>
              <div class="field">
                <label for="be-pflag">Permission flag</label>
                <input id="be-pflag" type="text" value={editing.permission_mode_flag ?? ''} oninput={(e) => editing && (editing.permission_mode_flag = (e.target as HTMLInputElement).value || null)} placeholder="--permission-mode" spellcheck="false" autocomplete="off" />
              </div>
            </div>

            <div class="field">
              <label for="be-style">Memory MCP setup</label>
              <select id="be-style" value={editing.setup_style ?? 'none'} onchange={(e) => editing && (editing.setup_style = (e.target as HTMLSelectElement).value)}>
                <option value="none">None — don't auto-link memory</option>
                <option value="codebuddy">codebuddy (commander.js style)</option>
                <option value="claude">claude (uses -- separator)</option>
                <option value="codex">codex (uses --env and --)</option>
                <option value="json-merge">json-merge (write JSON directly)</option>
              </select>
              <p class="hint">How kode wires the memory MCP into this CLI on startup.</p>
            </div>

            {#if needsCli}
              <div class="field">
                <label for="be-cli">Setup CLI</label>
                <input id="be-cli" type="text" value={editing.setup_cli ?? ''} oninput={(e) => editing && (editing.setup_cli = (e.target as HTMLInputElement).value)} placeholder="codebuddy" spellcheck="false" autocomplete="off" />
                <p class="hint">CLI used to run <code>mcp add</code>. Usually same as Command.</p>
              </div>
            {/if}

            {#if editing.setup_style === 'json-merge'}
              <div class="field">
                <label for="be-json">Config JSON path</label>
                <input id="be-json" type="text" value={editing.setup_json_path ?? ''} oninput={(e) => editing && (editing.setup_json_path = (e.target as HTMLInputElement).value)} placeholder="~/.codex/mcp.json" spellcheck="false" autocomplete="off" />
                <p class="hint">kode merges <code>mcpServers.memory</code> into this file. <code>~</code> expands.</p>
              </div>
            {/if}
          </div>

          <div class="form-actions">
            <button class="btn ghost" onclick={cancelEdit} disabled={busy}>Cancel</button>
            <button class="btn primary" onclick={saveEditing} disabled={busy}>
              {busy ? 'Saving…' : 'Save backend'}
            </button>
          </div>
        {:else}
          <!-- ===== backend 列表 ===== -->
          <div class="content-head">
            <div>
              <h2>{tr('settings.backends.title')}</h2>
              <p class="sub">{tr('settings.backends.description')}</p>
            </div>
            <button class="btn primary sm" onclick={startAdd} disabled={busy}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
              Add
            </button>
          </div>

          <ul class="list">
            {#each sortedBackends as b (b.key)}
              {@const inst = isInstalled(b.key)}
              <li class="item" class:off={!b.enabled}>
                <div class="item-icon" class:installed={inst === true} class:missing={inst === false}>
                  <BackendIcon backendKey={b.key} command={b.command} size={20} muted={inst === false} />
                </div>
                <div class="item-body">
                  <div class="item-title">
                    <span class="name">{b.key}</span>
                    {#if inst === true}
                      <span class="tag ok">installed</span>
                    {:else if inst === false}
                      <span class="tag warn">not on PATH</span>
                    {/if}
                    {#if b.default_model}
                      <span class="tag dim">{b.default_model}</span>
                    {/if}
                  </div>
                  <code class="item-cmd">{b.command}</code>
                </div>
                <div class="item-actions">
                  <button class="icon-btn" onclick={() => startEdit(b)} disabled={busy} title="Edit" aria-label={`Edit ${b.key}`}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                  </button>
                  <button class="icon-btn danger" onclick={() => deleteBackend(b.key)} disabled={busy} title="Delete" aria-label={`Delete ${b.key}`}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                  </button>
                  <button
                    class="switch"
                    class:on={b.enabled}
                    onclick={() => toggleEnabled(b)}
                    disabled={busy}
                    role="switch"
                    aria-checked={b.enabled}
                    aria-label={`Toggle ${b.key}`}
                    title={b.enabled ? 'Enabled' : 'Disabled'}
                  >
                    <span class="knob"></span>
                  </button>
                </div>
              </li>
            {/each}
          </ul>

          {#if addable.length > 0}
            <div class="detect">
              <div class="detect-head">
                <span>Detected on PATH</span>
                <button class="link" onclick={refreshBackends} disabled={busy}>Re-scan</button>
              </div>
              <div class="detect-chips">
                {#each addable as d (d.command_path)}
                  <button class="chip-add" onclick={() => startAddFromDetected(d)} disabled={busy} title={d.command_path}>
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
                    <BackendIcon backendKey={d.suggested_key} command={d.command} size={14} />
                    {d.suggested_key}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        {/if}
      {:else if tab === 'memory'}
        <div class="content-head">
          <h2>{tr('settings.memory.title')}</h2>
          <p class="sub">{tr('settings.memory.description')}</p>
        </div>

        <ul class="list">
          <li class="item">
            <div class="item-body">
              <div class="item-title"><span class="name">{tr('settings.memory.promptInjection')}</span></div>
              <span class="item-cmd plain">
                {memoryPromptEnabled
                  ? tr('settings.memory.promptEnabled')
                  : tr('settings.memory.promptDisabled')}
              </span>
            </div>
            <div class="item-actions">
              <button class="switch" class:on={memoryPromptEnabled} onclick={toggleMemoryPrompt} role="switch" aria-checked={memoryPromptEnabled} aria-label="Toggle memory prompt injection">
                <span class="knob"></span>
              </button>
            </div>
          </li>
          <li class="item">
            <div class="item-body">
              <div class="item-title"><span class="name">{tr('settings.memory.gitSync')}</span></div>
              <span class="item-cmd plain">{tr('settings.memory.gitSyncDescription')}</span>
            </div>
            <div class="item-actions">
              <button class="btn ghost sm" onclick={onOpenMemorySync}>{tr('settings.configure')}</button>
            </div>
          </li>
        </ul>
      {:else if tab === 'terminal'}
        <div class="content-head">
          <h2>{tr('settings.terminal.title')}</h2>
          <p class="sub">{tr('settings.terminal.description')}</p>
        </div>

        <div class="form terminal-form">
          <section class="terminal-card">
            <div class="terminal-card-head">
              <div>
                <h3>{terminalTargetLabel('pty')}</h3>
                <p>{tr('settings.terminal.mainPtyDescription')}</p>
              </div>
              <button class="btn ghost sm" onclick={() => resetTerminalAppearance('pty')}>{tr('settings.terminal.reset')}</button>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="pty-font-family">{tr('settings.terminal.fontFamily')}</label>
                <input
                  id="pty-font-family"
                  type="text"
                  list="terminal-font-presets"
                  value={ptyAppearance.fontFamily}
                  oninput={(e) => setTerminalFontFamily('pty', (e.target as HTMLInputElement).value)}
                  spellcheck="false"
                  autocomplete="off"
                />
              </div>
              <div class="field size-field">
                <label for="pty-font-size">{tr('settings.terminal.fontSize')}</label>
                <input
                  id="pty-font-size"
                  type="number"
                  min={TERMINAL_FONT_SIZE_MIN}
                  max={TERMINAL_FONT_SIZE_MAX}
                  value={ptyAppearance.fontSize}
                  oninput={(e) => setTerminalFontSize('pty', Number((e.target as HTMLInputElement).value))}
                />
              </div>
            </div>
            <div class="field">
              <label for="pty-theme">{tr('settings.terminal.themeMode')}</label>
              <select id="pty-theme" value={ptyAppearance.themeMode} onchange={(e) => setTerminalThemeMode('pty', (e.target as HTMLSelectElement).value as TerminalThemeMode)}>
                <option value="system">{tr('settings.terminal.followApp')}</option>
                <option value="dark">{tr('settings.terminal.dark')}</option>
                <option value="light">{tr('settings.terminal.light')}</option>
              </select>
            </div>
          </section>

          <section class="terminal-card">
            <div class="terminal-card-head">
              <div>
                <h3>{terminalTargetLabel('shell')}</h3>
                <p>{tr('settings.terminal.shellDescription')}</p>
              </div>
              <button class="btn ghost sm" onclick={() => resetTerminalAppearance('shell')}>{tr('settings.terminal.reset')}</button>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="shell-font-family">{tr('settings.terminal.fontFamily')}</label>
                <input
                  id="shell-font-family"
                  type="text"
                  list="terminal-font-presets"
                  value={shellAppearance.fontFamily}
                  oninput={(e) => setTerminalFontFamily('shell', (e.target as HTMLInputElement).value)}
                  spellcheck="false"
                  autocomplete="off"
                />
              </div>
              <div class="field size-field">
                <label for="shell-font-size">{tr('settings.terminal.fontSize')}</label>
                <input
                  id="shell-font-size"
                  type="number"
                  min={TERMINAL_FONT_SIZE_MIN}
                  max={TERMINAL_FONT_SIZE_MAX}
                  value={shellAppearance.fontSize}
                  oninput={(e) => setTerminalFontSize('shell', Number((e.target as HTMLInputElement).value))}
                />
              </div>
            </div>
            <div class="field">
              <label for="shell-theme">{tr('settings.terminal.themeMode')}</label>
              <select id="shell-theme" value={shellAppearance.themeMode} onchange={(e) => setTerminalThemeMode('shell', (e.target as HTMLSelectElement).value as TerminalThemeMode)}>
                <option value="system">{tr('settings.terminal.followApp')}</option>
                <option value="dark">{tr('settings.terminal.dark')}</option>
                <option value="light">{tr('settings.terminal.light')}</option>
              </select>
            </div>
          </section>

          <datalist id="terminal-font-presets">
            {#each TERMINAL_FONT_PRESETS as font}
              <option value={font}></option>
            {/each}
          </datalist>
        </div>
      {:else if tab === 'language'}
        <div class="content-head">
          <h2>{tr('settings.language.title')}</h2>
          <p class="sub">{tr('settings.language.description')}</p>
        </div>

        <div class="form">
          <div class="segmented">
            <button class:active={locale === 'system'} onclick={() => changeLocale('system')}>
              {tr('settings.language.system')}
              <span>{systemLanguageLabel()}</span>
            </button>
            <button class:active={locale === 'en'} onclick={() => changeLocale('en')}>
              {tr('settings.language.english')}
              <span>en</span>
            </button>
            <button class:active={locale === 'zh-CN'} onclick={() => changeLocale('zh-CN')}>
              {tr('settings.language.chinese')}
              <span>zh-CN</span>
            </button>
          </div>
        </div>
      {/if}
    </div>

    {#if toast}
      <div class="toast" role="status">{toast}</div>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-modal-backdrop);
    z-index: 820;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: var(--blur-modal);
    -webkit-backdrop-filter: var(--blur-modal);
  }
  .dialog {
    position: relative;
    display: grid;
    grid-template-columns: 184px 1fr;
    width: 760px;
    max-width: 94vw;
    height: 560px;
    max-height: 88vh;
    background: var(--bg-elevated);
    border-radius: var(--rad-lg);
    box-shadow: var(--sh-lg);
    color: var(--fg-primary);
    font-family: var(--font-ui);
    overflow: hidden;
  }

  /* ---- 左侧导航 ---- */
  .nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--sp-3);
    background: var(--bg-sidebar);
    border-right: 1px solid var(--bd-default);
  }
  .nav-brand {
    font-size: var(--fs-xs);
    font-weight: var(--fw-semi);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-tertiary);
    padding: var(--sp-2) var(--sp-2) var(--sp-3);
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-2);
    border: none;
    background: transparent;
    border-radius: var(--rad-md);
    color: var(--fg-secondary);
    font-size: var(--fs-md);
    font-family: inherit;
    cursor: pointer;
    text-align: left;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .nav-item:hover {
    background: var(--bg-hover);
    color: var(--fg-primary);
  }
  .nav-item.active {
    background: var(--bg-selected);
    color: var(--fg-primary);
    font-weight: var(--fw-med);
  }
  .nav-item svg { flex-shrink: 0; opacity: 0.85; }
  .nav-item span:first-of-type { flex: 1; }
  .nav-badge {
    font-size: var(--fs-xs);
    font-weight: var(--fw-med);
    color: var(--acc);
    background: var(--acc-soft);
    border-radius: 999px;
    padding: 1px 7px;
    min-width: 18px;
    text-align: center;
  }
  .nav-spacer { flex: 1; }
  .nav-close {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2);
    border: none;
    background: transparent;
    border-radius: var(--rad-md);
    color: var(--fg-tertiary);
    font-size: var(--fs-sm);
    font-family: inherit;
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .nav-close:hover { background: var(--bg-hover); color: var(--fg-primary); }
  .nav-close span { flex: 1; text-align: left; }
  .nav-close kbd {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--fg-tertiary);
    background: var(--bg-chip);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-sm);
    padding: 1px 5px;
  }

  /* ---- 右侧内容 ---- */
  .content {
    display: flex;
    flex-direction: column;
    padding: var(--sp-5);
    overflow-y: auto;
  }
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
  .content-head .sub {
    margin: 4px 0 0;
    font-size: var(--fs-sm);
    color: var(--fg-tertiary);
  }

  /* ---- 列表 ---- */
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
    font-size: var(--fs-md);
    font-weight: var(--fw-semi);
    background: var(--bg-chip);
    color: var(--fg-secondary);
    border: 1px solid var(--bd-muted);
  }
  .item-icon.installed {
    background: var(--acc-soft);
    color: var(--acc);
    border-color: transparent;
  }
  .item-icon.missing { color: var(--fg-tertiary); }
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
  .tag.dim {
    color: var(--fg-tertiary);
    background: var(--bg-chip);
    text-transform: none;
    font-family: var(--font-mono);
    letter-spacing: 0;
  }
  .item-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-shrink: 0;
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: none;
    background: transparent;
    border-radius: var(--rad-sm);
    color: var(--fg-tertiary);
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .icon-btn:hover { background: var(--bg-hover); color: var(--fg-primary); }
  .icon-btn.danger:hover { color: var(--st-err); }
  .icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ---- toggle switch ---- */
  .switch {
    position: relative;
    width: 36px;
    height: 20px;
    border-radius: 999px;
    border: none;
    background: var(--bd-strong);
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
    transition: background var(--t-base);
  }
  .switch.on { background: var(--acc); }
  .switch:disabled { opacity: 0.5; cursor: not-allowed; }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: var(--sh-sm);
    transition: transform var(--t-base);
  }
  .switch.on .knob { transform: translateX(16px); }

  /* ---- 探测 chips ---- */
  .detect {
    margin-top: var(--sp-4);
    padding-top: var(--sp-4);
    border-top: 1px dashed var(--bd-muted);
  }
  .detect-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: var(--sp-2);
  }
  .detect-head span {
    font-size: var(--fs-xs);
    font-weight: var(--fw-semi);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-tertiary);
  }
  .detect-chips { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  .chip-add {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border: 1px solid var(--bd-default);
    background: var(--bg-card);
    border-radius: 999px;
    font-size: var(--fs-sm);
    font-family: inherit;
    color: var(--fg-secondary);
    cursor: pointer;
    transition: all var(--t-fast);
  }
  .chip-add:hover {
    border-color: var(--acc);
    color: var(--acc);
    background: var(--acc-soft);
  }
  .chip-add:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ---- 表单 ---- */
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }
  .field-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-3);
  }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field label {
    font-size: var(--fs-sm);
    font-weight: var(--fw-med);
    color: var(--fg-secondary);
  }
  .field input,
  .field select {
    font-family: var(--font-ui);
    font-size: var(--fs-md);
    color: var(--fg-primary);
    background: var(--bg-input);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    padding: 8px 10px;
    outline: none;
    transition: border-color var(--t-fast), box-shadow var(--t-fast);
  }
  .field input:focus,
  .field select:focus {
    border-color: var(--bd-focus);
    box-shadow: 0 0 0 3px var(--acc-soft);
  }
  .field input:disabled { opacity: 0.6; cursor: not-allowed; }
  .field .hint {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
    line-height: 1.4;
  }
  .field code, .hint code {
    font-family: var(--font-mono);
    font-size: 0.92em;
    color: var(--fg-secondary);
    background: var(--bg-chip);
    padding: 0 4px;
    border-radius: var(--rad-sm);
  }
  .terminal-form { gap: var(--sp-3); }
  .terminal-card {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-3);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-lg);
    background: color-mix(in srgb, var(--bg-sidebar) 46%, transparent);
  }
  .terminal-card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-3);
  }
  .terminal-card h3 {
    margin: 0;
    font-size: var(--fs-lg);
  }
  .terminal-card p {
    margin: 3px 0 0;
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
    line-height: 1.35;
  }
  .size-field { max-width: 140px; }
  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
    margin-top: var(--sp-5);
    padding-top: var(--sp-4);
    border-top: 1px solid var(--bd-muted);
  }
  .segmented {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--sp-2);
  }
  .segmented button {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: var(--sp-3);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    background: var(--bg-card);
    color: var(--fg-primary);
    font: inherit;
    cursor: pointer;
    text-align: left;
  }
  .segmented button span {
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
  }
  .segmented button.active {
    border-color: var(--acc);
    background: var(--acc-soft);
  }

  /* ---- 按钮 ---- */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-ui);
    font-size: var(--fs-md);
    font-weight: var(--fw-med);
    border-radius: var(--rad-md);
    padding: 7px 14px;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all var(--t-fast);
  }
  .btn.sm { padding: 5px 11px; font-size: var(--fs-sm); }
  .btn.primary {
    background: var(--acc);
    color: var(--fg-on-accent);
  }
  .btn.primary:hover:not(:disabled) { background: var(--acc-hover); }
  .btn.ghost {
    background: transparent;
    border-color: var(--bd-default);
    color: var(--fg-secondary);
  }
  .btn.ghost:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--fg-primary);
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ---- banner / toast ---- */
  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    padding: 8px var(--sp-3);
    border-radius: var(--rad-md);
    font-size: var(--fs-sm);
    margin-bottom: var(--sp-4);
  }
  .banner.err {
    color: var(--st-err);
    background: var(--bg-chip);
    border: 1px solid var(--st-err);
  }
  .banner-x {
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.7;
    font-size: var(--fs-sm);
  }
  .banner-x:hover { opacity: 1; }
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
  .toast {
    position: absolute;
    bottom: var(--sp-4);
    left: 50%;
    transform: translateX(-50%);
    background: var(--fg-primary);
    color: var(--bg-elevated);
    padding: 8px 16px;
    border-radius: 999px;
    font-size: var(--fs-sm);
    font-weight: var(--fw-med);
    box-shadow: var(--sh-md);
    white-space: nowrap;
    pointer-events: none;
  }
</style>
