<script lang="ts">
  import Icon from '../shared/Icon.svelte';
  import StatusBadge from '../shared/StatusBadge.svelte';
  import { parseToolPreview } from '../../lib/toolPreview.ts';
  import type { TranscriptEntry } from '../../lib/types.ts';

  interface Props {
    entry: TranscriptEntry;
  }
  let { entry }: Props = $props();

  let expanded = $state(false);
  const parsed = $derived(parseToolPreview(entry.preview ?? ''));
  const kind = $derived(entry.kind);
  const tool = $derived(entry.tool ?? 'tool');
  const summary = $derived(entry.summary ?? entry.text ?? '');
  const status = $derived(entry.status ?? 'running');
</script>

<div class="toolcard">
  <button type="button" class="head" onclick={() => (expanded = !expanded)}>
    <span class="status-dot" data-status={status}></span>
    <span class="tool-name">{tool}</span>
    <span class="summary">{summary}</span>
    <StatusBadge label={status} tone={status === 'error' ? 'error' : status === 'ok' ? 'completed' : 'busy'} />
    <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
  </button>
  {#if expanded}
    <div class="body">
      {#if kind === 'tool_result'}
        {#if parsed.kind === 'json'}
          <pre class="preview json">{JSON.stringify(parsed.value, null, 2)}</pre>
        {:else if parsed.kind === 'kv'}
          <pre class="preview kv">{#each parsed.lines as line (line.raw ?? line.key)}{#if line.raw}{line.raw}{:else}{line.indent}{line.key}: {line.value}{/if}
{/each}</pre>
        {:else}
          <pre class="preview text">{parsed.value}</pre>
        {/if}
      {:else}
        <p class="muted">tool call (no preview yet)</p>
        {#if entry.tool_call_id}
          <p class="muted mono">call_id: {entry.tool_call_id}</p>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .toolcard {
    margin: var(--sp-1) var(--sp-4);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
    background: var(--bg-elevated);
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    background: transparent;
    text-align: left;
    border: none;
    font-size: var(--fs-sm);
    color: var(--fg-primary);
    transition: background var(--t-fast);
  }
  .head:hover {
    background: var(--bg-tab-hover);
  }
  .body {
    animation: toolcard-expand var(--t-base) cubic-bezier(0.2, 0, 0, 1);
  }
  @keyframes toolcard-expand {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--fg-tertiary);
    flex-shrink: 0;
  }
  .status-dot[data-status='running'] {
    background: var(--st-busy);
    animation: pulse 1.4s ease-in-out infinite;
  }
  .status-dot[data-status='ok'] {
    background: var(--st-idle);
  }
  .status-dot[data-status='error'] {
    background: var(--st-err);
  }
  .tool-name {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--st-info);
    flex-shrink: 0;
  }
  .summary {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-secondary);
    font-size: var(--fs-sm);
  }
  .body {
    padding: var(--sp-2) var(--sp-3);
    border-top: 1px solid var(--bd-muted);
    background: var(--bg-base);
  }
  .preview {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    background: var(--bg-pre);
    padding: var(--sp-3);
    border-radius: var(--rad-md);
    overflow-x: auto;
    white-space: pre;
    color: var(--fg-secondary);
    max-height: 40vh;
    overflow-y: auto;
  }
  .muted {
    color: var(--fg-tertiary);
    font-size: var(--fs-sm);
    margin: var(--sp-1) 0;
  }
  .mono {
    font-family: var(--font-mono);
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
</style>
