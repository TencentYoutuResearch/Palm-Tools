<script lang="ts">
  import DocTreeNode from './DocTreeNode.svelte';
  import Icon from '../shared/Icon.svelte';
  import { workspaceState, refreshState, selectedDoc, selectedDocContent } from '../../lib/stores/documents.ts';
  import type { RegistryEntry, DocumentKind, DocumentStatus } from '../../lib/types.ts';
  import { onWindowDragMouseDown } from '../../lib/windowDrag.ts';

  let collapsedGroups = $state<Set<string>>(new Set(['Archive']));
  let refreshing = $state(false);

  async function doRefresh(): Promise<void> {
    refreshing = true;
    await refreshState();
    refreshing = false;
  }

  function groupOf(entry: RegistryEntry): string {
    if (entry.status === 'archived') return 'Archive';
    const map: Record<DocumentKind, string> = {
      spec: 'Specs',
      change: 'Changes',
      bug: 'Bugs',
      refactor: 'Refactors',
      feature: 'Features',
      investigation: 'Investigations',
    };
    return map[entry.kind] ?? 'Other';
  }

  function toggleGroup(label: string): void {
    const next = new Set(collapsedGroups);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    collapsedGroups = next;
  }

  const statusPriority: Record<DocumentStatus, number> = {
    active: 0,
    approved: 0,
    in_progress: 0,
    proposed: 1,
    completed: 2,
    draft: 3,
    blocked: 3,
    deprecated: 4,
    superseded: 4,
    cancelled: 4,
    archived: 4,
  };

  const groups = $derived.by(() => {
    const docs = $workspaceState?.scan?.data?.documents ?? [];
    const buckets = new Map<string, RegistryEntry[]>();
    for (const entry of docs) {
      const key = groupOf(entry);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(entry);
    }
    // Sort entries within each group: active first, then proposed, completed, draft, archived
    for (const entries of buckets.values()) {
      entries.sort((a, b) => {
        const pa = statusPriority[a.status] ?? 99;
        const pb = statusPriority[b.status] ?? 99;
        return pa - pb;
      });
    }
    const order = ['Specs', 'Changes', 'Bugs', 'Refactors', 'Features', 'Investigations', 'Archive', 'Other'];
    return order
      .filter((label) => buckets.has(label))
      .map((label) => ({ label, entries: buckets.get(label)! }));
  });
</script>

<div class="tree">
  <div class="tree-header" role="presentation" data-tauri-drag-region onmousedown={onWindowDragMouseDown}>
    <button type="button" class="control-btn" onclick={() => { selectedDoc.set(null); selectedDocContent.set(null); }}>
      <Icon name="activity" size={13} /> Assurance
    </button>
    <button
      type="button"
      class="refresh-btn"
      onclick={doRefresh}
      disabled={refreshing}
      aria-label="Refresh documents"
      title="Refresh documents"
    >
      <Icon name="refresh" size={13} />
    </button>
  </div>
  {#each groups as group (group.label)}
    {@const collapsed = collapsedGroups.has(group.label)}
    <section class="group" class:collapsed>
      <button type="button" class="group-title" onclick={() => toggleGroup(group.label)}>
        <span class="group-left">
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={13} />
          <span>{group.label}</span>
        </span>
        <span class="count">{group.entries.length}</span>
      </button>
      {#if !collapsed}
        <div class="group-items">
          {#each group.entries as entry (entry.id)}
            <DocTreeNode {entry} />
          {/each}
        </div>
      {/if}
    </section>
  {/each}
</div>

<style>
  .tree {
    user-select: none;
    -webkit-user-select: none;
  }
  .tree {
    padding: var(--sp-2);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .group-title {
    font-size: var(--fs-xs);
    font-weight: var(--fw-semi);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-tertiary);
    padding: var(--sp-1) var(--sp-2);
    display: flex;
    justify-content: space-between;
    align-items: center;
    border: 0;
    border-radius: var(--rad-sm);
    background: transparent;
    width: 100%;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .group-title:hover {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
  .group-left {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    min-width: 0;
  }
  .group-items {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .count {
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    font-weight: var(--fw-reg);
  }
  .tree-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: var(--sp-1);
    min-height: 44px;
    align-items: center;
    -webkit-app-region: drag;
    user-select: none;
    -webkit-user-select: none;
  }
  .control-btn { display: inline-flex; align-items: center; gap: var(--sp-1); border: 0; background: transparent; color: var(--fg-secondary); font-size: var(--fs-xs); -webkit-app-region: no-drag; }
  .refresh-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    background: transparent;
    color: var(--fg-tertiary);
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast);
    -webkit-app-region: no-drag;
  }
  .refresh-btn:hover:not(:disabled) {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
  .refresh-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
