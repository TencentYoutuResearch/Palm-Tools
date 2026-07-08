<script lang="ts">
  import AgentGroup from './AgentGroup.svelte';
  import type { SessionAgent, TranscriptEntry } from '../../lib/types.ts';
  import { activeSession, activeTranscript } from '../../lib/stores/sessions.ts';

  // Group transcript entries by kode_session_id, preserving order.
  // Entries with no kode_session_id (pre-segmentation / system) form the
  // "general" group, rendered first.
  let groups = $derived.by(() => {
    const session = $activeSession;
    const transcript = $activeTranscript ?? [];
    const agents = session?.agents ?? [];
    const buckets = new Map<number | null, TranscriptEntry[]>();
    const order: (number | null)[] = [];
    const seen = new Set<number | null>();

    const ensure = (key: number | null): void => {
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
        buckets.set(key, []);
      }
    };

    ensure(null); // general bucket always first
    for (const entry of transcript) {
      const key = entry.kode_session_id ?? null;
      ensure(key);
      buckets.get(key)!.push(entry);
    }

    // Render general first, then agents in started_at order.
    const general = buckets.get(null) ?? [];
    const result: Array<{ agent: SessionAgent | null; entries: TranscriptEntry[] }> = [];
    if (general.length > 0) result.push({ agent: null, entries: general });
    for (const agent of [...agents].sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? ''))) {
      const entries = buckets.get(agent.kode_session_id) ?? [];
      if (entries.length > 0) result.push({ agent, entries });
    }
    return result;
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
  {#each groups as group (group.agent?.kode_session_id ?? -1)}
    <AgentGroup agent={group.agent} entries={group.entries} />
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
