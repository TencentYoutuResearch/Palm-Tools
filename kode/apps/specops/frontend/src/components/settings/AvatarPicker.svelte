<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { avatarLibrary, loadAvatarLibrary } from '../../lib/avatarLibrary.ts';
  import AvatarSprite from '../shared/AvatarSprite.svelte';
  import Icon from '../shared/Icon.svelte';

  interface Props {
    backendKey: string;
    currentAvatarId: string | null;
    onPick: (avatarId: string | null) => void;
    onClose: () => void;
  }
  let { backendKey, currentAvatarId, onPick, onClose }: Props = $props();
  let frameIndices = $state<Record<string, number>>({});
  let timer: number | null = null;

  onMount(() => {
    void loadAvatarLibrary(true);
    timer = window.setInterval(() => {
      const next: Record<string, number> = {};
      for (const set of $avatarLibrary.gallery) next[set.name] = ((frameIndices[set.name] ?? 0) + 1) % set.frames.length;
      frameIndices = next;
    }, 180);
  });
  onDestroy(() => { if (timer !== null) window.clearInterval(timer); });
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape') onClose(); }} />
<div class="backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
  <div class="picker" role="dialog" aria-label="Choose avatar" tabindex="-1">
    <header><strong>Choose avatar</strong><button type="button" onclick={onClose} aria-label="Close"><Icon name="x" size={14} /></button></header>
    <div class="grid">
      <button type="button" class:selected={currentAvatarId === null} onclick={() => onPick(null)}>
        <span class="cell-avatar default"><AvatarSprite {backendKey} avatarId={null} status="idle" size={40} /></span>
        <span>default</span>
        {#if currentAvatarId === null}<i><Icon name="check" size={10} /></i>{/if}
      </button>
      {#each $avatarLibrary.gallery as set (set.name)}
        <button type="button" class:selected={currentAvatarId === set.name} onclick={() => onPick(set.name)} title={set.name}>
          <span class="cell-avatar"><img src={set.frames[frameIndices[set.name] ?? 0]} alt="" draggable="false" /></span>
          <span>{set.name.replace(/^gallery\//, '')}</span>
          {#if currentAvatarId === set.name}<i><Icon name="check" size={10} /></i>{/if}
        </button>
      {/each}
    </div>
    {#if $avatarLibrary.gallery.length === 0}<p>No gallery avatars found. Add them to the kode avatar library.</p>{/if}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 1200; display: grid; place-items: center; padding: 24px; background: color-mix(in srgb, #000 28%, transparent); }
  .picker { width: min(360px, 100%); max-height: min(520px, calc(100vh - 48px)); display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; border: 1px solid var(--bd-default); border-radius: var(--rad-lg); background: var(--bg-elevated); box-shadow: var(--sh-lg); }
  header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--bd-muted); color: var(--fg-secondary); font-size: var(--fs-sm); }
  header button { width: 24px; height: 24px; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--rad-md); background: transparent; color: var(--fg-tertiary); }
  .grid { min-height: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 10px; overflow-y: auto; }
  .grid > button { position: relative; min-width: 0; display: grid; justify-items: center; gap: 5px; padding: 7px 4px; border: 1px solid transparent; border-radius: var(--rad-md); background: transparent; color: var(--fg-tertiary); font-family: var(--font-mono); font-size: 9px; }
  .grid > button:hover { background: var(--bg-tab-hover); }
  .grid > button.selected { border-color: var(--acc); background: color-mix(in srgb, var(--acc) 10%, transparent); color: var(--acc); }
  .cell-avatar { width: 42px; height: 42px; display: grid; place-items: center; overflow: hidden; border: 1px solid var(--bd-muted); border-radius: 9px; background: var(--bg-base); }
  .cell-avatar.default { border-radius: 50%; }
  .cell-avatar img { width: 100%; height: 100%; object-fit: cover; }
  i { position: absolute; top: 3px; right: 3px; width: 15px; height: 15px; display: grid; place-items: center; border-radius: 50%; background: var(--acc); color: var(--fg-on-accent); }
  p { margin: 0; padding: 12px; border-top: 1px solid var(--bd-muted); color: var(--fg-tertiary); font-size: var(--fs-xs); }
</style>
