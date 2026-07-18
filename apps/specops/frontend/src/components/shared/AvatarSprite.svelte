<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { avatarLibrary, loadAvatarLibrary, type AvatarStatus } from '../../lib/avatarLibrary.ts';
  import BackendIcon from './BackendIcon.svelte';

  interface Props {
    avatarId?: string | null;
    backendKey?: string;
    status?: AvatarStatus;
    size?: number;
    label?: string;
  }
  let { avatarId = null, backendKey = '', status = 'idle', size = 30, label = 'Agent avatar' }: Props = $props();
  let frameIndex = $state(0);
  let foldIndex = $state(0);
  let timer: number | null = null;
  let matchingSets = $derived(avatarId ? ($avatarLibrary[status] ?? []).filter((set) => set.name === avatarId || set.name.startsWith(`${status}/`)) : []);
  let gallerySet = $derived(avatarId ? ($avatarLibrary.gallery ?? []).find((set) => set.name === avatarId) ?? null : null);
  let activeSet = $derived(matchingSets[foldIndex] ?? gallerySet);

  onMount(() => {
    void loadAvatarLibrary();
    timer = window.setInterval(() => {
      if (!activeSet) return;
      if (frameIndex === activeSet.frames.length - 1 && matchingSets.length > 1) {
        let next = foldIndex;
        while (next === foldIndex) next = Math.floor(Math.random() * matchingSets.length);
        foldIndex = next;
      }
      frameIndex = (frameIndex + 1) % activeSet.frames.length;
    }, 180);
  });
  onDestroy(() => { if (timer !== null) window.clearInterval(timer); });
  $effect(() => { void activeSet; frameIndex = 0; });
  $effect(() => { if (matchingSets.length > 0) foldIndex = Math.floor(Math.random() * matchingSets.length); });
</script>

<span class="avatar-shell" style={`--avatar-size:${size}px`} aria-label={label}>
  {#if activeSet?.frames[frameIndex]}
    <img src={activeSet.frames[frameIndex]} alt="" draggable="false" />
  {:else}
    <BackendIcon {backendKey} size={Math.max(20, size - 4)} />
  {/if}
</span>

<style>
  .avatar-shell { width: var(--avatar-size); height: var(--avatar-size); display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; overflow: hidden; border-radius: 8px; background: color-mix(in srgb, var(--bg-elevated) 74%, transparent); }
  img { width: 100%; height: 100%; display: block; object-fit: cover; }
</style>
