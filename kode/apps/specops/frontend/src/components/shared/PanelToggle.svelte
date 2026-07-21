<script lang="ts">
  import Icon from './Icon.svelte';

  interface Props {
    open: boolean;
    label: string;
    side: 'left' | 'right';
    onclick: () => void;
  }
  let { open, label, side, onclick }: Props = $props();
</script>

<button
  type="button"
  class="panel-toggle toggle-{side}"
  class:active={open}
  onclick={onclick}
  aria-label={label}
  aria-pressed={open}
  title={label}
>
  {#if side === 'right'}
    <Icon name={open ? 'chevron-right' : 'chevron-left'} size={15} />
  {:else}
    <Icon name={open ? 'chevron-left' : 'chevron-right'} size={15} />
  {/if}
</button>

<style>
  /* kode-gui-style: fixed at the app's top-right corner, mirroring the GUI's
     titlebar-tool. 28x28, borderless, transparent until hovered/active. It is
     fixed instead of grid-absolute so the right panel cannot paint over it. */
  .panel-toggle {
    position: fixed;
    top: 8px;
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: var(--rad-md);
    background: transparent;
    color: var(--fg-secondary);
    cursor: pointer;
    z-index: 100;
    -webkit-app-region: no-drag;
    pointer-events: auto;
    transition:
      background var(--t-fast),
      border-color var(--t-fast),
      color var(--t-fast);
  }
  .panel-toggle:hover {
    background: var(--bg-hover);
    border-color: var(--bd-default);
    color: var(--fg-primary);
  }
  .panel-toggle.active {
    background: color-mix(in srgb, var(--bg-elevated) 78%, var(--acc));
    border-color: color-mix(in srgb, var(--acc) 36%, var(--bd-default));
    color: var(--acc);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--bg-base) 70%, transparent);
  }
  .panel-toggle.active:hover {
    background: color-mix(in srgb, var(--bg-elevated) 70%, var(--acc));
  }
  /* Anchored to the module's right edge so the button stays in the same place
     whether the right panel is open or closed. */
  .toggle-right {
    right: 12px;
  }
  .toggle-left {
    left: 12px;
  }
</style>
