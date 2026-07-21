<script lang="ts">
  import { onMount } from 'svelte';
  import Resizer from '../Resizer.svelte';
  import DocTree from './DocTree.svelte';
  import DocView from './DocView.svelte';
  import HistoryPanel from './HistoryPanel.svelte';
  import AskFloat from './AskFloat.svelte';
  import IwikiHeader from './IwikiHeader.svelte';
  import PanelToggle from '../shared/PanelToggle.svelte';
  import { iwikiLeftWidth, iwikiRightWidth, iwikiRightOpen } from '../../lib/stores/layout.ts';
  import { refreshState, workspaceState, pendingDocSelection, selectDocument } from '../../lib/stores/documents.ts';
  import { activeModule } from '../../lib/stores/layout.ts';
  import { t } from '../../lib/i18n.ts';

  function canonicalDocumentKey(docPath: string | null | undefined): string {
    if (!docPath) return '';
    return docPath.replace(/\/+$/, '').replace(/\/(?:proposal|tasks|design)\.md$/, '');
  }

  onMount(() => {
    // Re-scan workspace documents every time the user enters the iwiki module
    if (typeof window !== 'undefined') {
      refreshState();
    }
  });

  $effect(() => {
    const targetPath = $pendingDocSelection;
    if (!targetPath) return;
    // Navigate to the requested document
    void (async () => {
      await refreshState();
      const docs = $workspaceState?.scan?.data?.documents ?? [];
      const targetKey = canonicalDocumentKey(targetPath);
      const found = docs.find((d) =>
        d.path === targetPath
        || d.id === targetPath
        || canonicalDocumentKey(d.path) === targetKey
        || d.files?.some((file) => file.path === targetPath || canonicalDocumentKey(file.path) === targetKey));
      if (found) {
        await selectDocument(found);
      }
      pendingDocSelection.set(null);
    })();
  });
</script>

<section
  class="module"
  class:right-open={$iwikiRightOpen}
  style="--col-left: {$iwikiLeftWidth}px; --col-right: {$iwikiRightOpen ? $iwikiRightWidth : 0}px; --header-height: 44px;"
>
  <aside class="panel panel-left">
    <DocTree />
  </aside>

  <Resizer store={iwikiLeftWidth} min={200} max={420} side="left" />

  <section class="panel panel-mid iwiki-mid">
    <IwikiHeader />
    <DocView />
  </section>

  <Resizer store={iwikiRightWidth} min={240} max={520} side="right" />

  <aside class="panel panel-right" class:collapsed={!$iwikiRightOpen}>
    <HistoryPanel />
  </aside>

  <!-- Pinned to the module's top-right corner (not inside .panel-mid, whose
       overflow:auto would clip it). Stays in the same spot open or closed. -->
  <PanelToggle
    open={$iwikiRightOpen}
    label={t('Toggle history panel')}
    side="right"
    onclick={() => iwikiRightOpen.set(!$iwikiRightOpen)}
  />

  <AskFloat />
</section>

<style>
  .iwiki-mid {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: var(--bg-base);
  }
  .panel-right.collapsed {
    display: none;
  }
</style>
