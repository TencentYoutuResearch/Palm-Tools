<script lang="ts">
  import { backendIconProfile } from './backend_icons'

  type Props = {
    backendKey: string
    command?: string | null
    size?: number
    muted?: boolean
  }

  let { backendKey, command = null, size = 18, muted = false }: Props = $props()
  let profile = $derived(backendIconProfile(backendKey, command))
  let style = $derived(`width:${size}px;height:${size}px;--backend-icon-tint:${profile.tint ?? 'currentColor'}`)
</script>

<span class="backend-icon" class:muted style={style} aria-hidden="true">
  {#if profile.asset}
    {#if profile.monochrome}
      <span
        class="mask"
        style={`mask-image:url('/backend-icons/${profile.asset}.png');-webkit-mask-image:url('/backend-icons/${profile.asset}.png')`}
      ></span>
    {:else}
      <img src={`/backend-icons/${profile.asset}.png`} alt="" loading="lazy" decoding="async" />
    {/if}
  {:else}
    <span class="fallback">{profile.fallback}</span>
  {/if}
</span>

<style>
  .backend-icon {
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    color: var(--backend-icon-tint);
  }

  .backend-icon.muted {
    opacity: 0.52;
    filter: grayscale(0.35);
  }

  img,
  .mask {
    width: 100%;
    height: 100%;
    display: block;
  }

  img {
    object-fit: contain;
  }

  .mask {
    background: currentColor;
    mask-repeat: no-repeat;
    mask-position: center;
    mask-size: contain;
    -webkit-mask-repeat: no-repeat;
    -webkit-mask-position: center;
    -webkit-mask-size: contain;
  }

  .fallback {
    width: 100%;
    height: 100%;
    border-radius: 5px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--fg-secondary) 12%, transparent);
    color: var(--fg-secondary);
    font-size: 9px;
    font-weight: var(--fw-bold);
    line-height: 1;
    font-family: var(--font-ui);
  }
</style>
