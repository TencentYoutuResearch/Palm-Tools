<script lang="ts">
  /**
   * Phase 11.5.4 RemoteCwdPicker —— 浏览远端目录,选一个 cwd。
   *
   * 模态弹层。挂在 BackendChooser 的 configure 阶段(仅 Remote backend);
   * 不挂全局 — 进了这个 picker 就是为了**选 1 个目录**,选好回填 BackendChooser 的
   * cwd 输入框。
   *
   * 走的是 .specops/specs/remote-protocol.md §4.11 `GET /api/v1/fs/list?path=&show_hidden=`。
   * Rust bridge 端允许浏览任意存在的绝对目录,用于 SSH remote 场景选择
   * /data/workspace、/mnt 等 HOME 外工作区。
   *
   * 极简交互:
   *   - 顶部显示当前 path
   *   - 上一级按钮(parent != null 时启用)
   *   - 子目录列表,点 → 进入该目录
   *   - "Use this directory" 提交;Cancel 关闭不动
   */
  import { onMount } from 'svelte'
  import { endpointIpc, type RemoteFsListing } from './ipc'
  import { outsidePressClose } from './outside_close'

  type Props = {
    endpointId: string
    /// 起始路径;server 端只接受绝对路径。没有默认 cwd 时传 `/`,
    /// 用户也可以手动在输入框跳到任意存在的绝对目录。
    initialPath: string
    onSubmit: (path: string) => void
    onCancel: () => void
  }
  let { endpointId, initialPath, onSubmit, onCancel }: Props = $props()

  // initialPath 仅作弹窗初始快照;后续用户在面板内自由切换,不回绑 props
  // svelte-ignore state_referenced_locally
  let curPath = $state(initialPath)
  let listing = $state<RemoteFsListing | null>(null)
  let loading = $state(false)
  let error = $state('')
  let showHidden = $state(false)
  // 输入栏:用户可以手填路径直接跳
  // svelte-ignore state_referenced_locally
  let pathInput = $state(initialPath)

  async function loadPath(p: string) {
    loading = true
    error = ''
    try {
      const r = await endpointIpc.fsList(endpointId, p, showHidden)
      listing = r
      curPath = r.path
      pathInput = r.path
    } catch (e) {
      error = String(e)
      listing = null
    } finally {
      loading = false
    }
  }

  onMount(() => {
    loadPath(initialPath)
  })

  function descend(name: string) {
    // 拼路径:curPath 末尾如果有 '/' 去掉再加
    const base = curPath.endsWith('/') ? curPath.slice(0, -1) : curPath
    loadPath(`${base}/${name}`)
  }

  function up() {
    if (listing?.parent) loadPath(listing.parent)
  }

  function jump() {
    if (pathInput.trim()) loadPath(pathInput.trim())
  }

  function commit() {
    onSubmit(curPath)
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" use:outsidePressClose={{ onClose: onCancel }} role="presentation">
  <div class="dialog" role="dialog">
    <header>
      <h2>Choose remote directory</h2>
      <button class="close" onclick={onCancel} aria-label="Close">×</button>
    </header>

    <div class="path-row">
      <button class="ghost" onclick={up} disabled={!listing?.parent} title="Up to parent">↑</button>
      <input
        type="text"
        bind:value={pathInput}
        onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), jump())}
        spellcheck="false"
        autocomplete="off"
        placeholder="/home/dev"
      />
      <button class="ghost" onclick={jump}>Go</button>
      <label class="hidden-toggle">
        <input
          type="checkbox"
          checked={showHidden}
          onchange={(e) => {
            showHidden = (e.target as HTMLInputElement).checked
            loadPath(curPath)
          }}
        />
        <span>show hidden</span>
      </label>
    </div>

    <div class="body">
      {#if loading}
        <p class="muted">loading…</p>
      {:else if error}
        <p class="err">{error}</p>
      {:else if listing && listing.entries.length === 0}
        <p class="muted">(empty directory)</p>
      {:else if listing}
        <ul>
          {#each listing.entries as e (e.name)}
            <li>
              <button class="entry" onclick={() => descend(e.name)}>
                <span class="dir-icon">📁</span>
                <span class="name">{e.name}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <footer>
      <span class="footnote">
        Server accepts any existing absolute directory.
      </span>
      <div class="actions">
        <button class="ghost" onclick={onCancel}>Cancel</button>
        <button class="primary" onclick={commit}>Use {curPath}</button>
      </div>
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-modal-backdrop);
    backdrop-filter: var(--blur-modal);
    -webkit-backdrop-filter: var(--blur-modal);
    z-index: 1200; /* 高于 BackendChooser */
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 8vh;
  }
  .dialog {
    width: 540px;
    max-width: 92vw;
    max-height: 78vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-elevated);
    border-radius: var(--rad-lg);
    box-shadow: var(--sh-modal);
    color: var(--fg-primary);
    font-family: var(--font-ui);
    font-size: var(--fs-md);
    overflow: hidden;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--bd-default);
  }
  h2 {
    margin: 0;
    font-size: var(--fs-lg);
    font-weight: 600;
  }
  .close {
    background: none;
    border: none;
    color: var(--fg-secondary);
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
    border-radius: 4px;
  }
  .close:hover {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }

  .path-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--bd-default);
  }
  .path-row input {
    flex: 1;
    background: var(--bg-input);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    padding: 6px 10px;
    font: inherit;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--fg-primary);
    outline: none;
  }
  .path-row input:focus {
    border-color: var(--acc);
  }
  .hidden-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }

  .body {
    flex: 1;
    overflow-y: auto;
    padding: var(--sp-2) var(--sp-3);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .entry {
    width: 100%;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--rad-sm);
    padding: 6px 8px;
    color: var(--fg-primary);
    font: inherit;
    text-align: left;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .entry:hover,
  .entry:focus-visible {
    background: var(--bg-tab-hover);
    outline: none;
  }
  .dir-icon {
    flex-shrink: 0;
  }
  .name {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
  }

  .muted {
    color: var(--fg-tertiary);
    margin: var(--sp-2);
    font-size: var(--fs-sm);
  }
  .err {
    color: var(--st-err, #ef4444);
    margin: var(--sp-2);
    font-size: var(--fs-sm);
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--sp-3) var(--sp-4);
    border-top: 1px solid var(--bd-default);
    background: var(--bg-input);
    gap: var(--sp-3);
  }
  .footnote {
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  button.primary {
    background: var(--acc);
    color: var(--bg-primary);
    border: none;
    border-radius: var(--rad-sm);
    padding: 6px 12px;
    cursor: pointer;
    font: inherit;
  }
  button.ghost {
    background: var(--bg-input);
    color: var(--fg-secondary);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    padding: 6px 12px;
    cursor: pointer;
    font: inherit;
  }
  button.ghost:hover {
    background: var(--bg-tab-hover);
  }
  button.ghost:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
