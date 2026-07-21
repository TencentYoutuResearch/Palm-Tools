<script lang="ts">
  /**
   * PathsBanner.svelte —— GUI 启动时显示的「路径配置」横幅。
   *
   * 显示当前生效的:
   *   1. Session 工作目录 (cwd):新 spawn 的 codebuddy/claude 会以这里作为 cwd
   *   2. Config 文件路径 (config.toml):backends 列表来源
   *
   * 用户可以:
   *   - 点 "Change…" 直接编辑路径(简单文本输入,不用原生 picker 避免新 plugin 依赖)
   *   - 点 "Reset" 清掉自定义,回到默认
   *
   * 行为约束(用户已确认):
   *   - 切换 cwd 立即对**新 tab** 生效,已开 tab 不动
   *   - 切换 config.toml 路径需要**重启 GUI** 才能让 backends 列表更新;切了之后 banner 会提示
   *
   * 显示时机:
   *   - 始终在 main 区顶部(BackendChooser 上方,如果有 chooser);
   *   - 用户点 close 收起后只在 banner 内部隐藏,session_cwd / config_path 仍然按持久化值生效
   *   - 命令面板 / Cmd+, 也能再次打开
   */
  import { onMount } from 'svelte'
  import { ipc, type PathsConfig, type ThemeMode } from './ipc'
  import { open } from '@tauri-apps/plugin-dialog'
  import Icon from './Icon.svelte'

  type Props = {
    onClose?: () => void
    /// 当前 theme(由 App.svelte 持有,这里只读 + 通过 onThemeChange 回写)。
    /// 读 prop 避免每个 banner 各自调一次 ipc.getTheme;banner 不持久化,
    /// 持久化由 setTheme 直接打到后端。
    theme?: ThemeMode
    onThemeChange?: (next: ThemeMode) => void
  }
  let { onClose, theme = 'system', onThemeChange }: Props = $props()

  let cfg: PathsConfig | null = $state(null)
  let editing: 'cwd' | 'config' | null = $state(null)
  let draft = $state('')
  let err: string | null = $state(null)
  let restartHint = $state(false)

  async function refresh() {
    try {
      cfg = await ipc.getPathsConfig()
    } catch (e) {
      err = String(e)
    }
  }

  onMount(refresh)

  function pickTheme(next: ThemeMode) {
    onThemeChange?.(next)
  }

  function startEdit(which: 'cwd' | 'config') {
    err = null
    editing = which
    draft = which === 'cwd' ? cfg?.session_cwd ?? '' : cfg?.config_path ?? ''
  }

  function cancelEdit() {
    editing = null
    draft = ''
    err = null
  }

  async function commitEdit() {
    if (!editing) return
    err = null
    try {
      const next = editing === 'cwd'
        ? await ipc.setSessionCwd(draft)
        : await ipc.setConfigPath(draft)
      if (editing === 'config') restartHint = true
      cfg = next
      editing = null
      draft = ''
    } catch (e) {
      err = String(e)
    }
  }

  async function reset(which: 'cwd' | 'config') {
    err = null
    try {
      const next = which === 'cwd'
        ? await ipc.setSessionCwd('')
        : await ipc.setConfigPath('')
      if (which === 'config') restartHint = true
      cfg = next
    } catch (e) {
      err = String(e)
    }
  }

  function onKey(e: KeyboardEvent) {
    if (!editing) return
    if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
  }

  /// 弹原生选择器。cwd → 目录;config → toml 文件。
  /// 选完直接更新 draft + 提交,跳过 Save 按钮(因为 dialog 本身已是显式确认)。
  async function browse(which: 'cwd' | 'config') {
    err = null
    try {
      const picked = await open(
        which === 'cwd'
          ? {
              directory: true,
              multiple: false,
              defaultPath: cfg?.session_cwd || undefined,
              title: 'Choose default working directory',
            }
          : {
              directory: false,
              multiple: false,
              defaultPath: cfg?.config_path || undefined,
              title: 'Choose config.toml',
              filters: [{ name: 'TOML', extensions: ['toml'] }],
            },
      )
      if (typeof picked === 'string' && picked) {
        // 直接 commit — Browse 选完就当用户确认了,免得再多按一次 Save
        const next =
          which === 'cwd'
            ? await ipc.setSessionCwd(picked)
            : await ipc.setConfigPath(picked)
        if (which === 'config') restartHint = true
        cfg = next
        editing = null
        draft = ''
      }
    } catch (e) {
      err = String(e)
    }
  }
</script>

<div class="banner" role="region" aria-label="Path configuration">
  <div class="banner-head">
    <span class="banner-title">Paths</span>
    {#if onClose}
      <button class="close" title="Hide" aria-label="Hide" onclick={onClose}><Icon name="x" /></button>
    {/if}
  </div>

  {#if !cfg}
    <div class="row muted">Loading…</div>
  {:else}
    <!-- session cwd -->
    <div class="row">
      <div class="row-label">
        <span class="key">cwd</span>
        <span class="hint">(new tabs spawn here)</span>
      </div>
      {#if editing === 'cwd'}
        <div class="edit-row">
          <input
            type="text"
            value={draft}
            oninput={(e) => (draft = (e.target as HTMLInputElement).value)}
            onkeydown={onKey}
            placeholder="/absolute/path or empty for default"
            spellcheck="false"
            autocomplete="off"
          />
          <button class="btn primary" onclick={commitEdit}>Save</button>
          <button class="btn ghost" onclick={cancelEdit}>Cancel</button>
        </div>
      {:else}
        <div class="value-row">
          <code class="path" title={cfg.session_cwd}>{cfg.session_cwd}</code>
          <span class="badge" class:overridden={cfg.session_cwd_overridden}>
            {cfg.session_cwd_overridden ? 'custom' : 'default'}
          </span>
          <button class="btn ghost" onclick={() => browse('cwd')}>Browse…</button>
          <button class="btn ghost" onclick={() => startEdit('cwd')}>Edit…</button>
          {#if cfg.session_cwd_overridden}
            <button class="btn ghost" onclick={() => reset('cwd')}>Reset</button>
          {/if}
        </div>
      {/if}
    </div>

    <!-- config.toml path -->
    <div class="row">
      <div class="row-label">
        <span class="key">config</span>
        <span class="hint">(backends list source)</span>
      </div>
      {#if editing === 'config'}
        <div class="edit-row">
          <input
            type="text"
            value={draft}
            oninput={(e) => (draft = (e.target as HTMLInputElement).value)}
            onkeydown={onKey}
            placeholder="/absolute/path/to/config.toml or empty for default"
            spellcheck="false"
            autocomplete="off"
          />
          <button class="btn primary" onclick={commitEdit}>Save</button>
          <button class="btn ghost" onclick={cancelEdit}>Cancel</button>
        </div>
      {:else}
        <div class="value-row">
          <code class="path" title={cfg.config_path}>{cfg.config_path}</code>
          <span class="badge" class:overridden={cfg.config_path_overridden}>
            {cfg.config_path_overridden ? 'custom' : 'default'}
          </span>
          {#if !cfg.config_exists}
            <span class="badge missing">missing</span>
          {/if}
          <button class="btn ghost" onclick={() => browse('config')}>Browse…</button>
          <button class="btn ghost" onclick={() => startEdit('config')}>Edit…</button>
          {#if cfg.config_path_overridden}
            <button class="btn ghost" onclick={() => reset('config')}>Reset</button>
          {/if}
        </div>
      {/if}
    </div>

    {#if restartHint}
      <div class="restart-hint">
        config.toml 路径已切换 — 重启 GUI 后 backends 列表才会刷新。
      </div>
    {/if}

    <!-- theme:三段式按钮组,持久化到 state.json(走 ipc.setTheme,异步,失败不阻断 UI) -->
    <div class="row">
      <div class="row-label">
        <span class="key">theme</span>
        <span class="hint">(global UI; system follows OS)</span>
      </div>
      <div class="theme-row">
        <button
          class="seg-btn"
          class:active={theme === 'system'}
          onclick={() => pickTheme('system')}
        >System</button>
        <button
          class="seg-btn"
          class:active={theme === 'light'}
          onclick={() => pickTheme('light')}
        >Light</button>
        <button
          class="seg-btn"
          class:active={theme === 'dark'}
          onclick={() => pickTheme('dark')}
        >Dark</button>
      </div>
    </div>
  {/if}

  {#if err}
    <div class="err">{err}</div>
  {/if}
</div>

<style>
  .banner {
    background: var(--bg-elevated);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    padding: var(--sp-2) var(--sp-3);
    margin: var(--sp-3) var(--sp-3) 0 var(--sp-3);
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    color: var(--fg-primary);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .banner-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .banner-title {
    font-weight: var(--fw-semi);
    color: var(--fg-secondary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: var(--fs-xs);
  }
  .close {
    background: transparent;
    border: none;
    color: var(--fg-tertiary);
    cursor: pointer;
    font-size: 12px;
    padding: 2px 6px;
    border-radius: var(--rad-sm);
  }
  .close:hover { background: var(--bg-tab-hover); color: var(--fg-primary); }

  .row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .row.muted { color: var(--fg-tertiary); }

  .row-label {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .key {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--st-info);
    font-weight: var(--fw-med);
  }
  .hint {
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
  }

  .value-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
  .path {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--fg-primary);
    background: var(--bg-tab-hover);
    padding: 2px 6px;
    border-radius: var(--rad-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
    max-width: 100%;
  }
  .badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--bg-tab-hover);
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    border: 1px solid var(--bd-default);
  }
  .badge.overridden {
    background: var(--acc-soft);
    color: var(--acc-hover);
    border-color: var(--acc);
  }
  .badge.missing {
    background: rgba(193, 18, 31, 0.18);
    color: var(--st-info);
    border-color: var(--st-err);
  }

  .edit-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  input[type="text"] {
    flex: 1;
    background: var(--bg-base);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    padding: 4px 8px;
    color: var(--fg-primary);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    min-width: 0;
  }
  input[type="text"]:focus {
    outline: none;
    border-color: var(--acc);
  }

  .btn {
    border: 1px solid var(--bd-default);
    background: transparent;
    color: var(--fg-secondary);
    padding: 3px 10px;
    font-size: var(--fs-xs);
    border-radius: var(--rad-sm);
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast);
  }
  .btn:hover { background: var(--bg-tab-hover); color: var(--fg-primary); }
  .btn.primary {
    background: var(--acc);
    color: var(--fg-on-accent);
    border-color: var(--acc);
  }
  .btn.primary:hover { filter: brightness(1.1); }

  .restart-hint {
    background: rgba(255, 183, 3, 0.12);
    color: var(--st-warn);
    border: 1px solid rgba(255, 183, 3, 0.4);
    padding: 4px 8px;
    border-radius: var(--rad-sm);
    font-size: var(--fs-xs);
  }

  .theme-row {
    display: flex;
    gap: 4px;
  }
  .seg-btn {
    border: 1px solid var(--bd-default);
    background: transparent;
    color: var(--fg-secondary);
    padding: 4px 12px;
    font-size: var(--fs-xs);
    border-radius: var(--rad-sm);
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast);
    font-family: var(--font-ui);
  }
  .seg-btn:hover { background: var(--bg-tab-hover); color: var(--fg-primary); }
  .seg-btn.active {
    background: var(--acc);
    color: var(--fg-on-accent);
    border-color: var(--acc);
    font-weight: var(--fw-med);
  }

  .err {
    background: rgba(193, 18, 31, 0.14);
    color: var(--acc-hover);
    border: 1px solid var(--st-err);
    padding: 4px 8px;
    border-radius: var(--rad-sm);
    font-size: var(--fs-xs);
    font-family: var(--font-mono);
  }
</style>
