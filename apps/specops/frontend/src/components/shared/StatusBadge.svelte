<script lang="ts">
  interface Props {
    label: string;
    tone?: 'draft' | 'active' | 'deprecated' | 'superseded' | 'proposed' | 'approved' | 'in_progress' | 'blocked' | 'completed' | 'cancelled' | 'archived' | 'idle' | 'busy' | 'error' | 'info';
  }
  let { label, tone = 'draft' }: Props = $props();
</script>

<span class="badge tone-{tone}">{label}</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 1px var(--sp-2);
    border-radius: 999px;
    font-size: var(--fs-xs);
    font-family: var(--font-mono);
    line-height: 1.4;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .tone-draft {
    color: var(--fg-tertiary);
    background: var(--bg-chip);
  }
  .tone-active,
  .tone-approved,
  .tone-idle {
    color: var(--st-idle);
    background: color-mix(in srgb, var(--st-idle) 14%, transparent);
    border-color: color-mix(in srgb, var(--st-idle) 28%, transparent);
  }
  .tone-proposed,
  .tone-in_progress,
  .tone-busy {
    color: var(--st-busy);
    background: color-mix(in srgb, var(--st-busy) 14%, transparent);
    border-color: color-mix(in srgb, var(--st-busy) 28%, transparent);
  }
  .tone-completed,
  .tone-info {
    color: var(--st-info);
    background: color-mix(in srgb, var(--st-info) 14%, transparent);
    border-color: color-mix(in srgb, var(--st-info) 28%, transparent);
  }
  .tone-archived,
  .tone-deprecated,
  .tone-superseded,
  .tone-cancelled {
    color: var(--fg-tertiary);
    background: var(--bg-chip);
    opacity: 0.7;
  }
  .tone-error,
  .tone-blocked {
    color: var(--st-err);
    background: color-mix(in srgb, var(--st-err) 14%, transparent);
    border-color: color-mix(in srgb, var(--st-err) 28%, transparent);
  }
</style>
