<script lang="ts">
  import { tick } from 'svelte'
  import { t, currentLocale } from './i18n'
  let tr = $derived.by(() => { void $currentLocale; return t })

  let { steps, current, detail = '' }: { steps: string[]; current: number; detail?: string } = $props()
  let viewport: HTMLDivElement | undefined = $state()
  let followLatest = true
  let atBottom = $state(false)

  $effect(() => {
    current; detail
    if (followLatest) {
      void tick().then(() => {
        if (viewport && followLatest) {
          viewport.scrollTo({ top: 0, behavior: 'instant' })
        }
        if (viewport) atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2
      })
    }
  })
</script>

<section class="progress-panel" aria-label={tr('app.startup.title')}>
  <header>
    <span>{tr('app.startup.title')}</span>
    <span class="count">{current + 1} / {steps.length}</span>
  </header>
  <div class="track" role="progressbar" aria-label={tr('app.startup.title')}
    aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={current}
    aria-valuetext={tr(`app.startup.${steps[current]}`)}>
    <div class="fill" style:width={`${current / steps.length * 100}%`}></div>
  </div>
  <p class="detail" title={detail}>{detail || tr(`app.startup.${steps[current]}`)}</p>
  <div class="history" class:faded={current >= 5 && !atBottom}>
  <!-- Keyboard focus enables native scrolling through the progress history. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="steps" bind:this={viewport} tabindex="0" role="region"
    aria-label={tr('app.startup.scrollHint')}
    onscroll={() => {
      if (viewport) {
        followLatest = viewport.scrollTop < 8
        atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2
      }
    }}>
    {#each steps.slice(0, current + 1).reverse() as step, index (step)}
      <div class="step" class:active={index === 0}>
        <span class="marker" aria-label={tr(index === 0 ? 'app.startup.active' : 'app.startup.processed')}>
          {index === 0 ? '◉' : '✓'}
        </span>
        <span class="sequence" aria-hidden="true">{String(current - index + 1).padStart(2, '0')}</span>
        <div class="step-label">
          <span title={tr(`app.startup.${step}`)}>{tr(`app.startup.${step}`)}</span>
        </div>
      </div>
    {/each}
  </div>
  </div>
  <span class="sr-only" role="status" aria-live="polite">{tr(`app.startup.${steps[current]}`)} {detail}</span>
</section>

<style>
  .progress-panel { width: min(380px, calc(100vw - 48px)); border: 1px solid var(--bd-default); border-radius: 10px; background: linear-gradient(135deg, color-mix(in srgb, var(--acc) 5%, var(--bg-elevated)), var(--bg-elevated) 60%); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--acc) 18%, transparent); padding: 16px; box-sizing: border-box; cursor: default; }
  header { display: flex; justify-content: space-between; gap: 12px; font-size: var(--fs-sm); }
  .count { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--acc); letter-spacing: 0.08em; }
  .track { height: 4px; margin: 12px 0; background: var(--bd-muted); border-radius: 3px; overflow: hidden; }
  .fill { height: 100%; background: repeating-linear-gradient(90deg, var(--acc) 0 18px, transparent 18px 21px); transition: width 180ms ease; }
  .steps { height: min(180px, 30vh); overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .steps:focus-visible { outline: 2px solid var(--acc); outline-offset: 3px; border-radius: 4px; }
  .step { display: flex; gap: 10px; height: 36px; box-sizing: border-box; align-items: center; padding: 0 6px; font-size: var(--fs-sm); line-height: 1.5; overflow-wrap: anywhere; }
  .active { color: var(--fg-primary); background: linear-gradient(90deg, color-mix(in srgb, var(--acc) 10%, transparent), transparent); border-radius: 4px; }
  .step-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .step-label span { cursor: default; }
  .sequence { font: var(--fs-xs) var(--font-mono); color: var(--fg-secondary); font-variant-numeric: tabular-nums; opacity: 0.65; }
  .history { position: relative; }
  .history::after { content: ''; position: absolute; inset: auto 10px 0 0; height: 48px; background: linear-gradient(transparent, var(--bg-elevated)); pointer-events: none; opacity: 0; }
  .history.faded::after { opacity: 1; }
  .marker { width: 16px; flex: 0 0 16px; text-align: center; }
  .active .marker { color: var(--acc); font-weight: 700; }
  .detail { min-height: 36px; max-height: 64px; overflow-y: auto; overflow-wrap: anywhere; line-height: 1.5; margin: 0 0 8px; color: var(--fg-secondary); font-size: var(--fs-xs); }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (prefers-reduced-motion: reduce) { .fill { transition: none; } }
</style>
