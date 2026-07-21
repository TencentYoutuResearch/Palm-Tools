<script lang="ts">
  /**
   * CommandPalette.svelte —— ⌘P 弹出的命令面板(2026-06 简化重做)。
   *
   * 单列 Spotlight 风格:搜索框 + 按组分隔的扁平列表。去掉了旧版的装饰标题栏、
   * 左侧 group 分栏导航和冗长 footer —— 命令本就不多,扁平单列更快更清晰。
   * 上下键在全列表里移动(跨组),组只是视觉分隔的小标题,不再是切换单元。
   *
   * 保留:fuzzy(substring)搜索、↑↓ 导航、↵ 执行、←/→ 原地 cycle 值、Esc 关闭。
   */
  import { onMount, tick } from 'svelte'
  import Icon from './Icon.svelte'
  import { currentLocale, t } from './i18n'
  import { outsidePressClose } from './outside_close'

  export type CommandGroup = 'tab' | 'view' | 'memory' | 'remote' | 'other'

  export interface Command {
    id: string
    label: string
    detail?: string
    group?: CommandGroup
    run: () => void | Promise<void>
    cycle?: {
      prev: () => void | Promise<void>
      next: () => void | Promise<void>
    }
  }

  type Props = {
    commands: Command[]
    onClose: () => void
  }

  let { commands, onClose }: Props = $props()

  let query = $state('')
  let cursor = $state(0) // 全扁平列表里的下标
  let inputEl: HTMLInputElement
  let listEl: HTMLUListElement

  let filtered = $derived(
    !query.trim()
      ? commands
      : commands.filter((c) => {
          const q = query.toLowerCase()
          return (
            c.label.toLowerCase().includes(q) ||
            (c.detail ?? '').toLowerCase().includes(q)
          )
        })
  )

  const GROUP_ORDER: string[] = ['tab', 'view', 'memory', 'remote', 'other']
  function groupLabel(group: string): string {
    return t(`command.group.${group}`)
  }

  /// 把 filtered 排成扁平的「行」序列:每个 group 一个 header 行,后跟它的命令行。
  /// flatItems 只含命令(用于游标导航);rows 含 header + 命令(用于渲染)。
  type Row =
    | { kind: 'header'; group: string; label: string }
    | { kind: 'cmd'; cmd: Command; flatIndex: number }

  let view = $derived.by(() => {
    void $currentLocale
    const map = new Map<string, Command[]>()
    filtered.forEach((cmd) => {
      const g = cmd.group ?? 'other'
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(cmd)
    })
    const rows: Row[] = []
    const flat: Command[] = []
    for (const g of GROUP_ORDER) {
      const items = map.get(g)
      if (!items || items.length === 0) continue
      rows.push({ kind: 'header', group: g, label: groupLabel(g) })
      for (const cmd of items) {
        rows.push({ kind: 'cmd', cmd, flatIndex: flat.length })
        flat.push(cmd)
      }
    }
    return { rows, flat }
  })

  /// query 变化时重置游标。
  $effect(() => {
    void query
    void view.flat.length
    cursor = 0
  })

  /// 游标变化时把对应行滚进可视区(手动算 scrollTop,见旧版注释保留的坐标系坑)。
  $effect(() => {
    const i = cursor
    void view.flat.length
    requestAnimationFrame(() => {
      const el = listEl?.querySelector(`li[data-flat="${i}"]`) as HTMLElement | undefined
      if (!el || !listEl) return
      const listRect = listEl.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      const relativeTop = elRect.top - listRect.top + listEl.scrollTop
      const relativeBottom = relativeTop + el.offsetHeight
      const viewTop = listEl.scrollTop
      const viewBottom = viewTop + listEl.clientHeight
      // header 在命令上方,滚动时多留一点上边距,避免命令贴边
      if (relativeTop < viewTop) {
        listEl.scrollTop = Math.max(0, relativeTop - 26)
      } else if (relativeBottom > viewBottom) {
        listEl.scrollTop = relativeBottom - listEl.clientHeight
      }
    })
  })

  onMount(() => {
    inputEl?.focus()
  })

  async function executeAt(i: number) {
    const c = view.flat[i]
    if (!c) return
    onClose()
    await c.run()
  }

  async function cycleAt(i: number, dir: 'prev' | 'next') {
    const c = view.flat[i]
    if (!c?.cycle) return
    await c.cycle[dir]()
    // cycle 不关闭面板,但触发的副作用(sidebar/theme DOM 变化 / commands 数组重建)
    // 可能让输入框失焦,之后再按 ←/→ 就到不了 onKey。等 DOM flush 后把焦点拉回 input,
    // 保证能连续切。tick() 比 rAF 可靠 —— 它保证 Svelte 把重渲染应用到 DOM 之后再聚焦。
    await tick()
    inputEl?.focus()
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      executeAt(cursor)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      cursor = Math.min(cursor + 1, view.flat.length - 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      cursor = Math.max(cursor - 1, 0)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      cycleAt(cursor, 'next')
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      cycleAt(cursor, 'prev')
    }
  }
</script>

<div class="backdrop" use:outsidePressClose={{ onClose }} role="presentation">
  <div
    class="palette"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
    role="dialog"
    aria-label={t('command.palette.title')}
    aria-modal="true"
    tabindex="-1"
  >
    <div class="search-row">
      <Icon name="search" size={16} class="search-icon" />
      <input
        bind:this={inputEl}
        bind:value={query}
        onkeydown={onKey}
        placeholder={t('command.palette.search')}
        spellcheck="false"
        autocomplete="off"
      />
      {#if query}
        <button class="clear" onclick={() => (query = '')} aria-label={t('command.palette.clear')}>
          <Icon name="x" size={13} />
        </button>
      {/if}
    </div>

    <ul bind:this={listEl} class="cmd-list">
      {#each view.rows as row (row.kind === 'header' ? `h-${row.group}` : row.cmd.id)}
        {#if row.kind === 'header'}
          <li class="group-head" aria-hidden="true">{row.label}</li>
        {:else}
          {@const i = row.flatIndex}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            class="cmd"
            class:active={i === cursor}
            data-flat={i}
            onclick={() => executeAt(i)}
            onmousemove={() => { if (cursor !== i) cursor = i }}
            role="option"
            tabindex="-1"
            aria-selected={i === cursor}
          >
            <span class="label">{row.cmd.label}</span>
            {#if row.cmd.detail}<span class="detail">{row.cmd.detail}</span>{/if}
            {#if row.cmd.cycle}
              <span class="cycle-hint" aria-hidden="true">←→</span>
            {/if}
          </li>
        {/if}
      {/each}
      {#if view.flat.length === 0}
        <li class="empty">{t('command.palette.noMatches')}</li>
      {/if}
    </ul>

    <div class="footer">
      <span><kbd>↑↓</kbd> {t('command.palette.navigate')}</span>
      <span><kbd>↵</kbd> {t('command.palette.run')}</span>
      <span><kbd>esc</kbd> {t('command.palette.close')}</span>
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
    z-index: 1000;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 13vh;
    animation: fadeIn 100ms ease-out;
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .palette {
    width: 560px;
    max-width: 92vw;
    max-height: 64vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-elevated);
    border: 1px solid var(--bd-strong);
    border-radius: var(--rad-lg);
    box-shadow: var(--sh-modal);
    overflow: hidden;
    color: var(--fg-primary);
    font-family: var(--font-ui);
    font-size: var(--fs-md);
    animation: slideIn 120ms cubic-bezier(0.2, 0, 0, 1);
  }
  @keyframes slideIn {
    from { transform: translateY(-6px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  /* ── 搜索框 ── */
  .search-row {
    display: flex;
    align-items: center;
    gap: 11px;
    min-height: 52px;
    padding: 0 16px;
    border-bottom: 1px solid var(--bd-default);
  }
  .search-row :global(.search-icon) {
    color: var(--fg-tertiary);
    flex-shrink: 0;
  }
  input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--fg-primary);
    font: inherit;
    font-size: 16px;
    letter-spacing: -0.01em;
    outline: none;
    padding: 0;
  }
  input::placeholder { color: var(--fg-tertiary); }
  .clear {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border: none;
    background: var(--bg-chip);
    border-radius: 50%;
    color: var(--fg-tertiary);
    cursor: pointer;
    flex-shrink: 0;
    transition: color var(--t-fast), background var(--t-fast);
  }
  .clear:hover { color: var(--fg-primary); background: var(--bg-hover); }

  /* ── 命令列表 ── */
  .cmd-list {
    list-style: none;
    margin: 0;
    padding: 6px;
    flex: 1;
    min-width: 0;
    overflow-y: auto;
  }
  .group-head {
    padding: 10px 10px 4px;
    font-size: 10px;
    font-weight: var(--fw-semi);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-tertiary);
  }
  .cmd-list li.cmd {
    min-height: 34px;
    padding: 7px 10px;
    border-radius: var(--rad-md);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    transition: background var(--t-fast);
  }
  .cmd-list li.cmd.active {
    background: var(--acc-soft);
  }
  .label {
    flex: 1;
    color: var(--fg-primary);
    font-weight: var(--fw-med);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cmd-list li.cmd.active .label { color: var(--fg-primary); }
  .detail {
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
    font-family: var(--font-mono);
    flex-shrink: 0;
  }
  .cmd-list li.cmd.active .detail { color: var(--fg-secondary); }
  .cycle-hint {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--acc);
    opacity: 0;
    flex-shrink: 0;
  }
  .cmd-list li.cmd.active .cycle-hint { opacity: 0.8; }
  .cmd-list li.empty {
    padding: 24px 10px;
    color: var(--fg-tertiary);
    text-align: center;
    cursor: default;
  }

  /* ── footer ── */
  .footer {
    min-height: 32px;
    padding: 0 14px;
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
    border-top: 1px solid var(--bd-default);
    display: flex;
    align-items: center;
    gap: var(--sp-4);
  }
  .footer span { display: inline-flex; align-items: center; gap: 5px; }
  kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: var(--rad-sm);
    background: var(--bg-chip);
    color: var(--fg-secondary);
    font-family: var(--font-mono);
    font-size: 10px;
    border: 1px solid var(--bd-muted);
  }

  @media (max-width: 620px) {
    .palette { max-width: 100%; }
  }
  @media (prefers-reduced-motion: reduce) {
    .backdrop, .palette { animation: none; }
  }
</style>
