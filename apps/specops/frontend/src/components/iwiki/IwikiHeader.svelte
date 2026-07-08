<script lang="ts">
  import StatusBadge from '../shared/StatusBadge.svelte';
  import { selectedDoc } from '../../lib/stores/documents.ts';
  import { onWindowDragMouseDown } from '../../lib/windowDrag.ts';
</script>

<header class="iwiki-head" role="presentation" data-tauri-drag-region onmousedown={onWindowDragMouseDown}>
  <div class="title-wrap" data-tauri-drag-region>
    {#if $selectedDoc}
      <h2>{$selectedDoc.title}</h2>
      <span class="meta">{$selectedDoc.id}</span>
    {:else}
      <h2>No document selected</h2>
      <span class="meta">Choose a document from the tree</span>
    {/if}
  </div>
  <div class="head-right" data-tauri-drag-region>
    {#if $selectedDoc}
      <StatusBadge label={$selectedDoc.status} tone={$selectedDoc.status} />
    {/if}
  </div>
</header>

<style>
  .iwiki-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    /* Leave room on the right for the absolutely-positioned PanelToggle. */
    padding: 0 52px 0 var(--sp-4);
    border-bottom: 1px solid var(--bd-muted);
    background: color-mix(in srgb, var(--bg-base) 92%, var(--bg-sidebar));
    flex-shrink: 0;
    min-height: 44px;
    height: 44px;
    -webkit-app-region: drag;
    user-select: none;
    -webkit-user-select: none;
  }
  .title-wrap {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    pointer-events: none;
    -webkit-app-region: drag;
  }
  h2 {
    margin: 0;
    font-size: var(--fs-md);
    line-height: 1.2;
    font-weight: var(--fw-semi);
    color: var(--fg-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .head-right {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    pointer-events: none;
    -webkit-app-region: drag;
  }
</style>
