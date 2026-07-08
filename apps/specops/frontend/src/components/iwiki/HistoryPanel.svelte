<script lang="ts">
  import Icon from '../shared/Icon.svelte';
  import HistoryCommit from './HistoryCommit.svelte';
  import {
    commits,
    commitsLoading,
    commitsError,
    loadHistory,
    selectCommit,
  } from '../../lib/stores/history.ts';
  import { selectedDoc } from '../../lib/stores/documents.ts';
  import { t } from '../../lib/i18n.ts';

  let loadedPath = $state<string | null>(null);

  $effect(() => {
    const path = $selectedDoc?.path ?? null;
    if (path !== loadedPath) {
      loadedPath = path;
      selectCommit(null);
      if (path !== null) loadHistory(path);
    }
  });
</script>

<div class="history-panel">
  <header class="history-head">
    <span>{t('History')}</span>
    {#if $commitsLoading}
      <Icon name="refresh" size={12} />
    {/if}
  </header>

  {#if !$selectedDoc}
    <p class="empty">{t('Select a document to view history.')}</p>
  {:else if $commitsLoading}
    <p class="empty">Loading…</p>
  {:else if $commitsError}
    <p class="warning">{$commitsError}</p>
  {:else if $commits.length === 0}
    <p class="empty">No commits yet.</p>
  {:else}
    <ol class="commit-list">
      {#each $commits as commit (commit.hash)}
        <li>
          <HistoryCommit {commit} docPath={$selectedDoc.path} />
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .history-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }
  .history-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    /* Match .chat-head / .iwiki-head (44px) so the header lines up with the
       middle column when the panel is open; right padding clears the pinned
       PanelToggle. */
    height: 44px;
    min-height: 44px;
    padding: 0 52px 0 var(--sp-3);
    border-bottom: 1px solid var(--bd-muted);
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
    font-weight: var(--fw-semi);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: color-mix(in srgb, var(--bg-sidebar) 88%, var(--bg-base));
    flex-shrink: 0;
  }
  .empty,
  .warning {
    padding: var(--sp-3);
    color: var(--fg-tertiary);
    font-size: var(--fs-sm);
    margin: 0;
  }
  .warning {
    color: var(--st-warn);
  }
  .commit-list {
    list-style: none;
    margin: 0;
    padding: var(--sp-2);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
</style>
