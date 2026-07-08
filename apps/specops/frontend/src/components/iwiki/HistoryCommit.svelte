<script lang="ts">
  import Icon from '../shared/Icon.svelte';
  import { commitDiff, diffLoading, loadDiff, selectCommit, selectedCommit } from '../../lib/stores/history.ts';
  import type { HistoryCommit } from '../../lib/types.ts';

  interface Props {
    commit: HistoryCommit;
    docPath: string;
  }
  let { commit, docPath }: Props = $props();

  const isExpanded = $derived($selectedCommit?.hash === commit.hash);
  const diffLines = $derived(($commitDiff ?? '').split('\n'));
  const fmtDate = (iso: string): string => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };
  const lineKind = (line: string): string => {
    if (line.startsWith('+++') || line.startsWith('---')) return 'file';
    if (line.startsWith('@@')) return 'hunk';
    if (line.startsWith('+')) return 'add';
    if (line.startsWith('-')) return 'del';
    if (line.startsWith('diff --git') || line.startsWith('index ')) return 'meta';
    return 'ctx';
  };
</script>

<article class="commit" class:expanded={isExpanded}>
  <button
    type="button"
    class="commit-head"
    onclick={() => {
      if (isExpanded) {
        selectCommit(null);
      } else {
        selectCommit(commit);
        loadDiff(docPath, commit.hash);
      }
    }}
  >
    <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={14} />
    <span class="hash">{commit.short}</span>
    <span class="msg">{commit.message}</span>
    <span class="meta">
      <span class="author">{commit.author}</span>
      <span class="dot">·</span>
      <time>{fmtDate(commit.date)}</time>
    </span>
  </button>
  {#if isExpanded}
    <div class="commit-body">
      {#if $diffLoading}
        <p class="muted">Loading diff…</p>
      {:else if $commitDiff}
        <div class="diff-frame" role="region" aria-label="commit diff">
          {#each diffLines as line, i (`${i}-${line}`)}
            <div class="diff-line {lineKind(line)}">
              <span class="ln">{String(i + 1).padStart(3, ' ')}</span>
              <code>{line || ' '}</code>
            </div>
          {/each}
        </div>
      {:else}
        <p class="muted">No diff available.</p>
      {/if}
    </div>
  {/if}
</article>

<style>
  .commit {
    display: flex;
    flex-direction: column;
    width: 100%;
    border-radius: var(--rad-md);
    border: 1px solid var(--bd-muted);
    background: color-mix(in srgb, var(--bg-elevated) 94%, var(--bg-base));
    overflow: hidden;
    transition: background var(--t-fast), border-color var(--t-fast), box-shadow var(--t-fast);
  }
  .commit:hover {
    background: var(--bg-elevated);
    border-color: var(--bd-default);
  }
  .commit.expanded {
    border-color: color-mix(in srgb, var(--acc) 30%, var(--bd-default));
    box-shadow: var(--sh-sm);
  }
  .commit-head {
    display: grid;
    grid-template-columns: 14px auto minmax(0, 1fr);
    grid-template-areas:
      'icon hash msg'
      'icon meta meta';
    align-items: center;
    column-gap: var(--sp-2);
    row-gap: 2px;
    padding: var(--sp-2) var(--sp-3);
    width: 100%;
    border: 0;
    background: transparent;
    text-align: left;
  }
  .commit-head :global(svg) {
    grid-area: icon;
    color: var(--fg-tertiary);
  }
  .hash {
    grid-area: hash;
    font-family: var(--font-mono);
    color: var(--acc);
    font-size: var(--fs-xs);
  }
  .msg {
    grid-area: msg;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-primary);
    font-size: var(--fs-sm);
  }
  .meta {
    grid-area: meta;
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    min-width: 0;
  }
  .author {
    color: var(--fg-secondary);
  }
  .dot {
    opacity: 0.5;
  }
  .commit-body {
    border-top: 1px solid var(--bd-muted);
    background: var(--bg-base);
    padding: var(--sp-2);
  }
  .diff-frame {
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
    background: #080a09;
    overflow: auto;
    max-height: 48vh;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
  }
  .diff-line {
    display: grid;
    grid-template-columns: 42px minmax(max-content, 1fr);
    min-width: max-content;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.55;
    white-space: pre;
  }
  .ln {
    padding: 0 var(--sp-2);
    color: var(--fg-tertiary);
    background: color-mix(in srgb, var(--bg-sidebar) 82%, black);
    border-right: 1px solid var(--bd-muted);
    user-select: none;
    text-align: right;
  }
  code {
    padding: 0 var(--sp-2);
    color: var(--fg-secondary);
  }
  .diff-line.meta code,
  .diff-line.file code {
    color: var(--st-info);
  }
  .diff-line.hunk code {
    color: var(--st-busy);
    background: color-mix(in srgb, var(--st-busy) 10%, transparent);
  }
  .diff-line.add code {
    color: var(--st-idle);
    background: color-mix(in srgb, var(--st-idle) 12%, transparent);
  }
  .diff-line.del code {
    color: var(--st-err);
    background: color-mix(in srgb, var(--st-err) 12%, transparent);
  }
  .muted {
    color: var(--fg-tertiary);
    font-size: var(--fs-sm);
    margin: var(--sp-1) 0;
  }
</style>
