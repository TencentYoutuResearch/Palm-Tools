<script lang="ts">
  import MessageBubble from './MessageBubble.svelte';
  import AgentWorkingBubble from './AgentWorkingBubble.svelte';
  import ToolCard from './ToolCard.svelte';
  import StatusBadge from '../shared/StatusBadge.svelte';
  import { createTranscriptDisplayItems } from '../../lib/transcriptDisplay.ts';
  import type { SessionAgent, TranscriptEntry } from '../../lib/types.ts';

  interface Props {
    agent: SessionAgent | null;
    entries: TranscriptEntry[];
    groupKey: string | null;
    working?: boolean;
  }
  let { agent, entries, groupKey, working = false }: Props = $props();
  const displayItems = $derived(createTranscriptDisplayItems(entries));
  const identityLabel = $derived.by(() => {
    if (agent?.transport === 'legacy_kode_pty' && typeof agent.kode_session_id === 'number') {
      return `#${agent.kode_session_id}`;
    }
    if (agent?.native_session_id) return agent.native_session_id;
    if (agent?.execution_id) return agent.execution_id;
    if (typeof agent?.kode_session_id === 'number') return `#${agent.kode_session_id}`;
    return groupKey?.replace(/^(execution:|legacy-kode:)/, '') ?? '';
  });
</script>

<section class="agent-group">
  {#if agent !== null || groupKey !== null}
    <header class="group-head">
      <span class="purpose">{agent?.purpose ?? 'execution'}</span>
      <span class="dot">·</span>
      <span class="id" title={agent?.execution_id ?? groupKey ?? undefined}>{identityLabel}</span>
      {#if agent !== null}
        <StatusBadge
          label={working ? 'running' : agent.status}
          tone={working ? 'busy' : agent.status === 'failed' ? 'error' : agent.status === 'exited' || agent.status === 'closed' ? 'archived' : 'active'}
        />
      {/if}
    </header>
  {/if}
  <div class="messages">
    {#each displayItems as item (item.key)}
      {#if item.kind === 'tool'}
        <ToolCard entry={item.resultEntry === undefined ? item.entry : { ...item.entry, ...item.resultEntry }} />
      {:else}
        <MessageBubble entry={item.entry} backendKey={agent?.backend_key ?? null} />
      {/if}
    {/each}
    {#if working}
      <AgentWorkingBubble backendKey={agent?.backend_key ?? null} />
    {/if}
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
