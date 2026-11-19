<script lang="ts">
  import { ipc } from './ipc'
  import { tokenizeMessageText } from './message_text'

  let { text }: { text: string } = $props()
  let tokens = $derived(tokenizeMessageText(text))

  function openUrl(event: MouseEvent, url: string) {
    event.preventDefault()
    event.stopPropagation()
    void ipc.openPath(url).catch((error) => console.warn('[monitor] open URL failed:', error))
  }
</script>

<span class="linked-text">
  {#each tokens as token}{#if token.type === 'url'}<button type="button" class="text-link" title={token.value} onclick={(event) => openUrl(event, token.value)}>{token.value}</button>{:else}{token.value}{/if}{/each}
</span>

<style>
  .linked-text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .text-link {
    display: inline;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--acc);
    font: inherit;
    text-align: left;
    text-decoration: underline;
    text-underline-offset: 2px;
    overflow-wrap: anywhere;
    cursor: pointer;
  }
  .text-link:hover { color: color-mix(in srgb, var(--acc) 78%, var(--fg-primary)); }
  .text-link:focus-visible { outline: 2px solid var(--bd-focus); outline-offset: 2px; border-radius: 2px; }
</style>
