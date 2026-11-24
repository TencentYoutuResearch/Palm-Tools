<script lang="ts" module>
  // Every mounted port drives the same native webview per extension view.
  // Only the most recent claimant may hide it, so tab switches cannot race a
  // late teardown of the previous tab's port against the new one's show.
  let latestClaim = 0
</script>

<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { extensionIpc } from './ipc'
  import { extensionProgress, type ViewTarget } from './extensions'
  import { currentLocale, t } from './i18n'

  let {
    target,
    sessionRef,
    visible,
    blocked,
    phase = $bindable('starting'),
  }: {
    target: ViewTarget
    /** Runtime session id the view should open (dsh session id). */
    sessionRef: string | undefined
    visible: boolean
    /** A modal or dropdown is open over the session area. */
    blocked: boolean
    /** Whether the page is up; Kode keeps its chrome until it is. */
    phase?: 'starting' | 'ready' | 'error'
  } = $props()

  const tr = (key: string, params?: Record<string, string | number>) => {
    void $currentLocale
    return t(key, params)
  }

  // The bound phase outlives this port; a revisit retries a failed start.
  if (phase === 'error') phase = 'starting'

  let host: HTMLDivElement | undefined = $state()
  let claim = 0
  let error = $state('')
  let attempt = $state(0)

  const startup = $derived($extensionProgress[target.extension])
  const fragment = $derived(sessionRef ? `kode-open-session=${encodeURIComponent(sessionRef)}` : null)
  const shown = $derived(visible && !blocked)

  function rect() {
    const box = host!.getBoundingClientRect()
    return { x: box.left, y: box.top, width: box.width, height: box.height }
  }

  /** Fragment this port last delivered; re-showing after an overlay must not
   *  pull the page back from a session the user opened inside it. */
  let applied: string | null = null

  async function show() {
    if (!host) return
    claim = ++latestClaim
    const mine = claim
    const next = fragment
    try {
      await extensionIpc.showView(target.extension, target.view.id, rect(), next === applied ? null : next)
      if (mine !== claim) return settleLate(mine)
      applied = next
      phase = 'ready'
      // Starting can take minutes; Kode's chrome may have collapsed around
      // the port meanwhile, so place the view where the port is now.
      sync()
    } catch (e) {
      if (mine !== claim) return
      phase = 'error'
      error = e instanceof Error ? e.message : String(e)
    }
  }

  function hide() {
    if (claim && claim === latestClaim) void extensionIpc.hideViews(target.extension).catch(() => {})
    claim = 0
  }

  /** A show that lands after this port let go of the view (left the mode,
   *  switched tabs) would leave it on screen over Kode; hide it again unless
   *  another port has claimed it since. */
  function settleLate(mine: number) {
    if (mine === latestClaim) void extensionIpc.hideViews(target.extension).catch(() => {})
  }

  $effect(() => {
    void attempt
    void fragment
    if (shown && host) {
      // A failure waits for Retry instead of looping.
      if (untrack(() => phase) === 'error') return
      void show()
    } else {
      hide()
    }
  })

  let frame = 0
  function sync() {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      if (host && claim && claim === latestClaim && phase === 'ready') {
        const mine = claim
        void extensionIpc.showView(target.extension, target.view.id, rect(), null)
          .then(() => { if (mine !== claim) settleLate(mine) })
          .catch(() => {})
      }
    })
  }

  // Follow layout changes (sidebar, inspector drag, bottom terminal, window).
  // Grid column transitions move the port without always resizing it, so
  // also settle on transitionend.
  $effect(() => {
    if (!host || !shown) return
    const observer = new ResizeObserver(sync)
    observer.observe(host)
    window.addEventListener('resize', sync)
    document.addEventListener('transitionend', sync, true)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', sync)
      document.removeEventListener('transitionend', sync, true)
    }
  })

  onDestroy(hide)

  function retry() {
    applied = null
    phase = 'starting'
    error = ''
    attempt += 1
  }
</script>

<div class="ext-port" bind:this={host}>
  {#if phase === 'starting'}
    <div class="ext-state">
      <span class="spinner" aria-hidden="true"></span>
      <span>{tr('extensions.view.starting', { name: target.extensionName })}</span>
      {#if startup}
        <small>
          {#if startup.step && startup.total}<b>{startup.step}/{startup.total}</b>{/if}
          {startup.message}
        </small>
      {/if}
    </div>
  {:else if phase === 'error'}
    <div class="ext-state error" role="alert">
      <strong>{tr('extensions.view.failed', { name: target.extensionName })}</strong>
      <pre>{error}</pre>
      <button class="btn" onclick={retry}>{tr('extensions.view.retry')}</button>
    </div>
  {/if}
</div>

<style>
  .ext-port {
    position: relative;
    width: 100%;
    height: 100%;
    background: var(--bg-base);
  }
  .ext-state {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-3);
    color: var(--fg-secondary);
    font-size: var(--fs-sm);
  }
  .ext-state small {
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
  }
  .ext-state small b {
    margin-right: 4px;
    font-weight: var(--fw-med);
  }
  .ext-state.error pre {
    max-width: min(640px, 90%);
    max-height: 40%;
    overflow: auto;
    margin: 0;
    padding: var(--sp-3);
    border-radius: var(--rad-md);
    background: var(--bg-pre);
    color: var(--fg-secondary);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    white-space: pre-wrap;
  }
  .ext-state.error strong {
    color: var(--st-err);
  }
  .btn {
    padding: var(--sp-1) var(--sp-3);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    background: var(--bg-elevated);
    color: var(--fg-primary);
    cursor: pointer;
  }
  .spinner {
    width: 18px;
    height: 18px;
    border: 2px solid var(--bd-default);
    border-top-color: var(--acc);
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
