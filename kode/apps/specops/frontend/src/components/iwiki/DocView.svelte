<script lang="ts">
  import SpecPageView from './SpecPageView.svelte';
  import AssuranceDashboard from './AssuranceDashboard.svelte';
  import {
    selectedDoc,
    selectedDocContent,
    docLoading,
    selectedTextContext,
  } from '../../lib/stores/documents.ts';
  import { sessions } from '../../lib/stores/sessions.ts';

  function canonicalDocumentKey(docPath: string | null | undefined): string {
    if (!docPath) return '';
    return docPath.replace(/\/+$/, '').replace(/\/(?:proposal|tasks|design)\.md$/, '');
  }

  function isTerminal(state: string | undefined): boolean {
    return state === 'closed' || state === 'completed' || state === 'failed' || state === 'cancelled';
  }

  let documentSession = $derived.by(() => {
    const key = canonicalDocumentKey($selectedDoc?.path);
    if (key === '') return null;
    const selectedFileKeys = new Set(($selectedDoc?.files ?? []).map((file) => canonicalDocumentKey(file.path)));
    selectedFileKeys.add(key);
    return ($sessions ?? []).find((session) => {
      if (isTerminal(session.state)) return false;
      const sessionKey = canonicalDocumentKey(session.document_path);
      return sessionKey !== '' && selectedFileKeys.has(sessionKey);
    }) ?? null;
  });
</script>

<section class="doc-view">
  {#if $selectedDoc === null}
    <AssuranceDashboard />
  {:else if $docLoading}
    <div class="empty"><p>Loading…</p></div>
  {:else if $selectedDocContent === null}
    <div class="empty"><p>Failed to load document.</p></div>
  {:else}
    {@const content = $selectedDocContent}
    {@const doc = content.document}
    <SpecPageView
      source={doc !== null ? doc.body : content.content}
      path={$selectedDoc.path}
      title={doc?.frontmatter.title ?? $selectedDoc.title}
      status={doc?.frontmatter.status ?? $selectedDoc.status}
      documentClass={doc?.frontmatter.document_class ?? $selectedDoc.document_class ?? ($selectedDoc.kind === 'spec' ? 'normative' : 'work_item')}
      specType={doc?.frontmatter.spec_type ?? $selectedDoc.spec_type}
      workType={doc?.frontmatter.work_type ?? $selectedDoc.work_type}
      session={documentSession}
      files={$selectedDoc.files ?? []}
    />
  {/if}
</section>

<style>
  .doc-view {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    background: var(--bg-base);
  }
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--fg-tertiary);
    font-size: var(--fs-sm);
  }
</style>
