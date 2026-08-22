<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { avatarLibrary, loadAvatarLibrary, type AvatarStatus } from './avatars'
  import BackendIcon from './BackendIcon.svelte'

  type Props = {
    label?: string
    compact?: boolean
    status?: AvatarStatus
    /** 用户选定的 gallery avatar id;null/缺失 = 用 backend icon 作 fallback */
    avatarId?: string | null
    /** avatarId 为 null 时,用此 backend 的 PNG 作 fallback 头像 */
    backendKey?: string
  }

  let {
    label = 'tab avatar',
    compact = false,
    status = 'running',
    avatarId = null,
    backendKey = '',
  }: Props = $props()
  let frameIndex = $state(0)
  let timer: number | null = null

  // 当前 status 下可用的 fold set，包含两部分:
  // 1) 匹配 avatarId 的 gallery 专用 sets("gallery/panda/running/"→name"gallery/panda")
  // 2) 共享的通用 status sets("running/01"、"running/02")
  // 排除其他 gallery 的 status sets(如"gallery/fox"不属于当前 avatar)
  let allSets = $derived(
    avatarId
      ? ($avatarLibrary[status] ?? []).filter((s) =>
          s.name.startsWith(avatarId) || s.name.startsWith(status + '/'))
      : [],
  )

  // gallery fallback
  let gallerySet = $derived(
    avatarId
      ? ($avatarLibrary.gallery ?? []).find((s) => s.name.startsWith(avatarId)) ?? null
      : null,
  )

  // 当前选中的 fold 下标
  let foldIdx = $state(0)
  // allSets 变化时(如 status 切换 idle→running / library 加载),自动随机选一个有效 fold
  $effect(() => {
    const len = allSets.length
    if (len > 0) foldIdx = Math.floor(Math.random() * len)
  })
  let statusSet = $derived(allSets[foldIdx] ?? null)
  let activeSet = $derived(statusSet ?? gallerySet ?? null)
  function tick() {
    if (!activeSet) return
    // 每播完一组 4 帧 → 切到另一个随机 fold
    if (frameIndex === 3 && allSets.length > 1) {
      let next: number
      do { next = Math.floor(Math.random() * allSets.length) }
      while (next === foldIdx && allSets.length > 1)
      foldIdx = next
    }
    frameIndex = (frameIndex + 1) % activeSet.frames.length
  }

  onMount(() => {
    loadAvatarLibrary()
    timer = window.setInterval(tick, 180)
  })

  onDestroy(() => {
    if (timer != null) window.clearInterval(timer)
  })

  // activeSet 变化时重置帧序号
  $effect(() => {
    void activeSet
    frameIndex = 0
  })

  /// 状态点样式映射
  function dotClass(s: AvatarStatus): string {
    if (s === 'awaiting') return 'dot-attention'
    if (s === 'error') return 'dot-exited'
    return 'dot-busy'
  }
</script>

{#if activeSet && activeSet.frames.length >= 4}
  {@const src = activeSet.frames[frameIndex]}
  {#if src}
    <span class="avatar-shell" class:compact>
      <span class="avatar gallery" class:compact title={activeSet.name} aria-label={label}>
        <img src={src} alt="" draggable="false" />
      </span>
      {#if status !== 'idle'}
        <span class="fallback-status {dotClass(status)}" aria-label={status}></span>
      {/if}
    </span>
  {/if}
{:else}
  <!-- backend icon fallback -->
  <span class="avatar-shell" class:compact>
    <span class="avatar fallback" class:compact aria-label={label}>
      <span class="fallback-icon-wrap">
        <BackendIcon {backendKey} size={compact ? 38 : 26} />
      </span>
    </span>
    {#if status !== 'idle'}
      <span class="fallback-status {dotClass(status)}" aria-label={status}></span>
    {/if}
  </span>
{/if}

<style>
  .avatar {
    width: 34px;
    height: 34px;
    border-radius: 8px;
    overflow: hidden;
    flex: 0 0 auto;
    position: relative;
    background: color-mix(in srgb, var(--bg-elevated) 74%, transparent);
    border: 1px solid color-mix(in srgb, var(--bd-default) 72%, transparent);
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04);
  }
  .avatar.compact {
    width: 44px;
    height: 44px;
    border-radius: 10px;
  }
  .avatar.gallery img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .avatar.fallback {
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .avatar.fallback.compact {
    border-radius: 50%;
  }
  .fallback-icon-wrap {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: 50%;
  }

  .avatar-shell {
    position: relative;
    display: inline-flex;
    flex: 0 0 auto;
  }
  .fallback-status {
    position: absolute;
    right: -3px;
    top: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 2px solid var(--bg-sidebar);
    z-index: 2;
    flex-shrink: 0;
  }
  .avatar-shell.compact .fallback-status {
    width: 7px;
    height: 7px;
    border-width: 1.5px;
    right: -2px;
    top: -2px;
  }
  .dot-starting { background: var(--fg-tertiary); }
  .dot-busy      { background: var(--st-busy); animation: busy-glow 1.4s ease-in-out infinite; }
  .dot-attention {
    background: var(--st-info);
    animation: dot-attention-pulse 1.1s ease-in-out infinite;
  }
  .dot-exited    { background: var(--st-err); opacity: 0.85; }
  @keyframes busy-glow {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--st-busy) 60%, transparent); }
    50% { box-shadow: 0 0 5px 2px color-mix(in srgb, var(--st-busy) 40%, transparent); }
  }
  @keyframes dot-attention-pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.18); }
  }

  @media (prefers-reduced-motion: reduce) {
    .avatar.gallery img,
    .fallback-status {
      animation: none !important;
    }
  }
</style>
