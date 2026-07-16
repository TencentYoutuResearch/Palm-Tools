<script lang="ts">
  import { writable } from 'svelte/store';

  interface Props {
    store: ReturnType<typeof writable<number>>;
    min: number;
    max: number;
    side: 'left' | 'right';
  }
  let { store, min, max, side }: Props = $props();

  let dragging = $state(false);
  let startX = 0;
  let startW = 0;

  function onPointerDown(e: PointerEvent) {
    dragging = true;
    startX = e.clientX;
    store.subscribe((v) => (startW = v))();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const next = Math.min(max, Math.max(min, startW + (side === 'left' ? delta : -delta)));
    store.set(next);
  }
  function onPointerUp(e: PointerEvent) {
    dragging = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }
</script>

<div
  class="resizer {side}"
  class:dragging
  role="button"
  tabindex="0"
  aria-label="resize column"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
></div>

<style>
  .resizer {
    position: absolute;
    top: var(--header-height, 44px);
    bottom: 0;
    width: 6px;
    cursor: col-resize;
    background: transparent;
    z-index: 4;
    transition: background var(--t-fast);
  }
  .resizer.left {
    left: var(--col-left, 260px);
    transform: translateX(-3px);
  }
  .resizer.right {
    right: var(--col-right, 0px);
    transform: translateX(3px);
  }
  .resizer::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 2px;
    height: 28px;
    border-radius: 999px;
    background: var(--bd-default);
    transition:
      background var(--t-fast),
      height var(--t-base),
      width var(--t-base);
  }
  .resizer:hover::after,
  .resizer.dragging::after {
    background: var(--acc);
    height: 40px;
    width: 3px;
    box-shadow: 0 0 12px color-mix(in srgb, var(--acc) 40%, transparent);
  }
  .resizer:active::after {
    height: 52px;
  }
</style>
