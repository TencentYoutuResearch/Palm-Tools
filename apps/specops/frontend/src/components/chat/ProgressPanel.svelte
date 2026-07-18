<script lang="ts">
  import AgentCoordinationGraph from './AgentCoordinationGraph.svelte';
  import { activeSession } from '../../lib/stores/sessions.ts';
  import { t } from '../../lib/i18n.ts';
  import { onWindowDragMouseDown } from '../../lib/windowDrag.ts';
</script>

<div class="progress-panel">
  <div class="col-title" role="presentation" data-tauri-drag-region onmousedown={onWindowDragMouseDown}>{t('Execution')}</div>

  {#if $activeSession}
    <AgentCoordinationGraph session={$activeSession} />
  {:else}
    <p class="empty">{t('No active session.')}</p>
  {/if}
</div>

<style>
  .progress-panel { height: 100%; overflow-y: auto; user-select: none; -webkit-user-select: none; }
  .empty { margin: 0; padding: var(--sp-3); color: var(--fg-tertiary); font-size: var(--fs-sm); }
</style>
