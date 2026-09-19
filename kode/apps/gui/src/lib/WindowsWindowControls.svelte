<script lang="ts">
  import { onMount } from 'svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'

  let maximized = $state(false)
  const win = getCurrentWindow()
  onMount(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    const refresh = async () => {
      const value = await win.isMaximized()
      if (!disposed) maximized = value
    }
    void refresh().catch(console.error)
    void win.onResized(() => { void refresh().catch(console.error) }).then(fn => {
      if (disposed) fn()
      else unlisten = fn
    }).catch(console.error)
    return () => { disposed = true; unlisten?.() }
  })
</script>

<div class="window-controls no-drag" role="group" aria-label="Window controls">
  <button title="Minimize" aria-label="Minimize" onclick={() => win.minimize().catch(console.error)}>
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6.5h10" /></svg>
  </button>
  <button title={maximized ? 'Restore' : 'Maximize'} aria-label={maximized ? 'Restore' : 'Maximize'} onclick={() => win.toggleMaximize().catch(console.error)}>
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      {#if maximized}<path d="M3.5 3.5v-2h7v7h-2 M1.5 3.5h7v7h-7z" />{:else}<path d="M1.5 1.5h9v9h-9z" />{/if}
    </svg>
  </button>
  <button class="close" title="Close" aria-label="Close window" onclick={() => win.close().catch(console.error)}>
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m1 1 10 10M11 1 1 11" /></svg>
  </button>
</div>

<style>
  .window-controls { position: absolute; top: 0; right: 0; z-index: 110; display: flex; height: 44px; -webkit-app-region: no-drag; }
  button { width: 42px; height: 44px; display: grid; place-items: center; border: 0; border-radius: 0; color: var(--fg-primary); background: transparent; cursor: default; }
  button:hover { background: var(--bg-hover); }
  button:focus-visible { outline: 2px solid var(--acc); outline-offset: -3px; }
  button.close:hover { background: #c42b1c; color: white; }
  svg { fill: none; stroke: currentColor; stroke-width: 1; pointer-events: none; }
</style>
