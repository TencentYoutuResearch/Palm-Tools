<script lang="ts">
  import { renderMarkdown } from '../../lib/markdown.ts';

  interface Props {
    source: string;
  }
  let { source }: Props = $props();

  // Rendered HTML is trusted to the server (markdown is authored by the user
  // in their own workspace), so we use {@html}. If we ever expose SpecOps to
  // untrusted markdown, switch to DOMPurify.
  let html = $derived(renderMarkdown(source).html);
</script>

<div class="markdown">{@html html}</div>

<style>
  .markdown :global(h1) {
    font-size: var(--fs-xl);
    font-weight: var(--fw-semi);
    margin: var(--sp-4) 0 var(--sp-2);
  }
  .markdown :global(h2) {
    font-size: var(--fs-lg);
    font-weight: var(--fw-semi);
    margin: var(--sp-4) 0 var(--sp-2);
  }
  .markdown :global(h3) {
    font-size: var(--fs-md);
    font-weight: var(--fw-semi);
    margin: var(--sp-3) 0 var(--sp-2);
  }
  .markdown :global(p) {
    margin: var(--sp-2) 0;
    line-height: 1.55;
  }
  .markdown :global(ul),
  .markdown :global(ol) {
    margin: var(--sp-2) 0;
    padding-left: var(--sp-4);
  }
  .markdown :global(li) {
    margin: var(--sp-1) 0;
  }
  .markdown :global(code) {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    background: var(--bg-pre);
    padding: 1px var(--sp-1);
    border-radius: var(--rad-sm);
  }
  .markdown :global(pre) {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    background: var(--bg-pre);
    padding: var(--sp-3);
    border-radius: var(--rad-md);
    overflow-x: auto;
    border: 1px solid var(--bd-muted);
  }
  .markdown :global(pre) :global(code) {
    background: transparent;
    padding: 0;
  }
  .markdown :global(blockquote) {
    border-left: 3px solid var(--bd-strong);
    padding-left: var(--sp-3);
    color: var(--fg-secondary);
    margin: var(--sp-3) 0;
  }
  .markdown :global(a) {
    color: var(--st-info);
    text-decoration: none;
  }
  .markdown :global(a:hover) {
    text-decoration: underline;
  }
  .markdown :global(table) {
    border-collapse: collapse;
    margin: var(--sp-3) 0;
    font-size: var(--fs-sm);
  }
  .markdown :global(th),
  .markdown :global(td) {
    border: 1px solid var(--bd-default);
    padding: var(--sp-1) var(--sp-2);
  }
  .markdown :global(hr) {
    border: none;
    border-top: 1px solid var(--bd-default);
    margin: var(--sp-4) 0;
  }
</style>
