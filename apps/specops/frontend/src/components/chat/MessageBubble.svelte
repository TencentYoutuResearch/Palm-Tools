<script lang="ts">
  import Markdown from '../shared/Markdown.svelte';
  import BackendIcon from '../shared/BackendIcon.svelte';
  import type { TranscriptEntry } from '../../lib/types.ts';

  interface Props {
    entry: TranscriptEntry;
    backendKey?: string | null;
  }
  let { entry, backendKey }: Props = $props();

  const role = $derived(entry.role);
  const roleClass = $derived(role === 'user' || role === 'system' ? role : 'agent');
</script>

<div class="bubble role-{roleClass}">
  <div class="avatar">
    {#if roleClass === 'user'}
      <span class="user-glyph">U</span>
    {:else if roleClass === 'agent'}
      <BackendIcon {backendKey} />
    {/if}
  </div>
  <div class="content">
    {#if entry.kind === 'text' || entry.kind === undefined}
      <Markdown source={entry.text} />
    {:else}
      <p class="raw">{entry.text || entry.summary || ''}</p>
    {/if}
  </div>
</div>

<style>
  .bubble {
    display: flex;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-4);
    width: 100%;
    animation: bubble-in var(--t-base) cubic-bezier(0.2, 0, 0, 1) both;
  }
  @keyframes bubble-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  .avatar {
    width: 28px;
    height: 28px;
    border-radius: 999px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    overflow: hidden;
  }
  .user-glyph {
    font-size: var(--fs-xs);
    font-weight: var(--fw-semi);
    font-family: var(--font-mono);
  }
  .content {
    flex: 1;
    min-width: 0;
    overflow-wrap: break-word;
  }
  .raw {
    margin: 0;
    white-space: pre-wrap;
    font-size: var(--fs-sm);
    color: var(--fg-secondary);
  }

  /* user */
  .role-user {
    flex-direction: row-reverse;
  }
  .role-user .avatar {
    background: var(--acc-soft);
    color: var(--acc);
  }
  .role-user .content {
    background: var(--acc-soft);
    border-radius: var(--rad-lg);
    padding: var(--sp-2) var(--sp-3);
    max-width: 80%;
    margin-left: auto;
    border: 1px solid color-mix(in srgb, var(--acc) 18%, transparent);
  }

  /* agent — avatar shows the backend's brand icon (BackendIcon) */
  .role-agent .avatar {
    background: var(--bg-chip);
  }
  .role-agent .content {
    background: var(--bg-elevated);
    border-radius: var(--rad-lg);
    padding: var(--sp-2) var(--sp-3);
    max-width: 80%;
    border: 1px solid var(--bd-muted);
  }

  /* system */
  .role-system {
    justify-content: center;
  }
  .role-system .avatar {
    display: none;
  }
  .role-system .content {
    background: var(--bg-status);
    border-radius: var(--rad-md);
    padding: var(--sp-1) var(--sp-3);
    max-width: 80%;
    text-align: center;
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
    font-style: italic;
  }
</style>
