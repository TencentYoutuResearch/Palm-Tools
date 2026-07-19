<script lang="ts">
  import AgentGroup from './AgentGroup.svelte';
  import { executionGroupKey, type SessionAgent, type TranscriptEntry } from '../../lib/types.ts';
  import { activeSession, activeTranscript } from '../../lib/stores/sessions.ts';

  // Preserve transcript chronology. The same execution may appear in several
  // contiguous sections when user/system entries or another execution occur
  // between its messages; collecting all entries into one execution bucket
  // reorders the conversation and hides tool boundaries.
  let groups = $derived.by(() => {
    const session = $activeSession;
    const transcript = $activeTranscript ?? [];
    const agents = session?.agents ?? [];
    const agentsByKey = new Map<string, SessionAgent>();
    for (const agent of agents) {
      const key = executionGroupKey(agent.execution_id, agent.kode_session_id);
      if (key !== null) agentsByKey.set(key, agent);
    }

    const result: Array<{
      renderKey: string;
      groupKey: string | null;
      agent: SessionAgent | null;
      entries: TranscriptEntry[];
    }> = [];
    for (const entry of transcript) {
      const groupKey = executionGroupKey(entry.execution_id, entry.kode_session_id);
      const previous = result.at(-1);
      if (previous?.groupKey === groupKey) {
        previous.entries.push(entry);
        continue;
      }
      result.push({
        renderKey: `${groupKey ?? 'general'}:${result.length}`,
        groupKey,
        agent: groupKey === null ? null : agentsByKey.get(groupKey) ?? null,
        entries: [entry],
      });
    }
    return result;
  });

  const currentGroupKey = $derived(executionGroupKey($activeSession?.current_execution?.execution_id, null));
  const currentAgent = $derived.by(() => {
    const executionId = $activeSession?.current_execution?.execution_id;
    return executionId === undefined
      ? null
      : $activeSession?.agents?.find((agent) => agent.execution_id === executionId) ?? null;
  });
  const idleStatuses = new Set(['ready', 'idle', 'exited', 'closed', 'failed', 'cancelled']);
  const agentWorking = $derived.by(() => {
    const session = $activeSession;
    if (session?.state !== 'active' || session.required_action != null || currentGroupKey === null) return false;
    return currentAgent !== null && !idleStatuses.has(currentAgent.status);
  });
  const workingGroupIndex = $derived.by(() => {
    if (!agentWorking || currentGroupKey === null) return -1;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      if (groups[index]?.groupKey === currentGroupKey) return index;
    }
    return -1;
  });

  const STICK_TO_BOTTOM_THRESHOLD_PX = 24;

  // Auto-scroll to bottom when transcript grows, unless user scrolled up.
  let scrollEl: HTMLElement | null = $state(null);
  let stick = $state(true);
  let lastSessionId: string | null = $state(null);

  function isScrolledToBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_THRESHOLD_PX;
  }

  function onScroll(): void {
    if (!scrollEl) return;
    stick = isScrolledToBottom(scrollEl);
  }

  $effect(() => {
    const session = $activeSession;
    const sessionId = session?.id ?? null;
    if (sessionId !== lastSessionId) {
      lastSessionId = sessionId;
      stick = true;
    }
    $activeTranscript?.length;
    if (stick && scrollEl) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  });
</script>

<div class="chat-thread" bind:this={scrollEl} onscroll={onScroll}>
  <div class="thread-inner">
  {#each groups as group, index (group.renderKey)}
    <AgentGroup agent={group.agent} entries={group.entries} groupKey={group.groupKey} working={index === workingGroupIndex} />
  {/each}
  </div>
</div>

<style>
  .chat-thread {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .thread-inner {
    max-width: 880px;
    margin: 0 auto;
    padding: var(--sp-2) var(--sp-4) var(--sp-5);
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
</style>
