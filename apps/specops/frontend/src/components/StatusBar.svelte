<script lang="ts">
  import { workspaceState, stateError } from '../lib/stores/documents.ts';

  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 1000 * 30);
    return () => clearInterval(id);
  });
  const fmtTime = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
</script>

<footer class="status">
  <div class="status-left">
    <span class="cwd">{$workspaceState?.workspace ?? '—'}</span>
  </div>
  <div class="status-right">
    {#if $stateError}
      <span class="err">{$stateError}</span>
    {/if}
    <span class="clock">{fmtTime(now)}</span>
  </div>
</footer>

<style>
  .status {
    grid-row: 2 / 3;
    grid-column: 1 / 4;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--sp-3);
    height: 28px;
    background: color-mix(in srgb, var(--bg-sidebar) 88%, var(--bg-base));
    border-top: 1px solid var(--bd-default);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    color: var(--fg-secondary);
    z-index: 2;
  }
  .cwd {
    font-family: var(--font-mono);
    color: var(--fg-secondary);
    max-width: 60ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .err {
    color: var(--st-err);
  }
  .clock {
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
  }
</style>
