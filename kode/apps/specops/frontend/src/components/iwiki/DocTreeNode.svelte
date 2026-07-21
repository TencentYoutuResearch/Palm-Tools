<script lang="ts">
  import StatusBadge from '../shared/StatusBadge.svelte';
  import Icon from '../shared/Icon.svelte';
  import {
    expandedNodes,
    toggleNode,
    selectDocument,
    selectedDoc,
  } from '../../lib/stores/documents.ts';
  import type { RegistryEntry } from '../../lib/types.ts';

  interface Props {
    entry: RegistryEntry;
  }
  let { entry }: Props = $props();

  const isExpanded = $derived($expandedNodes.has(entry.id));
  const isSelected = $derived($selectedDoc?.path === entry.path);
</script>

<button
  type="button"
  class="node"
  class:change={entry.files !== undefined}
  class:selected={isSelected}
  onclick={() => selectDocument(entry)}
>
  <span class="status-dot" data-status={entry.status}></span>
  <span class="title">{entry.title}</span>
  <StatusBadge label={entry.status} tone={entry.status} />
  {#if entry.files !== undefined}
    <span
      class="chevron"
      role="button"
      tabindex="0"
      onclick={(e) => {
        e.stopPropagation();
        toggleNode(entry.id);
      }}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          toggleNode(entry.id);
        }
      }}
    >
      <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={14} />
    </span>
  {/if}
</button>

{#if entry.files !== undefined && isExpanded}
  <div class="subfiles">
    {#each entry.files as file (file.path)}
      {@const selected = $selectedDoc?.path === file.path}
      <button
        type="button"
        class="subfile"
        class:selected
        onclick={() => selectDocument({ ...entry, path: file.path, title: file.name })}
      >
        <Icon name="fold" size={12} />
        <span class="subfile-name">{file.name}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .node {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 100%;
    padding: var(--sp-1) var(--sp-2);
    border-radius: var(--rad-md);
    border: 1px solid transparent;
    background: transparent;
    text-align: left;
    font-size: var(--fs-sm);
    color: var(--fg-primary);
    transition:
      background var(--t-base),
      border-color var(--t-base),
      box-shadow var(--t-base),
      transform var(--t-fast);
  }
  .node:hover {
    background: var(--bg-tab-hover);
    border-color: var(--bd-muted);
  }
  .node:active {
    transform: scale(0.997);
  }
  .node.selected {
    background: var(--bg-selected);
    border-color: color-mix(in srgb, var(--acc) 42%, var(--bd-default));
    box-shadow:
      inset 2px 0 0 0 var(--acc),
      0 8px 24px rgba(0, 0, 0, 0.1);
  }
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--fg-tertiary);
    flex-shrink: 0;
    transition: background var(--t-fast);
  }
  .status-dot[data-status='active'] {
    background: var(--st-idle);
    animation: pulse-soft 2.4s ease-in-out infinite;
  }
  .status-dot[data-status='proposed'],
  .status-dot[data-status='completed'] {
    background: var(--st-info);
  }
  .status-dot[data-status='archived'] {
    opacity: 0.5;
  }
  @keyframes pulse-soft {
    0%, 100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.6;
      transform: scale(0.85);
    }
  }
  .title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }
  .chevron {
    display: flex;
    color: var(--fg-tertiary);
    padding: 2px;
    border-radius: var(--rad-sm);
  }
  .chevron:hover {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
  .subfiles {
    display: flex;
    flex-direction: column;
    padding-left: var(--sp-4);
    gap: 2px;
    margin-top: 2px;
  }
  .subfile {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-2);
    border-radius: var(--rad-sm);
    border: 1px solid transparent;
    background: transparent;
    font-size: var(--fs-xs);
    font-family: var(--font-mono);
    color: var(--fg-secondary);
    text-align: left;
    width: 100%;
  }
  .subfile:hover {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
  .subfile.selected {
    background: var(--bg-selected);
    color: var(--acc);
  }
  .subfile-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
