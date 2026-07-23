<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { avatarLibrary, loadAvatarLibrary } from './avatars'
  import BackendIcon from './BackendIcon.svelte'
  import Icon from './Icon.svelte'
  import { outsidePressClose } from './outside_close'

  type Props = {
    /** 当前 tab 的 backend key,用于 Default 格的 PNG 预览 */
    backendKey: string
    /** 当前选定的 avatar id;null = 用 backend fallback */
    currentAvatarId: string | null
    /** 触发头像的视口位置,用于定位 popover */
    anchorRect: DOMRect
    onPick: (id: string | null) => void
    onGenerate: () => void
    onClose: () => void
  }

  let {
    backendKey,
    currentAvatarId,
    anchorRect,
    onPick,
    onGenerate,
    onClose,
  }: Props = $props()

  // gallery sets(每格独立动画)
  let gallerySets = $derived($avatarLibrary.gallery ?? [])

  // 每个格子的当前帧索引(以 set.name 为 key)
  let frameIndices = $state<Record<string, number>>({})
  let timer: number | null = null

  function tick() {
    const next: Record<string, number> = {}
    for (const set of gallerySets) {
      const cur = frameIndices[set.name] ?? 0
      next[set.name] = (cur + 1) % 4
    }
    frameIndices = next
  }

  onMount(() => {
    loadAvatarLibrary(true)
    // 初始化每个 set 在 frame 0
    const init: Record<string, number> = {}
    for (const set of gallerySets) init[set.name] = 0
    frameIndices = init
    timer = window.setInterval(tick, 180)
  })

  onDestroy(() => {
    if (timer != null) window.clearInterval(timer)
  })

  // popover 定位:挂在 anchor 右下方,边界溢出时翻转
  let popoverStyle = $derived(computePopoverStyle(anchorRect))

  function computePopoverStyle(rect: DOMRect): string {
    const POPOVER_W = 248
    const POPOVER_MAX_H = 360
    const GAP = 8
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 横向:默认贴 anchor 左对齐,右边溢出则右对齐 anchor
    let left = rect.left
    if (left + POPOVER_W > vw - 8) {
      left = Math.max(8, rect.right - POPOVER_W)
    }
    // 纵向:默认 anchor 下方;溢出则上方
    let top = rect.bottom + GAP
    if (top + POPOVER_MAX_H > vh - 8) {
      top = Math.max(8, rect.top - POPOVER_MAX_H - GAP)
    }
    return `left:${left}px;top:${top}px;width:${POPOVER_W}px;max-height:${POPOVER_MAX_H}px`
  }

  function pick(id: string | null) {
    onPick(id)
  }

  // Esc 关闭
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  function isCurrent(id: string | null): boolean {
    if (id == null) return currentAvatarId == null
    return currentAvatarId === id
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" use:outsidePressClose={{ onClose }} role="presentation">
  <div
    class="popover"
    style={popoverStyle}
    role="dialog"
    aria-label="Choose avatar"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    <header class="picker-head">
      <span>Choose avatar</span>
      <button class="close-btn" onclick={onClose} aria-label="Close">
        <Icon name="x" size={14} />
      </button>
    </header>
    <div class="grid">
      <!-- Default 格:backend icon -->
      <button
        class="cell default-cell"
        class:selected={isCurrent(null)}
        onclick={() => pick(null)}
        title="Default (backend icon)"
      >
        <span class="cell-avatar default-avatar">
          <BackendIcon {backendKey} size={28} />
        </span>
        <span class="cell-label">default</span>
        {#if isCurrent(null)}
          <span class="check"><Icon name="check" size={10} /></span>
        {/if}
      </button>
      <button
        class="cell generate-cell"
        onclick={onGenerate}
        title="Create a custom avatar"
        aria-label="Create a custom avatar"
      >
        <span class="cell-avatar generate-avatar" aria-hidden="true">+</span>
        <span class="cell-label">create</span>
      </button>
      <!-- gallery sets -->
      {#each gallerySets as set, i (set.name)}
        <button
          class="cell"
          class:selected={isCurrent(set.name)}
          onclick={() => pick(set.name)}
          title={set.name}
        >
          <span class="cell-avatar">
            <img src={set.frames[frameIndices[set.name] ?? 0]} alt={set.name} draggable="false" />
          </span>
          <span class="cell-label">{set.name}</span>
          {#if isCurrent(set.name)}
            <span class="check"><Icon name="check" size={10} /></span>
          {/if}
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1100;
    background: transparent;
  }
  .popover {
    position: fixed;
    z-index: 1101;
    display: flex;
    flex-direction: column;
    background: var(--bg-elevated);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-lg);
    box-shadow: var(--sh-lg);
    overflow: hidden;
    user-select: none;
  }
  .picker-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    font-size: var(--fs-sm);
    color: var(--fg-secondary);
    border-bottom: 1px solid color-mix(in srgb, var(--bd-default) 50%, transparent);
    font-weight: var(--fw-med);
  }
  .close-btn {
    background: transparent;
    border: none;
    color: var(--fg-tertiary);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: var(--rad-md);
    padding: 0;
  }
  .close-btn:hover {
    background: color-mix(in srgb, var(--fg-primary) 8%, transparent);
    color: var(--fg-primary);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    padding: 8px;
    overflow-y: auto;
    max-height: 320px;
  }

  .cell {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px 4px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--rad-md);
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast);
  }
  .cell:hover {
    background: var(--bg-tab-hover);
  }
  .cell.selected {
    border-color: var(--acc);
    background: color-mix(in srgb, var(--acc) 10%, transparent);
  }

  .cell-avatar {
    width: 40px;
    height: 40px;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--bg-base) 80%, transparent);
    border: 1px solid color-mix(in srgb, var(--bd-default) 60%, transparent);
  }
  .default-avatar {
    border-radius: 50%;
  }
  .generate-avatar {
    color: var(--acc);
    border-style: dashed;
    border-color: color-mix(in srgb, var(--acc) 55%, var(--bd-default));
    font-family: var(--font-mono);
    font-size: 26px;
    font-weight: 300;
    line-height: 1;
  }
  .generate-cell:hover .generate-avatar {
    background: color-mix(in srgb, var(--acc) 10%, var(--bg-base));
    border-color: var(--acc);
  }
  .cell-avatar img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .cell-label {
    font-size: 9.5px;
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    line-height: 1;
  }
  .cell.selected .cell-label {
    color: var(--acc);
    font-weight: var(--fw-med);
  }

  .check {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--acc);
    color: var(--bg-elevated);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--bg-elevated);
  }

  @media (prefers-reduced-motion: reduce) {
    .cell-avatar img {
      animation: none !important;
    }
  }
</style>
