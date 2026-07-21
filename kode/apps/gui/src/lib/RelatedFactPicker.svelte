<script lang="ts">
  /**
   * RelatedFactPicker.svelte —— Phase 10.10:edit-then-approve 时的"插相关 fact" picker。
   *
   * 用法:在 MemoryPanel(edit-then-approve)/ MemoryFactDetail(后期手动建链)里嵌入。
   * 输入框输入 query → 每键 200ms debounce → 调 memory_search → 列 Top-3 →
   * 用户点 "+ related" 或 "+ contradicts" 把该 ULID 加进对应数组。
   * 已选条目以 chip 显示,× 移除。
   *
   * 排除规则:
   *   1. 当前 fact 自己(parentId)
   *   2. 已被选作 related 或 contradicts 的项
   *
   * Props:
   *   parentId   — 当前正在编辑/审核的 fact id;搜结果不会列它自己
   *   scope      — 可选 scope 过滤(默认不限,因为 edit-then-approve 后 scope 可能改)
   *   related    — 双向绑定:已选 related 数组
   *   contradicts — 双向绑定:已选 contradicts 数组
  */
  import { memoryIpc, type MemorySearchHit } from './ipc'
  import Icon from './Icon.svelte'
  import { t } from './i18n'

  type Props = {
    parentId?: string | null
    scope?: string
    related: string[]
    contradicts: string[]
  }
  let {
    parentId = null,
    scope = undefined,
    related = $bindable([]),
    contradicts = $bindable([]),
  }: Props = $props()

  let query = $state('')
  let hits: MemorySearchHit[] = $state([])
  let searching = $state(false)
  let timer: number | null = null

  $effect(() => {
    // query 变化 → debounce 200ms 后搜索
    if (timer != null) window.clearTimeout(timer)
    if (query.trim() === '') {
      hits = []
      return
    }
    timer = window.setTimeout(async () => {
      searching = true
      try {
        const r = await memoryIpc.search({
          query: query.trim(),
          scope,
          top_k: 5,  // 多取 2 个,过滤掉 self/已选后还能稳显 3 条
          include_deprecated: false,
        })
        hits = r
      } catch {
        hits = []
      } finally {
        searching = false
      }
    }, 200)
  })

  function selectable(h: MemorySearchHit): boolean {
    if (parentId && h.id === parentId) return false
    if (related.includes(h.id)) return false
    if (contradicts.includes(h.id)) return false
    return true
  }

  function addRelated(h: MemorySearchHit) {
    if (!related.includes(h.id)) {
      related = [...related, h.id]
    }
  }
  function addContradicts(h: MemorySearchHit) {
    if (!contradicts.includes(h.id)) {
      contradicts = [...contradicts, h.id]
    }
  }
  function removeRelated(id: string) {
    related = related.filter((x) => x !== id)
  }
  function removeContradicts(id: string) {
    contradicts = contradicts.filter((x) => x !== id)
  }

  // 短 ULID 显示(前 8 位)
  function shortId(id: string): string {
    return id.length > 10 ? id.slice(0, 10) + '…' : id
  }
</script>

<div class="picker">
  <div class="header">
    <span class="title"><Icon name="link" /> Link to other facts</span>
    <span class="hint muted">type to search · click + to add</span>
  </div>

  <input
    class="input"
    bind:value={query}
    placeholder={t('memory.related.searchPlaceholder')}
    spellcheck="false"
  />

  {#if searching}
    <div class="status muted">{t('memory.browse.searching')}</div>
  {:else if query && hits.length === 0}
    <div class="status muted">no results</div>
  {:else if hits.length > 0}
    <ul class="hits">
      {#each hits.slice(0, 3) as h (h.id)}
        <li class="hit" class:dim={!selectable(h)}>
          <div class="hit-meta">
            <code class="hit-id">{shortId(h.id)}</code>
            <span class="hit-kind">{h.kind}</span>
            <span class="hit-scope muted">{h.scope}</span>
          </div>
          <div class="hit-snippet">{h.snippet}</div>
          {#if selectable(h)}
            <div class="hit-actions">
              <button class="mini ok" onclick={() => addRelated(h)} title={t('memory.related.addRelated')}>
                <Icon name="link" /> related
              </button>
              <button class="mini warn" onclick={() => addContradicts(h)} title={t('memory.related.addContradicts')}>
                <Icon name="alert-triangle" /> contradicts
              </button>
            </div>
          {:else}
            <div class="hit-actions">
              <span class="muted">already linked</span>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if related.length > 0 || contradicts.length > 0}
    <div class="selections">
      {#if related.length > 0}
        <div class="sel-row">
          <span class="sel-lbl">related</span>
          {#each related as id (id)}
            <span class="chip ok">
              <code>{shortId(id)}</code>
              <button class="x" onclick={() => removeRelated(id)} aria-label={t('memory.related.remove')}>×</button>
            </span>
          {/each}
        </div>
      {/if}
      {#if contradicts.length > 0}
        <div class="sel-row">
          <span class="sel-lbl">contradicts</span>
          {#each contradicts as id (id)}
            <span class="chip warn">
              <code>{shortId(id)}</code>
              <button class="x" onclick={() => removeContradicts(id)} aria-label={t('memory.related.remove')}>×</button>
            </span>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border: 1px dashed var(--border-muted, #444);
    border-radius: 6px;
    background: var(--bg-subtle, rgba(255, 255, 255, 0.02));
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 4px;
    font-weight: 600;
  }
  .hint {
    font-size: 11px;
  }
  .input {
    background: var(--bg-input, transparent);
    color: inherit;
    border: 1px solid var(--border, #444);
    border-radius: 4px;
    padding: 5px 8px;
    font-size: 13px;
    font-family: inherit;
    outline: none;
  }
  .input:focus {
    border-color: var(--accent, #6cf);
  }
  .status {
    font-size: 11px;
    padding: 2px 0;
  }
  .hits {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .hit {
    border: 1px solid var(--border-muted, #333);
    border-radius: 4px;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .hit.dim {
    opacity: 0.5;
  }
  .hit-meta {
    display: flex;
    gap: 8px;
    font-size: 11px;
    align-items: center;
  }
  .hit-id {
    font-family: ui-monospace, monospace;
  }
  .hit-snippet {
    font-size: 12px;
    line-height: 1.35;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .hit-actions {
    display: flex;
    gap: 6px;
    margin-top: 2px;
  }
  .mini {
    background: transparent;
    border: 1px solid var(--border, #444);
    border-radius: 3px;
    padding: 2px 8px;
    font-size: 11px;
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .mini:hover {
    background: var(--bg-hover, rgba(255, 255, 255, 0.05));
  }
  .mini.ok {
    color: var(--text-ok, #6c6);
  }
  .mini.warn {
    color: var(--text-warn, #fc6);
  }
  .selections {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 4px;
  }
  .sel-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }
  .sel-lbl {
    font-size: 11px;
    color: var(--text-muted, #888);
    margin-right: 4px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 11px;
    border: 1px solid currentColor;
  }
  .chip.ok {
    color: var(--text-ok, #6c6);
  }
  .chip.warn {
    color: var(--text-warn, #fc6);
  }
  .chip code {
    font-family: ui-monospace, monospace;
  }
  .x {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0;
    font-size: 14px;
    line-height: 1;
  }
  .muted {
    color: var(--text-muted, #888);
  }
</style>
