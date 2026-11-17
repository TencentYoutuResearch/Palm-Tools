import { writable } from 'svelte/store'

/**
 * Count of open floating DOM overlays (dropdowns, popovers) that extension
 * views must make room for. Native child webviews paint above every DOM
 * element, so an open dropdown would otherwise be hidden behind them.
 *
 * Usage inside a component: `$effect(() => { if (open) return holdOverlay() })`.
 */
export const floatingOverlays = writable(0)

export function holdOverlay(): () => void {
  floatingOverlays.update((n) => n + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    floatingOverlays.update((n) => Math.max(0, n - 1))
  }
}
