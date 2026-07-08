<script lang="ts">
  import MessageBubble from './MessageBubble.svelte';
  import ToolCard from './ToolCard.svelte';
  import StatusBadge from '../shared/StatusBadge.svelte';
  import { createTranscriptDisplayItems } from '../../lib/transcriptDisplay.ts';
  import type { SessionAgent, TranscriptEntry } from '../../lib/types.ts';

  interface Props {
    agent: SessionAgent | null;
    entries: TranscriptEntry[];
  }
  let { agent, entries }: Props = $props();
  const displayItems = $derived(createTranscriptDisplayItems(entries));
</script>

<section class="agent-group">
  {#if agent !== null}
    <header class="group-head">
      <span class="purpose">{agent.purpose}</span>
      <span class="dot">·</span>
      <span class="id">#{agent.kode_session_id}</span>
      <StatusBadge label={agent.status} tone={agent.status === 'exited' ? 'archived' : 'active'} />
    </header>
  {/if}
  <div class="messages">
    {#each displayItems as item (item.key)}
      {#if item.kind === 'tool'}
        <ToolCard entry={item.resultEntry ?? item.entry} />
      {:else}
        <MessageBubble entry={item.entry} backendKey={agent?.backend_key ?? null} />
      {/if}
    {/each}
  </div>
</section>

<style>
  .agent-group {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-4);
    background: color-mix(in srgb, var(--bg-base) 80%, var(--bg-sidebar));
    border-bottom: 1px solid var(--bd-muted);
    font-size: var(--fs-xs);
    color: var(--fg-secondary);
    position: sticky;
    top: 0;
    z-index: 2;
    backdrop-filter: blur(8px);
    /* Slack-like section divider: small caps, subtle. */
    text-transform: uppercase;
    letter-spacing: 0.06em;
    min-height: 28px;
  }
  .purpose {
    text-transform: uppercase;
    font-weight: var(--fw-semi);
    color: var(--fg-tertiary);
  }
  .id {
    font-family: var(--font-mono);
    color: var(--st-info);
  }
  .dot {
    opacity: 0.5;
  }
  .messages {
    padding: var(--sp-2) 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
</style>
