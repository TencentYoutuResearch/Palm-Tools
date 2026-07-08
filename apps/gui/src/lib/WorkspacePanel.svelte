<script lang="ts">
  import { marked, type Token, type Tokens } from 'marked'
  import hljs from 'highlight.js'
  import Icon from './Icon.svelte'
  import {
    ipc,
    endpointIpc,
    type FilePreview,
    type GitDiffPreview,
    type WorkspaceEntry,
    type WorkspaceGitChange,
    type WorkspaceSnapshot,
  } from './ipc'
  import type { TabInfo } from './sessions'

  type Props = {
    tab: TabInfo | null
    homeDir: string
    onClose: () => void
  }

  type PanelTab = 'files' | 'git'
  type PreviewState = {
    kind: 'empty' | 'loading' | 'file' | 'diff' | 'error'
    title: string
    subtitle: string
    content: string
    binary?: boolean
    truncated?: boolean
    // 文件预览的渲染方式:markdown=渲染成 HTML;code=语法高亮;plain=纯文本逐行
    renderKind?: 'markdown' | 'code' | 'plain'
    // markdown / code 渲染产出的 HTML(已转义,经 marked / hljs 处理)
    html?: string
    // code 高亮识别出的语言(用于角标显示)
    lang?: string
  }
  type ContextMenuState = {
    x: number
    y: number
    entry: WorkspaceEntry
  }

  let { tab, homeDir, onClose }: Props = $props()

  let activePanel = $state<PanelTab>('files')
  let filterQuery = $state('')
  let snapshot: WorkspaceSnapshot | null = $state(null)
  let error: string | null = $state(null)
  let loading = $state(false)
  let loadedCwd = $state('')
  let expandedPaths = $state<Set<string>>(new Set())
  let loadingPaths = $state<Set<string>>(new Set())
  let childrenByPath = $state<Record<string, WorkspaceEntry[]>>({})
  let selectedPath = $state('')
  let selectedGitKey = $state('')
  let contextMenu: ContextMenuState | null = $state(null)
  let preview = $state<PreviewState>({
    kind: 'empty',
    title: 'Preview',
    subtitle: '',
    content: '',
  })

  const cwd = $derived(tab?.cwd ?? '')
  const gitDirtyCount = $derived(dirtyCount(snapshot))

  $effect(() => {
    if (!cwd) {
      snapshot = null
      error = null
      loadedCwd = ''
      expandedPaths = new Set()
      loadingPaths = new Set()
      childrenByPath = {}
      selectedPath = ''
      selectedGitKey = ''
      preview = emptyPreview()
      return
    }
    if (loadedCwd !== cwd && !loading) {
      expandedPaths = new Set()
      loadingPaths = new Set()
      childrenByPath = {}
      selectedPath = ''
      selectedGitKey = ''
      preview = emptyPreview()
      void refresh()
    }
  })

  function emptyPreview(): PreviewState {
    return { kind: 'empty', title: 'Preview', subtitle: '', content: '' }
  }

  /// 远端 tab 的 endpoint id(非远端 tab 返回 null)。用于 refresh/toggleDir/
  /// previewFile/previewGit 按 isRemote 分流到 endpointIpc 或 ipc。
  function remoteId(): string | null {
    if (tab?.endpointId?.kind !== 'remote') return null
    return tab.endpointId.id
  }

  async function refresh() {
    if (!cwd) return
    loading = true
    error = null
    try {
      const rid = remoteId()
      snapshot = rid
        ? await endpointIpc.workspaceSnapshot(rid, cwd)
        : await ipc.workspaceSnapshot(cwd)
      loadedCwd = cwd
      if (!selectedPath && snapshot.entries.length > 0) {
        selectedPath = snapshot.entries[0].path
      }
    } catch (e) {
      snapshot = null
      error = String(e)
      loadedCwd = cwd
    } finally {
      loading = false
    }
  }

  async function toggleDir(entry: WorkspaceEntry) {
    if (!entry.is_dir) return
    contextMenu = null
    const next = new Set(expandedPaths)
    if (next.has(entry.path)) {
      next.delete(entry.path)
      expandedPaths = next
      return
    }
    next.add(entry.path)
    expandedPaths = next
    selectedPath = entry.path

    if (childrenByPath[entry.path]) return
    const loadingNext = new Set(loadingPaths)
    loadingNext.add(entry.path)
    loadingPaths = loadingNext
    try {
      const rid = remoteId()
      const children = rid
        ? await endpointIpc.workspaceListDir(rid, entry.path)
        : await ipc.workspaceListDir(entry.path)
      childrenByPath = { ...childrenByPath, [entry.path]: children }
    } catch (e) {
      preview = {
        kind: 'error',
        title: entry.name,
        subtitle: entry.path,
        content: String(e),
      }
    } finally {
      const done = new Set(loadingPaths)
      done.delete(entry.path)
      loadingPaths = done
    }
  }

  function onEntryClick(entry: WorkspaceEntry) {
    selectedPath = entry.path
    if (entry.is_dir) {
      void toggleDir(entry)
    } else {
      void previewFile(entry)
    }
  }

  function openContextMenu(event: MouseEvent, entry: WorkspaceEntry) {
    event.preventDefault()
    event.stopPropagation()
    selectedPath = entry.path
    contextMenu = {
      x: Math.min(event.clientX, window.innerWidth - 178),
      y: Math.min(event.clientY, window.innerHeight - 112),
      entry,
    }
  }

  async function previewFile(entry: WorkspaceEntry) {
    if (entry.is_dir) return
    contextMenu = null
    preview = {
      kind: 'loading',
      title: entry.name,
      subtitle: compactPath(entry.path, 42),
      content: '',
    }
    try {
      const rid = remoteId()
      const data: FilePreview = rid
        ? await endpointIpc.workspacePreviewFile(rid, entry.path)
        : await ipc.workspacePreviewFile(entry.path)
      const isBinary = data.kind === 'binary'
      let renderKind: PreviewState['renderKind'] = 'plain'
      let html: string | undefined
      let lang: string | undefined
      if (!isBinary) {
        if (isMarkdownFile(data.name)) {
          renderKind = 'markdown'
          html = renderMarkdown(data.content)
        } else {
          const detected = langForFile(data.name)
          if (detected) {
            renderKind = 'code'
            lang = detected
            html = renderCode(data.content, detected)
          }
        }
      }
      preview = {
        kind: 'file',
        title: data.name,
        subtitle: `${formatBytes(data.size)} · ${compactPath(data.path, 42)}`,
        content: data.content,
        binary: isBinary,
        truncated: data.truncated,
        renderKind,
        html,
        lang,
      }
    } catch (e) {
      preview = {
        kind: 'error',
        title: entry.name,
        subtitle: entry.path,
        content: String(e),
      }
    }
  }

  async function openSystem(path: string) {
    contextMenu = null
    await ipc.openPath(path).catch((e) => {
      preview = {
        kind: 'error',
        title: 'Open failed',
        subtitle: compactPath(path, 42),
        content: String(e),
      }
    })
  }

  async function previewGit(change: WorkspaceGitChange) {
    if (!cwd) return
    activePanel = 'git'
    selectedGitKey = `${change.bucket}:${change.path}`
    preview = {
      kind: 'loading',
      title: change.path,
      subtitle: `${change.bucket} · ${change.status}`,
      content: '',
    }
    try {
      const rid = remoteId()
      const data: GitDiffPreview = rid
        ? await endpointIpc.workspaceGitDiff(rid, cwd, change.path, change.bucket)
        : await ipc.workspaceGitDiff(cwd, change.path, change.bucket)
      preview = {
        kind: 'diff',
        title: data.path,
        subtitle: `${data.bucket} diff`,
        content: data.content || '(no textual diff)',
        truncated: data.truncated,
      }
    } catch (e) {
      preview = {
        kind: 'error',
        title: change.path,
        subtitle: `${change.bucket} · ${change.status}`,
        content: String(e),
      }
    }
  }

  function dirtyCount(s: WorkspaceSnapshot | null): number {
    if (!s) return 0
    return s.git.staged + s.git.modified + s.git.untracked + s.git.conflicts
  }

  function changesFor(bucket: string): WorkspaceGitChange[] {
    const all = snapshot?.git.changes.filter((c) => c.bucket === bucket) ?? []
    const q = filterQuery.trim().toLowerCase()
    if (!q) return all
    return all.filter((c) => c.path.toLowerCase().includes(q))
  }

  // 文件过滤:按名字(大小写不敏感)过滤顶层 entries。有 query 时不递归子目录,
  // 直接按当前已加载的 entries 名字匹配;空 query 时返回全部。
  function filterEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
    const q = filterQuery.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => e.name.toLowerCase().includes(q))
  }

  function compactPath(path: string, max = 34): string {
    if (!path) return ''
    let s = homeDir && (path === homeDir || path.startsWith(homeDir + '/'))
      ? '~' + path.slice(homeDir.length)
      : path
    if (s.length <= max) return s
    const parts = s.split('/').filter(Boolean)
    const tail = parts.slice(-2).join('/')
    return `${s.startsWith('/') ? '/' : ''}.../${tail}`
  }

  function formatSize(entry: WorkspaceEntry): string {
    if (entry.is_dir) return ''
    return formatBytes(entry.size ?? 0)
  }

  /**
   * 文件树行拖拽:把 path + endpointId 写进 dataTransfer,终端区 .main 的
   * HTML5 drop handler 读取后注入 @<path> 到 active tab。
   * 用自定义 MIME 类型 `application/x-kode-file`,与 Finder 的 OS 级拖拽
   * (走 Tauri onDragDropEvent)互不干扰。
   */
  function onTreeDragStart(e: DragEvent, entry: WorkspaceEntry) {
    if (!e.dataTransfer) return
    const rid = remoteId()
    e.dataTransfer.setData('application/x-kode-file', JSON.stringify({ path: entry.path, endpointId: rid }))
    e.dataTransfer.setData('text/plain', entry.path)
    e.dataTransfer.effectAllowed = 'copy'
  }

  function formatBytes(size: number): string {
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
    return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`
  }

  function basename(path: string): string {
    return path.split('/').filter(Boolean).pop() ?? path
  }

  function lineClass(line: string): string {
    if (line.startsWith('+') && !line.startsWith('+++')) return 'add'
    if (line.startsWith('-') && !line.startsWith('---')) return 'del'
    if (line.startsWith('@@')) return 'hunk'
    return ''
  }

  // 文件名 → highlight.js 语言名。优先用扩展名映射(hljs 内置语言名),
  // 命中不了再让 hljs 自动检测。返回 undefined 表示走纯文本。
  const EXT_LANG: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
    rs: 'rust', go: 'go', py: 'python', rb: 'ruby', php: 'php',
    java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', swift: 'swift',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
    cs: 'csharp', dart: 'dart', lua: 'lua', r: 'r', pl: 'perl',
    sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
    json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
    xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
    css: 'css', scss: 'scss', sass: 'scss', less: 'less',
    sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
    dockerfile: 'dockerfile', makefile: 'makefile', mk: 'makefile',
    diff: 'diff', patch: 'diff',
  }

  function langForFile(name: string): string | undefined {
    const lower = name.toLowerCase()
    if (lower === 'dockerfile') return 'dockerfile'
    if (lower === 'makefile') return 'makefile'
    const dot = lower.lastIndexOf('.')
    if (dot < 0) return undefined
    const ext = lower.slice(dot + 1)
    const lang = EXT_LANG[ext]
    if (lang && hljs.getLanguage(lang)) return lang
    return undefined
  }

  function isMarkdownFile(name: string): boolean {
    const lower = name.toLowerCase()
    return lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')
  }

  // marked:渲染 markdown,代码块用 hljs 高亮。默认转义,不开启危险 HTML。
  function renderMarkdown(src: string): string {
    const tokens = marked.lexer(src)
    marked.walkTokens(tokens, (token: Token) => {
      if (token.type === 'code') {
        const code = token as Tokens.Code
        const lang = code.lang?.split(/\s+/)[0]
        try {
          const html = lang && hljs.getLanguage(lang)
            ? hljs.highlight(code.text, { language: lang }).value
            : hljs.highlightAuto(code.text).value
          code.escaped = true
          code.text = `<span class="hljs">${html}</span>`
        } catch {
          /* fall back to default escaping */
        }
      }
    })
    return marked.parser(tokens)
  }

  function renderCode(src: string, lang: string): string {
    try {
      return hljs.highlight(src, { language: lang }).value
    } catch {
      return hljs.highlightAuto(src).value
    }
  }
</script>

<svelte:window onclick={() => (contextMenu = null)} onkeydown={(e) => e.key === 'Escape' && (contextMenu = null)} />

<aside class="workspace-panel" aria-label="Workspace inspector">
  <!-- 顶部一排(拉通整个右边栏):Files/Git 靠左,刷新 + inspector 关闭 靠右 -->
  <div class="nav-top">
    <div class="tabs" role="tablist" aria-label="Workspace views">
      <button class:active={activePanel === 'files'} role="tab" aria-selected={activePanel === 'files'} onclick={() => (activePanel = 'files')}>
        <Icon name="folder" size={14} /> Files
      </button>
      <button class:active={activePanel === 'git'} role="tab" aria-selected={activePanel === 'git'} onclick={() => (activePanel = 'git')}>
        <Icon name="git-branch" size={14} /> Git
        {#if gitDirtyCount > 0}<span>{gitDirtyCount}</span>{/if}
      </button>
    </div>
    <div class="nav-top-actions">
      <button class="tool-btn" title="Refresh" aria-label="Refresh workspace" onclick={refresh} disabled={loading || !cwd}>
        <Icon name="refresh-cw" size={14} />
      </button>
      <button class="tool-btn active" title="Hide workspace inspector" aria-label="Hide workspace inspector" aria-pressed="true" onclick={onClose}>
        <Icon name="panel-right-open" size={15} />
      </button>
    </div>
  </div>

  {#if !tab}
    <div class="empty">No active session</div>
  {:else}
    <div class="panel-body" class:no-preview={preview.kind === 'empty'}>
      <!-- 左:preview(占大)——未打开文件/diff 时不渲染,nav-pane 占满整列 -->
      {#if preview.kind !== 'empty'}
        <section class="preview-pane" aria-label="Preview">
        <header>
          <div>
            <strong>{preview.title}</strong>
            {#if preview.subtitle}<span>{preview.subtitle}</span>{/if}
          </div>
          <div class="preview-actions">
            {#if preview.truncated}<em>truncated</em>{/if}
            <button class="tool-btn" title="Close preview" aria-label="Close preview" onclick={() => (preview = emptyPreview())}>
              <Icon name="x" size={14} />
            </button>
          </div>
        </header>
        {#if preview.kind === 'loading'}
          <p class="muted pad">Loading...</p>
        {:else if preview.kind === 'error'}
          <pre class="preview-text error-text">{preview.content}</pre>
        {:else if preview.binary}
          <p class="muted pad">Binary file. Use Open to view it in the system app.</p>
        {:else if preview.kind === 'file' && preview.renderKind === 'markdown'}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          <div class="md-body">{@html preview.html}</div>
        {:else if preview.kind === 'file' && preview.renderKind === 'code'}
          <pre class="preview-text hljs"><code>{@html preview.html}</code></pre>
        {:else}
          <pre class="preview-text" class:diff={preview.kind === 'diff'}>{#each preview.content.split('\n') as line}<span class={lineClass(line)}>{line || ' '}</span>{/each}</pre>
        {/if}
        </section>
      {/if}

      <!-- 右:搜索框(上) + 文件/git 列表(下) -->
      <section class="nav-pane" aria-label="Workspace navigation">
        <div class="filter-strip">
          <span class="filter-icon"><Icon name="search" size={13} /></span>
          <input
            class="filter-input"
            type="text"
            placeholder={activePanel === 'files' ? 'Filter files…' : 'Filter changes…'}
            bind:value={filterQuery}
            spellcheck="false"
            autocomplete="off"
          />
          {#if filterQuery}
            <button class="filter-clear" title="Clear" aria-label="Clear filter" onclick={() => (filterQuery = '')}>
              <Icon name="x" size={12} />
            </button>
          {/if}
        </div>
        {#if error}
          <p class="strip-msg error">{error}</p>
        {:else if loading && !snapshot}
          <p class="strip-msg muted">Loading...</p>
        {:else if snapshot && !snapshot.exists}
          <p class="strip-msg error">Path does not exist.</p>
        {/if}

        {#if activePanel === 'files'}
          <section class="list-pane" aria-label="Files">
            {#if snapshot && snapshot.entries.length === 0}
              <p class="muted pad">No files</p>
            {:else if snapshot}
              {@const shown = filterEntries(snapshot.entries)}
              {#if shown.length === 0}
                <p class="muted pad">No matches</p>
              {:else}
                {@render tree(shown, 0)}
              {/if}
            {/if}
          </section>
        {:else}
          <section class="list-pane git-pane" aria-label="Git changes">
            {#if snapshot?.git.is_repo}
              <div class="git-summary">
                <div class="git-primary">
                  <span class="branch">{snapshot.git.branch ?? snapshot.git.short_head ?? 'detached'}</span>
                  {#if snapshot.git.short_head}<span class="sha">{snapshot.git.short_head}</span>{/if}
                </div>
                <div class="git-sync">
                  {#if snapshot.git.ahead > 0}<span>ahead {snapshot.git.ahead}</span>{/if}
                  {#if snapshot.git.behind > 0}<span>behind {snapshot.git.behind}</span>{/if}
                  {#if snapshot.git.ahead === 0 && snapshot.git.behind === 0 && gitDirtyCount === 0}<span>clean</span>{/if}
                </div>
              </div>
              {@render changeGroup('Staged', 'staged', changesFor('staged'))}
              {@render changeGroup('Modified', 'modified', changesFor('modified'))}
              {@render changeGroup('Untracked', 'untracked', changesFor('untracked'))}
              {@render changeGroup('Conflicts', 'conflict', changesFor('conflict'))}
            {:else if snapshot}
              <p class="muted pad">Not a Git repository</p>
            {/if}
          </section>
        {/if}
      </section>
    </div>
  {/if}

  {#if contextMenu}
    <div
      class="context-menu"
      style={`left:${contextMenu.x}px;top:${contextMenu.y}px`}
      role="menu"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      {#if contextMenu.entry.is_dir}
        <button role="menuitem" onclick={() => toggleDir(contextMenu!.entry)}>
          <Icon name={expandedPaths.has(contextMenu.entry.path) ? 'folder-open' : 'folder'} size={13} />
          {expandedPaths.has(contextMenu.entry.path) ? 'Collapse folder' : 'Expand folder'}
        </button>
        <button role="menuitem" onclick={() => openSystem(contextMenu!.entry.path)}>
          <Icon name="external-link" size={13} /> Open folder
        </button>
      {:else}
        <button role="menuitem" onclick={() => previewFile(contextMenu!.entry)}>
          <Icon name="eye" size={13} /> Preview here
        </button>
        <button role="menuitem" onclick={() => openSystem(contextMenu!.entry.path)}>
          <Icon name="external-link" size={13} /> Open with app
        </button>
      {/if}
    </div>
  {/if}
</aside>

{#snippet tree(entries: WorkspaceEntry[], depth: number)}
  <div class="tree-group">
    {#each entries as entry (entry.path)}
      <button
        class="tree-row"
        class:selected={selectedPath === entry.path}
        style={`--depth:${depth}`}
        title={entry.path}
        draggable="true"
        onclick={() => onEntryClick(entry)}
        oncontextmenu={(e) => openContextMenu(e, entry)}
        ondragstart={(e) => onTreeDragStart(e, entry)}
      >
        <span class="twisty">
          {#if entry.is_dir}
            <Icon name={expandedPaths.has(entry.path) ? 'chevron-down' : 'chevron-right'} size={13} />
          {/if}
        </span>
        <span class="file-icon">
          <Icon name={entry.is_dir && expandedPaths.has(entry.path) ? 'folder-open' : entry.is_dir ? 'folder' : 'file-text'} size={14} />
        </span>
        <span class="file-name">{entry.name}{entry.is_symlink ? ' @' : ''}</span>
        <span class="file-meta">{loadingPaths.has(entry.path) ? '...' : formatSize(entry)}</span>
      </button>
      {#if entry.is_dir && expandedPaths.has(entry.path)}
        {@render tree(childrenByPath[entry.path] ?? [], depth + 1)}
      {/if}
    {/each}
  </div>
{/snippet}

{#snippet changeGroup(label: string, bucket: string, changes: WorkspaceGitChange[])}
  {#if changes.length > 0}
    <div class="change-group">
      <div class="change-heading">
        <span>{label}</span>
        <em>{changes.length}</em>
      </div>
      {#each changes as change (`${bucket}:${change.path}`)}
        <button
          class="change-row"
          class:selected={selectedGitKey === `${change.bucket}:${change.path}`}
          title={change.path}
          onclick={() => previewGit(change)}
        >
          <span class="status-tag {change.bucket}">{change.status.slice(0, 1).toUpperCase()}</span>
          <span class="change-name">{basename(change.path)}</span>
          <span class="change-path">{change.path}</span>
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

<style>
  .workspace-panel {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border: 0;
    border-radius: 0;
    background: var(--bg-sidebar);
    box-shadow: none;
    overflow: hidden;
  }

  /* 无底框,跟主区标题栏按钮风格一致 */
  .tool-btn {
    width: 26px;
    height: 26px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--fg-secondary);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .tool-btn:hover:not(:disabled) { color: var(--fg-primary); background: color-mix(in srgb, var(--fg-primary) 8%, transparent); }
  /* 展开态:accent 高亮,跟主区 inspector 开关视觉一致 */
  .tool-btn.active { background: var(--acc-soft); color: var(--acc); }
  .tool-btn.active:hover:not(:disabled) { background: color-mix(in srgb, var(--acc) 18%, transparent); }
  .tool-btn:disabled { opacity: 0.45; cursor: default; }

  /* 顶部一排(拉通整个右边栏):Files/Git 靠左,刷新 + 关闭 靠右。高度 44px 与左侧顶条对齐 */
  .nav-top {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: 44px;
    padding: 0 8px 0 10px;
    border-bottom: 1px solid color-mix(in srgb, var(--fg-primary) 8%, transparent);
  }
  .nav-top-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .tabs button {
    height: 28px;
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--fg-secondary);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    cursor: pointer;
  }
  .tabs button:hover { background: var(--bg-tab-hover); color: var(--fg-primary); }
  .tabs button.active {
    background: var(--bg-tab-active);
    border-color: color-mix(in srgb, var(--fg-primary) 10%, transparent);
    color: var(--fg-primary);
  }
  .tabs span {
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--acc) 14%, transparent);
    color: var(--acc);
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 16px;
  }

  .empty {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 16px;
    color: var(--fg-tertiary);
    font-size: 12px;
  }

  /* 查找/过滤框(取代原路径条) */
  .filter-strip {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 8px 10px;
    padding: 0 8px;
    height: 30px;
    border: 1px solid color-mix(in srgb, var(--fg-primary) 8%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--bg-input) 82%, transparent);
    transition: border-color var(--t-fast);
  }
  .filter-strip:focus-within { border-color: color-mix(in srgb, var(--acc) 45%, transparent); }
  .filter-icon { display: inline-flex; color: var(--fg-tertiary); flex-shrink: 0; }
  .filter-input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--fg-primary);
    font-size: 12px;
  }
  .filter-input::placeholder { color: var(--fg-tertiary); }
  .filter-clear {
    flex-shrink: 0;
    width: 18px; height: 18px;
    display: inline-flex; align-items: center; justify-content: center;
    border: 0; border-radius: 4px;
    background: transparent;
    color: var(--fg-tertiary);
    cursor: pointer;
  }
  .filter-clear:hover { color: var(--fg-primary); background: color-mix(in srgb, var(--fg-primary) 10%, transparent); }
  .strip-msg { margin: 0 10px 8px; font-size: 11px; }
  .strip-msg.error { color: var(--st-err); }
  .strip-msg.muted { color: var(--fg-tertiary); }

  .panel-body {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 246px;
    grid-template-rows: minmax(0, 1fr);
  }
  /* 未打开文件/diff 时不渲染 preview-pane,nav-pane 占满整列 */
  .panel-body.no-preview { grid-template-columns: 1fr; }
  .panel-body.no-preview .nav-pane { border-left: 0; }
  .nav-pane {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid color-mix(in srgb, var(--fg-primary) 8%, transparent);
    overflow: hidden;
  }
  .list-pane {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 7px 6px 10px;
  }
  .preview-pane {
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .preview-pane header {
    flex: 0 0 auto;
    min-height: 38px;
    padding: 7px 10px;
    display: flex;
    justify-content: space-between;
    gap: 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--fg-primary) 7%, transparent);
  }
  .preview-pane header div {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .preview-pane strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-primary);
    font-size: 12px;
  }
  .preview-pane header span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .preview-pane em {
    color: var(--st-warn);
    font-family: var(--font-mono);
    font-size: 10px;
    font-style: normal;
  }
  /* header 右侧动作组(truncated 标记 + 关闭按钮):覆盖 header div 的 column 布局 */
  .preview-pane header .preview-actions {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  /* 横向溢出时出现左右滚动条:tree-group 按最宽行撑开,行宽取内容(至少铺满可视宽) */
  .tree-group { min-width: max-content; }
  .tree-row {
    width: max-content;
    min-width: 100%;
    min-height: 27px;
    display: grid;
    grid-template-columns: 16px 18px auto auto;
    align-items: center;
    gap: 4px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--fg-secondary);
    padding: 3px 6px 3px calc(5px + var(--depth) * 14px);
    text-align: left;
    cursor: default;
  }
  .tree-row:hover,
  .tree-row.selected {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
  .twisty,
  .file-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: color-mix(in srgb, var(--acc) 68%, var(--fg-secondary));
  }
  .change-name,
  .change-path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* 文件名不再截断,完整显示;过长时由 .list-pane 横向滚动 */
  .file-name {
    font-size: 12px;
    white-space: nowrap;
  }
  .file-meta {
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    font-size: 10px;
    white-space: nowrap;
  }

  .git-summary {
    padding: 6px 7px 10px;
    margin-bottom: 4px;
    border-bottom: 1px solid color-mix(in srgb, var(--fg-primary) 7%, transparent);
  }
  .git-primary {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .branch {
    color: var(--fg-primary);
    font-weight: 650;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sha {
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    font-size: 10.5px;
  }
  .git-sync {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .git-sync span {
    padding: 2px 7px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--acc) 11%, transparent);
    color: var(--acc);
    font-size: 10.5px;
    font-family: var(--font-mono);
  }

  .change-group { margin: 8px 0 10px; }
  .change-heading {
    display: flex;
    justify-content: space-between;
    padding: 0 7px 4px;
    color: var(--fg-tertiary);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .change-heading em {
    font-style: normal;
    font-family: var(--font-mono);
  }
  .change-row {
    width: 100%;
    min-height: 34px;
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    grid-template-rows: auto auto;
    gap: 0 6px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--fg-secondary);
    padding: 4px 7px;
    text-align: left;
    cursor: pointer;
  }
  .change-row:hover,
  .change-row.selected {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
  .status-tag {
    grid-row: 1 / 3;
    width: 16px;
    height: 16px;
    align-self: center;
    border-radius: 4px;
    color: var(--bg-base);
    background: var(--fg-tertiary);
    font-size: 10px;
    font-family: var(--font-mono);
    line-height: 16px;
    text-align: center;
  }
  .status-tag.staged { background: var(--st-ok); }
  .status-tag.modified { background: var(--st-info); }
  .status-tag.untracked { background: var(--st-warn); }
  .status-tag.conflict { background: var(--st-err); }
  .change-name { color: var(--fg-primary); font-size: 12px; }
  .change-path {
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    font-size: 10px;
  }

  .preview-text {
    flex: 1 1 auto;
    min-height: 0;
    margin: 0;
    padding: 9px 10px 14px;
    overflow: auto;
    color: var(--fg-secondary);
    font-family: var(--font-mono);
    font-size: 10.5px;
    line-height: 1.45;
    white-space: pre;
    tab-size: 2;
  }
  .preview-text span {
    display: block;
    min-height: 1.45em;
  }
  .preview-text.diff .add { color: var(--st-ok); background: color-mix(in srgb, var(--st-ok) 8%, transparent); }
  .preview-text.diff .del { color: var(--st-err); background: color-mix(in srgb, var(--st-err) 8%, transparent); }
  .preview-text.diff .hunk { color: var(--acc); }
  /* code 高亮容器:复用 preview-text 的字体/滚动,但用 pre-wrap=off 保持代码原样 */
  .preview-text.hljs {
    color: var(--fg-secondary);
    background: transparent;
  }
  .preview-text.hljs code {
    font-family: inherit;
    font-size: inherit;
    background: none;
    padding: 0;
  }

  /* ── Markdown 渲染样式 ── */
  .md-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 12px 14px 18px;
    color: var(--fg-secondary);
    font-family: var(--font-ui);
    font-size: 12.5px;
    line-height: 1.6;
  }
  .md-body :global(h1),
  .md-body :global(h2),
  .md-body :global(h3),
  .md-body :global(h4),
  .md-body :global(h5),
  .md-body :global(h6) {
    color: var(--fg-primary);
    font-weight: var(--fw-semi);
    line-height: 1.3;
    margin: 18px 0 8px;
  }
  .md-body :global(h1) { font-size: 18px; border-bottom: 1px solid var(--bd-muted); padding-bottom: 6px; }
  .md-body :global(h2) { font-size: 15.5px; border-bottom: 1px solid var(--bd-muted); padding-bottom: 5px; }
  .md-body :global(h3) { font-size: 13.5px; }
  .md-body :global(h4) { font-size: 12.5px; }
  .md-body :global(> *:first-child) { margin-top: 0; }
  .md-body :global(p) { margin: 8px 0; }
  .md-body :global(ul),
  .md-body :global(ol) { margin: 8px 0; padding-left: 22px; }
  .md-body :global(li) { margin: 3px 0; }
  .md-body :global(a) { color: var(--acc); text-decoration: none; }
  .md-body :global(a:hover) { text-decoration: underline; }
  .md-body :global(strong) { color: var(--fg-primary); font-weight: var(--fw-semi); }
  .md-body :global(blockquote) {
    margin: 10px 0;
    padding: 2px 12px;
    border-left: 3px solid var(--bd-strong);
    color: var(--fg-tertiary);
  }
  .md-body :global(hr) { border: none; border-top: 1px solid var(--bd-muted); margin: 16px 0; }
  .md-body :global(code) {
    font-family: var(--font-mono);
    font-size: 11px;
    background: var(--bg-pre);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-sm);
    padding: 1px 5px;
  }
  .md-body :global(pre) {
    margin: 10px 0;
    padding: 10px 12px;
    background: var(--bg-pre);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
    overflow: auto;
  }
  .md-body :global(pre code) {
    background: none;
    border: none;
    padding: 0;
    font-size: 11px;
    line-height: 1.5;
  }
  .md-body :global(table) {
    border-collapse: collapse;
    margin: 10px 0;
    font-size: 11.5px;
    width: 100%;
  }
  .md-body :global(th),
  .md-body :global(td) {
    border: 1px solid var(--bd-muted);
    padding: 5px 9px;
    text-align: left;
  }
  .md-body :global(th) { background: var(--bg-chip); color: var(--fg-primary); font-weight: var(--fw-med); }
  .md-body :global(img) { max-width: 100%; }

  /* ── highlight.js token 配色(对齐绿色深色主题) ── */
  :global(.hljs-comment),
  :global(.hljs-quote) { color: var(--fg-tertiary); font-style: italic; }
  :global(.hljs-keyword),
  :global(.hljs-selector-tag),
  :global(.hljs-built_in),
  :global(.hljs-name),
  :global(.hljs-tag) { color: #c792ea; }
  :global(.hljs-string),
  :global(.hljs-title),
  :global(.hljs-section),
  :global(.hljs-attribute),
  :global(.hljs-literal),
  :global(.hljs-template-tag),
  :global(.hljs-template-variable),
  :global(.hljs-type),
  :global(.hljs-addition) { color: var(--st-ok); }
  :global(.hljs-number),
  :global(.hljs-symbol),
  :global(.hljs-bullet),
  :global(.hljs-link),
  :global(.hljs-meta),
  :global(.hljs-selector-id),
  :global(.hljs-selector-class) { color: var(--st-busy); }
  :global(.hljs-title.function_),
  :global(.hljs-function .hljs-title),
  :global(.hljs-attr) { color: var(--st-info); }
  :global(.hljs-variable),
  :global(.hljs-deletion) { color: var(--st-err); }
  :global(.hljs-emphasis) { font-style: italic; }
  :global(.hljs-strong) { font-weight: var(--fw-semi); }
  .error-text { color: var(--st-err); white-space: pre-wrap; }
  .pad { padding: 10px; }
  .muted, .error {
    margin: 0;
    color: var(--fg-tertiary);
    font-size: 11px;
    line-height: 1.4;
  }
  .error { color: var(--st-err); }

  .context-menu {
    position: fixed;
    z-index: 1000;
    width: 170px;
    padding: 5px;
    border: 1px solid color-mix(in srgb, var(--fg-primary) 12%, transparent);
    border-radius: 7px;
    background: var(--bg-elevated);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.22);
  }
  .context-menu button {
    width: 100%;
    min-height: 28px;
    display: flex;
    align-items: center;
    gap: 7px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--fg-secondary);
    padding: 4px 7px;
    text-align: left;
    font-size: 12px;
    cursor: pointer;
  }
  .context-menu button:hover {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
</style>
