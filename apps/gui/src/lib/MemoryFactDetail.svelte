<script lang="ts">
  /**
   * MemoryFactDetail.svelte —— Phase 10.10:fact 详情 + 反链。
   *
   * 用法:接收 factId,自己异步加载 read_with_backlinks,渲染:
   *   - frontmatter chips(kind / scope / subsystem / tags / confidence)
   *   - body
   *   - links section(supersedes / related / contradicts)
   *   - backlinks section("被引用 N 次,展开看")
   *   - dead_end 三字段(tried / failed_because / use_instead)— 仅 kind=dead_end 时
   *
   * 父组件通过 actions slot 自己塞按钮(deprecate / edit 等)。
   *
   * Props:
   *   factId  — 要显示的 fact ULID
   *   onLink  — 可选回调:点击反链/链接里的 ULID 时父组件可决定切换详情
   */
  import { onMount } from 'svelte'
  import { memoryIpc, type MemoryFactWithBacklinks } from './ipc'
  import Icon, { type IconName } from './Icon.svelte'
  import { formatLocalDateTimeFull } from './time'
  import { t } from './i18n'

  type Props = {
    factId: string
    onLink?: (id: string) => void
  }
  let { factId, onLink }: Props = $props()

  let data: MemoryFactWithBacklinks | null = $state(null)
  let loadError: string | null = $state(null)
  let backlinksOpen = $state(false)

  $effect(() => {
    // factId 变化 → 重新加载
    void factId
    let cancelled = false
    ;(async () => {
      data = null
      loadError = null
      try {
        const r = await memoryIpc.readWithBacklinks(factId)
        if (!cancelled) data = r
      } catch (e) {
        if (!cancelled) loadError = String(e)
      }
    })()
    return () => {
      cancelled = true
    }
  })

  function kindIcon(kind: string): IconName {
    switch (kind) {
      case 'gotcha': return 'alert-triangle'
      case 'invariant': return 'lock'
      case 'recipe': return 'list-checks'
      case 'dead_end': return 'construction'
      case 'preference': return 'star'
      default: return 'list-checks'
    }
  }

  function shortId(id: string): string {
    return id.length > 12 ? id.slice(0, 12) + '…' : id
  }

  async function copyId() {
    if (!data) return
    try {
      await navigator.clipboard.writeText(data.fact.id)
    } catch {
      // 静默 — Tauri 默认允许 navigator.clipboard,失败也只是复制不上而已
    }
  }
</script>

{#if loadError}
  <div class="boot-error"><strong>{t('memory.detail.loadFailed')}</strong><br/>{loadError}</div>
{:else if !data}
  <div class="muted">{t('memory.common.loading')}</div>
{:else}
  {@const f = data.fact}
  <!-- Scope banner -->
  <div class="scope-banner">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
    </svg>
    SCOPE: <strong>{f.scope}</strong>
    &nbsp;&nbsp;
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
    <strong>{formatLocalDateTimeFull(f.created)}</strong> by <strong>{f.author}</strong>
  </div>

  <!-- Confidence gauge -->
  <div class="detail-section">
    <div class="detail-section-label">{t('memory.detail.confidence')}</div>
    <div class="confidence-wrap">
      <div class="confidence-bar-track">
        <div class="confidence-bar-fill {f.confidence >= 0.85 ? 'conf-high' : f.confidence >= 0.6 ? 'conf-medium' : 'conf-low'}" style="width: {f.confidence * 100}%"></div>
      </div>
      <span class="confidence-pct">{f.confidence.toFixed(2)}</span>
    </div>
  </div>

  <div class="divider"></div>

  <!-- Content -->
  <div class="detail-section">
    <div class="detail-section-label">{t('memory.detail.content')}</div>
    {#if f.body}
      <div class="rule-line">{f.body}</div>
    {:else}
      <div class="muted">(empty / deprecated)</div>
    {/if}
  </div>

  <div class="divider"></div>

  {#if f.tags.length > 0}
    <div class="detail-section">
      <div class="detail-section-label">{t('memory.detail.tags')}</div>
      <div class="tags-row">
        {#each f.tags as t}<span class="tag-pill">#{t}</span>{/each}
      </div>
    </div>
    <div class="divider"></div>
  {/if}

  <!-- Metadata grid -->
  <div class="detail-section">
    <div class="detail-section-label">{t('memory.detail.metadata')}</div>
    <div class="meta-grid">
      <div class="meta-cell">
        <div class="meta-cell-label">{t('memory.detail.type')}</div>
        <div class="meta-cell-value">{f.kind}</div>
      </div>
      <div class="meta-cell">
        <div class="meta-cell-label">{t('memory.detail.scope')}</div>
        <div class="meta-cell-value">{f.scope}</div>
      </div>
      <div class="meta-cell">
        <div class="meta-cell-label">{t('memory.detail.author')}</div>
        <div class="meta-cell-value">{f.author}</div>
      </div>
      <div class="meta-cell">
        <div class="meta-cell-label">{t('memory.detail.confidence')}</div>
        <div class="meta-cell-value">{f.confidence.toFixed(2)}</div>
      </div>
    </div>
  </div>

  <div class="divider"></div>

  <!-- Frontmatter -->
  <div class="detail-section">
    <div class="detail-section-label">{t('memory.detail.frontmatter')}</div>
    <div class="code-block">---
name: {f.id}
description: {f.body?.slice(0, 80) ?? ''}
type: {f.kind}
---</div>
  </div>

  <div class="divider"></div>

  {#if f.kind === 'dead_end' && (f.tried || f.failed_because || f.use_instead)}
    <section class="block dead-end">
      <h3><Icon name="construction" /> Dead end</h3>
      {#if f.tried}<div><span class="muted">tried:</span> {f.tried}</div>{/if}
      {#if f.failed_because}<div><span class="muted">failed because:</span> {f.failed_because}</div>{/if}
      {#if f.use_instead}<div><span class="muted">use instead:</span> {f.use_instead}</div>{/if}
    </section>
  {/if}

  <section class="block">
    <h3>{t('memory.review.body')}</h3>
    {#if f.body}
      <pre class="body">{f.body}</pre>
    {:else}
      <div class="muted">(empty / deprecated)</div>
    {/if}
  </section>

  {#if f.supersedes || f.related.length > 0 || f.contradicts.length > 0}
    <section class="block links">
      <h3><Icon name="link" /> Links</h3>
      {#if f.supersedes}
        <div class="link-row">
          <span class="muted">supersedes</span>
          <button class="link-btn" onclick={() => onLink?.(f.supersedes!)}>
            <code>{shortId(f.supersedes)}</code>
          </button>
        </div>
      {/if}
      {#if f.related.length > 0}
        <div class="link-row">
          <span class="muted">related</span>
          {#each f.related as id}
            <button class="link-btn" onclick={() => onLink?.(id)}>
              <code>{shortId(id)}</code>
            </button>
          {/each}
        </div>
      {/if}
      {#if f.contradicts.length > 0}
        <div class="link-row">
          <span class="muted">contradicts</span>
          {#each f.contradicts as id}
            <button class="link-btn warn" onclick={() => onLink?.(id)}>
              <code>{shortId(id)}</code>
            </button>
          {/each}
        </div>
      {/if}
    </section>
  {/if}

  {#if data.backlinks.length > 0}
    <section class="block backlinks">
      <button class="bl-toggle" onclick={() => (backlinksOpen = !backlinksOpen)}>
        <Icon name={backlinksOpen ? 'chevron-down' : 'chevron-right'} />
        <strong>{data.backlinks.length} backlinks</strong>
        <span class="muted">(谁引用了我)</span>
      </button>
      {#if backlinksOpen}
        <ul class="bl-list">
          {#each data.backlinks as b (b.id + b.kind)}
            <li>
              <button class="bl-item" onclick={() => onLink?.(b.id)}>
                <code class="bl-id">{shortId(b.id)}</code>
                <span class="bl-kind {b.kind}">{b.kind}</span>
                <span class="bl-snippet">{b.snippet}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
{/if}

<style>
  /* Scope banner */
  .scope-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    background: color-mix(in srgb, var(--acc) 5%, transparent);
    border: 1px solid color-mix(in srgb, var(--acc) 14%, transparent);
    border-radius: var(--rad-md);
    font-size: var(--fs-sm);
    color: var(--fg-secondary);
    font-family: var(--font-mono);
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .scope-banner strong { font-weight: 700; color: var(--acc); }

  /* Section headers with trailing line */
  .detail-section { margin-bottom: 18px; }
  .detail-section-label {
    font-size: 9.5px;
    font-family: var(--font-mono);
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--fg-tertiary);
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .detail-section-label::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--bd-muted);
  }

  /* Confidence bar gauge */
  .confidence-wrap { display: flex; align-items: center; gap: 10px; }
  .confidence-bar-track {
    flex: 1;
    height: 5px;
    background: var(--bg-chip);
    border-radius: 3px;
    overflow: hidden;
    border: 1px solid var(--bd-muted);
  }
  .confidence-bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .conf-high   { background: var(--st-ok); box-shadow: 0 0 6px color-mix(in srgb, var(--st-ok) 40%, transparent); }
  .conf-medium { background: var(--st-warn); box-shadow: 0 0 6px color-mix(in srgb, var(--st-warn) 40%, transparent); }
  .conf-low    { background: var(--st-err); box-shadow: 0 0 6px color-mix(in srgb, var(--st-err) 40%, transparent); }
  .confidence-pct {
    font-size: var(--fs-sm);
    font-family: var(--font-mono);
    color: var(--fg-tertiary);
    width: 36px;
    text-align: right;
    font-weight: 600;
  }

  /* Divider */
  .divider { height: 1px; background: var(--bd-muted); margin: 14px 0; }

  /* Rule block */
  .rule-line {
    display: block;
    padding: 12px 16px;
    background: var(--bg-card);
    border: 1px solid var(--bd-muted);
    border-left: 3px solid var(--acc);
    border-radius: 0 var(--rad-md) var(--rad-md) 0;
    font-size: var(--fs-md);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Tags */
  .tags-row { display: flex; flex-wrap: wrap; gap: 5px; }
  .tag-pill {
    font-size: var(--fs-xs);
    font-family: var(--font-mono);
    padding: 3px 9px;
    border-radius: var(--rad-sm);
    background: var(--bg-chip);
    border: 1px solid var(--bd-muted);
    color: var(--fg-secondary);
    cursor: default;
  }

  /* Metadata grid */
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .meta-cell {
    padding: 10px 14px;
    background: var(--bg-card);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
  }
  .meta-cell-label {
    font-size: 9px;
    font-family: var(--font-mono);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--fg-tertiary);
    margin-bottom: 3px;
  }
  .meta-cell-value {
    font-size: var(--fs-sm);
    font-family: var(--font-mono);
    color: var(--fg-primary);
  }

  /* Code block */
  .code-block {
    background: var(--bg-pre);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
    padding: 10px 14px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--fg-primary);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .block {
    margin-bottom: 14px;
  }
  .block h3 {
    margin: 0 0 6px 0;
    font-size: 10px;
    font-family: var(--font-mono);
    font-weight: var(--fw-semi);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-tertiary);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .block h3::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--bd-muted);
  }
  .body {
    background: var(--bg-pre);
    border: 1px solid var(--bd-muted);
    padding: 10px 12px;
    border-radius: 4px;
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .dead-end {
    background: color-mix(in srgb, var(--st-warn) 8%, transparent);
    padding: 8px 10px;
    border-radius: 4px;
    font-size: 13px;
    border-left: 3px solid var(--st-warn);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--st-warn) 10%, transparent);
  }
  .dead-end div {
    margin: 2px 0;
  }
  .link-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 3px 0;
    align-items: baseline;
  }
  .link-row .muted {
    width: 96px;
    flex-shrink: 0;
    text-align: right;
  }
  .link-btn {
    background: transparent;
    border: 1px solid var(--bd-default);
    border-radius: 3px;
    padding: 1px 8px;
    font-size: 11px;
    color: inherit;
    cursor: pointer;
  }
  .link-btn:hover {
    background: var(--bg-hover);
  }
  .link-btn.warn {
    border-color: var(--st-warn);
    color: var(--st-warn);
  }
  .bl-toggle {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 0;
    font-size: 12px;
    transition: color 0.15s ease;
  }
  .bl-toggle:hover {
    color: var(--acc);
  }
  .bl-list {
    list-style: none;
    margin: 4px 0 0 0;
    padding: 0 0 0 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .bl-item {
    width: 100%;
    background: transparent;
    border: 1px solid var(--bd-muted);
    border-radius: 3px;
    padding: 4px 8px;
    text-align: left;
    cursor: pointer;
    color: inherit;
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 12px;
  }
  .bl-item:hover {
    background: var(--bg-hover);
  }
  .bl-id {
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
  }
  .bl-kind {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    flex-shrink: 0;
  }
  .bl-kind.related { color: var(--st-ok); }
  .bl-kind.contradicts { color: var(--st-warn); }
  .bl-kind.supersedes { color: var(--fg-tertiary); }
  .bl-snippet {
    flex-grow: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-tertiary);
  }
  .mini {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0 4px;
  }
  .muted {
    color: var(--fg-tertiary);
  }
  .boot-error {
    color: var(--st-err);
    padding: 8px;
  }
</style>
