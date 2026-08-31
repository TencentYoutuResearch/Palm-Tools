<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { t } from './i18n'

  export type ScreenshotDraft = { pngBase64: string; width: number; height: number }
  export type ScreenshotCrop = { x: number; y: number; width: number; height: number }
  type Handle = 'new' | 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'
  type Props = {
    draft: ScreenshotDraft
    busy?: boolean
    onConfirm: (crop: ScreenshotCrop) => void
    onClose: () => void
  }

  let { draft, busy = false, onConfirm, onClose }: Props = $props()
  let stage: HTMLDivElement
  let dialog: HTMLDivElement
  let selection: HTMLDivElement
  let x = $state(untrack(() => Math.round(draft.width * 0.15)))
  let y = $state(untrack(() => Math.round(draft.height * 0.15)))
  let width = $state(untrack(() => Math.round(draft.width * 0.7)))
  let height = $state(untrack(() => Math.round(draft.height * 0.7)))
  let drag: { handle: Handle; startX: number; startY: number; x: number; y: number; width: number; height: number } | null = $state(null)
  const minSize = 12

  const left = $derived(`${(x / draft.width) * 100}%`)
  const top = $derived(`${(y / draft.height) * 100}%`)
  const selectionWidth = $derived(`${(width / draft.width) * 100}%`)
  const selectionHeight = $derived(`${(height / draft.height) * 100}%`)

  onMount(() => selection?.focus())

  function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value))
  }

  function beginDrag(event: PointerEvent, handle: Handle) {
    if (busy || event.button !== 0) return
    event.preventDefault()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    drag = { handle, startX: event.clientX, startY: event.clientY, x, y, width, height }
  }

  function beginNewSelection(event: PointerEvent) {
    if (busy || event.button !== 0 || event.target !== event.currentTarget) return
    event.preventDefault()
    const bounds = stage.getBoundingClientRect()
    const startX = clamp(((event.clientX - bounds.left) / bounds.width) * draft.width, 0, draft.width)
    const startY = clamp(((event.clientY - bounds.top) / bounds.height) * draft.height, 0, draft.height)
    x = Math.round(clamp(startX, 0, draft.width - minSize))
    y = Math.round(clamp(startY, 0, draft.height - minSize))
    width = minSize
    height = minSize
    stage.setPointerCapture(event.pointerId)
    drag = { handle: 'new', startX: event.clientX, startY: event.clientY, x: startX, y: startY, width: 0, height: 0 }
  }

  function updateDrag(event: PointerEvent) {
    if (!drag) return
    const bounds = stage.getBoundingClientRect()
    const dx = ((event.clientX - drag.startX) / bounds.width) * draft.width
    const dy = ((event.clientY - drag.startY) / bounds.height) * draft.height
    if (drag.handle === 'new') {
      const currentX = clamp(drag.x + dx, 0, draft.width)
      const currentY = clamp(drag.y + dy, 0, draft.height)
      const leftEdge = Math.min(drag.x, currentX)
      const topEdge = Math.min(drag.y, currentY)
      const rightEdge = Math.max(drag.x, currentX)
      const bottomEdge = Math.max(drag.y, currentY)
      x = Math.round(clamp(leftEdge, 0, draft.width - minSize))
      y = Math.round(clamp(topEdge, 0, draft.height - minSize))
      width = Math.round(clamp(rightEdge - leftEdge, minSize, draft.width - x))
      height = Math.round(clamp(bottomEdge - topEdge, minSize, draft.height - y))
      return
    }
    let leftEdge = drag.x
    let topEdge = drag.y
    let rightEdge = drag.x + drag.width
    let bottomEdge = drag.y + drag.height
    if (drag.handle === 'move') {
      x = Math.round(clamp(drag.x + dx, 0, draft.width - drag.width))
      y = Math.round(clamp(drag.y + dy, 0, draft.height - drag.height))
      return
    }
    if (drag.handle.includes('w')) leftEdge = clamp(drag.x + dx, 0, rightEdge - minSize)
    if (drag.handle.includes('e')) rightEdge = clamp(drag.x + drag.width + dx, leftEdge + minSize, draft.width)
    if (drag.handle.includes('n')) topEdge = clamp(drag.y + dy, 0, bottomEdge - minSize)
    if (drag.handle.includes('s')) bottomEdge = clamp(drag.y + drag.height + dy, topEdge + minSize, draft.height)
    x = Math.round(leftEdge)
    y = Math.round(topEdge)
    width = Math.round(rightEdge - leftEdge)
    height = Math.round(bottomEdge - topEdge)
  }

  function endDrag() {
    drag = null
  }

  function nudge(event: KeyboardEvent, handle: Handle) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const amount = event.shiftKey ? 10 : 1
    const dx = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0
    const dy = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0
    const synthetic = { handle, startX: 0, startY: 0, x, y, width, height }
    drag = synthetic
    const bounds = stage.getBoundingClientRect()
    updateDrag({ clientX: (dx / draft.width) * bounds.width, clientY: (dy / draft.height) * bounds.height } as PointerEvent)
    drag = null
  }

  function onDialogKey(event: KeyboardEvent) {
    event.stopPropagation()
    if (event.key === 'Escape' && !busy) {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')]
    if (!focusable.length) return
    const current = focusable.indexOf(document.activeElement as HTMLElement)
    const next = event.shiftKey
      ? (current <= 0 ? focusable.length - 1 : current - 1)
      : (current === focusable.length - 1 ? 0 : current + 1)
    if (current === -1 || next !== current + (event.shiftKey ? -1 : 1)) {
      event.preventDefault()
      focusable[next]?.focus()
    }
  }

  const handles: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
</script>

<div class="backdrop" role="presentation">
  <div class="dialog" bind:this={dialog} role="dialog" aria-modal="true" aria-labelledby="screenshot-editor-title" tabindex="-1" onkeydown={onDialogKey}>
    <header>
      <div>
        <h2 id="screenshot-editor-title">{t('settings.capture.editorTitle')}</h2>
        <p>{t('settings.capture.editorHint')}</p>
      </div>
      <span class="dimensions">{width} × {height}</span>
    </header>

    <div class="canvas-wrap">
      <div
        class="stage"
        bind:this={stage}
        role="group"
        aria-label={t('settings.capture.previewAlt')}
        onpointerdown={beginNewSelection}
        onpointermove={updateDrag}
        onpointerup={endDrag}
        onpointercancel={endDrag}
      >
        <img src={`data:image/png;base64,${draft.pngBase64}`} alt={t('settings.capture.previewAlt')} draggable="false" />
        <div
          class="selection"
          class:dragging={drag !== null}
          bind:this={selection}
          style:left style:top style:width={selectionWidth} style:height={selectionHeight}
          role="button"
          tabindex="0"
          aria-label={t('settings.capture.moveSelection')}
          onpointerdown={(event) => beginDrag(event, 'move')}
          onpointermove={updateDrag}
          onpointerup={endDrag}
          onpointercancel={endDrag}
          onkeydown={(event) => nudge(event, 'move')}
        >
          {#each handles as handle}
            <button
              type="button"
              class="handle {handle}"
              aria-label={t(`settings.capture.handle.${handle}`)}
              onclick={(event) => (event.currentTarget as HTMLButtonElement).focus()}
              onpointerdown={(event) => { event.stopPropagation(); beginDrag(event, handle) }}
              onpointermove={updateDrag}
              onpointerup={endDrag}
              onpointercancel={endDrag}
              onkeydown={(event) => nudge(event, handle)}
            ></button>
          {/each}
        </div>
      </div>
    </div>

    <footer>
      <span>{t('settings.capture.keyboardHint')}</span>
      <div class="actions">
        <button type="button" class="secondary" disabled={busy} onclick={onClose}>{t('settings.capture.cancel')}</button>
        <button type="button" class="primary" disabled={busy} aria-busy={busy} onclick={() => onConfirm({ x, y, width, height })}>
          {busy ? t('settings.capture.copying') : t('settings.capture.confirmCopy')}
        </button>
      </div>
    </footer>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 1200; display: grid; place-items: center; padding: 0; background: var(--bg-modal-backdrop); }
  .dialog { position: relative; width: 100%; height: 100%; max-height: none; overflow: hidden; color: var(--fg-primary); background: #000; border: 0; border-radius: 0; }
  header, footer { position: absolute; z-index: 3; display: flex; align-items: center; gap: 16px; padding: 10px 12px; border: 1px solid var(--bd-default); border-radius: var(--rad-lg); background: color-mix(in srgb, var(--bg-elevated) 92%, transparent); box-shadow: var(--sh-popover); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
  header { top: 12px; left: 50%; width: min(620px, calc(100% - 24px)); justify-content: space-between; transform: translateX(-50%); }
  h2 { margin: 0; font-size: var(--fs-md); }
  p { margin: 3px 0 0; color: var(--fg-secondary); font-size: var(--fs-xs); }
  .dimensions { color: var(--fg-secondary); font: 12px var(--font-mono); }
  .canvas-wrap, .stage { position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
  .stage { user-select: none; touch-action: none; }
  img { display: block; width: 100%; height: 100%; object-fit: fill; image-rendering: auto; pointer-events: none; }
  .selection { position: absolute; box-sizing: border-box; border: 2px solid var(--acc); box-shadow: 0 0 0 9999px rgba(0, 0, 0, .58); cursor: move; outline: none; }
  .selection:focus-visible { box-shadow: 0 0 0 9999px rgba(0, 0, 0, .58), 0 0 0 3px color-mix(in srgb, var(--acc) 42%, transparent); }
  .selection.dragging { cursor: grabbing; }
  .handle { position: absolute; width: 14px; height: 14px; padding: 0; border: 2px solid var(--bg-elevated); border-radius: 3px; background: var(--acc); transform: translate(-50%, -50%); cursor: pointer; }
  .handle:focus-visible { outline: 2px solid var(--fg-primary); outline-offset: 2px; }
  .nw { left: 0; top: 0; cursor: nwse-resize; } .n { left: 50%; top: 0; cursor: ns-resize; } .ne { left: 100%; top: 0; cursor: nesw-resize; }
  .e { left: 100%; top: 50%; cursor: ew-resize; } .se { left: 100%; top: 100%; cursor: nwse-resize; } .s { left: 50%; top: 100%; cursor: ns-resize; }
  .sw { left: 0; top: 100%; cursor: nesw-resize; } .w { left: 0; top: 50%; cursor: ew-resize; }
  footer { right: 12px; bottom: 12px; color: var(--fg-tertiary); font-size: var(--fs-xs); }
  .actions { display: flex; gap: var(--sp-2); }
  footer button { min-width: 82px; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--bd-default); border-radius: var(--rad-md); color: var(--fg-primary); background: var(--bg-input); font: inherit; cursor: pointer; }
  footer button:hover:not(:disabled) { background: var(--bg-tab-hover); } footer button:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; }
  footer button:disabled { opacity: .55; cursor: default; }
  footer .primary { border-color: var(--acc); color: var(--fg-on-accent); background: var(--acc); font-weight: var(--fw-med); }
  @media (max-width: 620px) { .backdrop { padding: 0; } .dialog { width: 100%; max-height: 100vh; height: 100vh; border-radius: 0; } header { top: 8px; width: calc(100% - 16px); } footer { right: 8px; bottom: 8px; left: 8px; align-items: stretch; flex-direction: column; } .actions button { flex: 1; } }
  @media (prefers-reduced-motion: reduce) { .dialog { animation: none; } }
  @media (forced-colors: active) { .selection { border-color: Highlight; box-shadow: 0 0 0 9999px Canvas; } .handle { background: Highlight; border-color: Canvas; } }
</style>
