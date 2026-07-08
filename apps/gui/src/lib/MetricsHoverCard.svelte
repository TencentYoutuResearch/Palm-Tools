<script lang="ts">
  /**
   * MetricsHoverCard.svelte —— Phase 10.5 / M5 GUI 部分。
   *
   * 状态栏 pending 徽章 hover 300ms 后,弹一个 3+ 行小卡片:
   *   1) 今日 propose 数
   *   2) 7 天接受率(基于 metrics.jsonl aggregate_7d)
   *   3) 每个 author 当前能量(已 refill,unicode block 条 — 不用 emoji)
   *
   * 数据由后端 `memory_metrics_summary` 命令提供,30s 服务端缓存。
   * 父组件控制 visible(由 hover 状态驱动)。
   *
   * 不阻塞 PTY 渲染:
   *   - 加载失败 silently fallback,不抛 error
   *   - 卡片本身 absolute 定位,不影响 layout
   */
  import { onMount } from 'svelte'
  import { memoryIpc, type MemoryMetricsSummary } from './ipc'
  import Icon from './Icon.svelte'

  type Props = {
    visible: boolean
  }
  let { visible }: Props = $props()

  let data: MemoryMetricsSummary | null = $state(null)
  let loadError: string | null = $state(null)

  $effect(() => {
    if (!visible) return
    // 进入可见态 → 拉数据(后端 30s 缓存,频繁 hover 不会打底层)
    let cancelled = false
    ;(async () => {
      try {
        const r = await memoryIpc.metricsSummary()
        if (!cancelled) {
          data = r
          loadError = null
        }
      } catch (e) {
        if (!cancelled) loadError = String(e)
      }
    })()
    return () => {
      cancelled = true
    }
  })

  /** 用 unicode block 字符画能量条。10 段。无 emoji */
  function energyBar(e: number, max: number): string {
    const segs = 10
    const filled = Math.round((e / max) * segs)
    const clamped = Math.min(Math.max(filled, 0), segs)
    return '█'.repeat(clamped) + '░'.repeat(segs - clamped)
  }
</script>

{#if visible}
  <div class="card" role="tooltip" aria-label="Memory metrics summary">
    {#if loadError}
      <div class="line err">metrics: {loadError}</div>
    {:else if !data}
      <div class="line muted">loading metrics…</div>
    {:else}
      <div class="line">
        <span class="lbl">今日 propose</span>
        <span class="val">{data.today_proposes}</span>
      </div>
      <div class="line">
        <span class="lbl">7天接受率</span>
        <span class="val">
          {#if data.accept_rate_7d != null}
            {(data.accept_rate_7d * 100).toFixed(0)}%
            <span class="muted small">({data.total_reviews_7d} reviews)</span>
          {:else}
            <span class="muted">--</span>
          {/if}
        </span>
      </div>
      {#if data.energy_by_author.length > 0}
        <div class="sep"></div>
        <div class="line lbl-row">
          <span class="lbl"><Icon name="zap" /> energy</span>
        </div>
        {#each data.energy_by_author as e (e.author)}
          <div class="line energy">
            <span class="author">{e.author}</span>
            <span class="bar">{energyBar(e.energy, e.max)}</span>
            <span class="num">{e.energy.toFixed(1)}/{e.max.toFixed(0)}</span>
          </div>
        {/each}
      {/if}
      {#if data.by_author.length > 0}
        <div class="sep"></div>
        <div class="line lbl-row">
          <span class="lbl"><Icon name="check" /> by author (7d)</span>
        </div>
        {#each data.by_author as a (a.author)}
          <div class="line by-author">
            <span class="author">{a.author}</span>
            <span class="num">
              {#if a.rate != null}{(a.rate * 100).toFixed(0)}%{:else}--{/if}
              <span class="muted small">({a.accepts}/{a.total_reviews})</span>
            </span>
          </div>
        {/each}
      {/if}
    {/if}
  </div>
{/if}

<style>
  .card {
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    background: var(--bg-tooltip, #1f1f1f);
    color: var(--fg, #ddd);
    border: 1px solid var(--border, #444);
    border-radius: 4px;
    padding: 8px 12px;
    min-width: 220px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    z-index: 1200;
    font-size: 12px;
    pointer-events: none; /* 不抢 hover —— 父按钮 onmouseleave 才会消失 */
  }
  .line {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    padding: 1px 0;
    white-space: nowrap;
  }
  .line.lbl-row {
    margin-top: 2px;
  }
  .line.energy {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    /*
     * 三栏 grid:author | bar | num。前两栏左对齐、第三栏右对齐。
     * 不能沿用父级 .line 的 justify-content:space-between —— 那会让 .bar
     * 被夹在中间,起点随 author 名字长度和能量填充数漂移,多行时参差不齐。
     * 固定 author 列宽 + 固定 bar 列宽(10 段 block 字符的宽度)让所有能量条
     * 左边缘严格对齐;num 列右对齐到卡片右缘。
     * author 名超长(如 claude-internal)用 ellipsis 截断,不破坏列宽。
     */
    display: grid;
    grid-template-columns: 72px 11ch 1fr;
    justify-content: start;
    align-items: baseline;
    column-gap: 8px;
  }
  .line.energy .author {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .line.energy .bar {
    text-align: left;
    /* 防止能量条右侧空段 ░ 被压缩,固定 10 段宽度 */
    white-space: pre;
  }
  .line.energy .num {
    text-align: right;
  }
  .line.by-author {
    font-size: 11px;
    /*
     * 两栏 grid:author | num。author 列固定宽度 + ellipsis,让百分比列
     * 严格右对齐到卡片右缘,不随 author 名字长度漂移。与 .line.energy 的
     * author 列宽(72px)保持一致,视觉上两段 author 起点也对齐。
     */
    display: grid;
    grid-template-columns: 72px 1fr;
    align-items: baseline;
    column-gap: 8px;
  }
  .line.by-author .author {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .line.by-author .num {
    text-align: right;
  }
  .lbl {
    color: var(--text-muted, #888);
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  .val {
    font-weight: 600;
  }
  .author {
    color: var(--text-author, #aaa);
  }
  .bar {
    color: var(--accent, #6cf);
    letter-spacing: -1px;
  }
  .num {
    color: var(--text-muted, #aaa);
  }
  .small {
    font-size: 10px;
  }
  .muted {
    color: var(--text-muted, #888);
  }
  .err {
    color: var(--text-err, #f66);
  }
  .sep {
    border-top: 1px solid var(--border-muted, #333);
    margin: 4px -2px;
  }
</style>
