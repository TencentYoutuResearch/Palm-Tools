<script lang="ts">
  import { onMount } from 'svelte'
  import { currentLocale, t } from './i18n'
  import { updates, startUpdateChecks, installAppUpdate, restartAfterUpdate } from './app_updates'
  import { pushToast } from './toast'

  /** `rail`: the round accent button above the account in the activity rail. */
  let { variant = 'titlebar' }: { variant?: 'titlebar' | 'rail' } = $props()

  let update = $derived($updates.update)
  let phase = $derived($updates.phase)
  let currentVersion = $derived($updates.currentVersion)
  let tr = $derived.by(() => {
    void $currentLocale
    return (key: string, params?: Record<string, string | number>) => t(key, params)
  })
  let progress = $derived(
    $updates.contentLength && $updates.contentLength > 0
      ? Math.min(100, Math.round($updates.downloaded / $updates.contentLength * 100))
      : null
  )
  onMount(startUpdateChecks)
  async function installUpdate() {
    if (phase === 'installed') await restartAfterUpdate()
    else {
      await installAppUpdate()
      if ($updates.phase === 'installed') pushToast({ severity: 'success', title: tr('update.installed'), detail: tr('settings.updates.ready'), durationMs: 8000 })
    }
    if ($updates.error) pushToast({ severity: 'error', title: tr('update.failed'), detail: $updates.error, durationMs: 8000 })
  }
</script>

{#if update}
  <button
    type="button"
    class="update-button"
    class:rail={variant === 'rail'}
    class:busy={phase === 'downloading' || phase === 'installing'}
    class:installing={phase === 'installing'}
    onclick={installUpdate}
    disabled={phase !== 'idle' && phase !== 'installed'}
    aria-label={phase === 'installed' ? tr('settings.updates.restart') : phase === 'idle'
      ? tr('update.availableAria', { version: update.version })
      : tr('update.progressAria', { progress: progress ?? 0 })}
    title={phase === 'installed' ? tr('settings.updates.restartHint') : phase === 'idle'
      ? tr('update.tooltip', { current: currentVersion, next: update.version })
      : phase === 'installing'
        ? tr('update.installing')
        : progress == null
          ? tr('update.downloading')
          : tr('update.progress', { progress })}
    style={`--update-progress: ${progress ?? 0}%`}
  >
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
      <path d="M5 20h14" />
    </svg>
  </button>
{/if}

<style>
  .update-button {
    width: 28px;
    height: 28px;
    flex: 0 0 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0;
    border: 1px solid color-mix(in srgb, var(--acc) 48%, var(--bd-default));
    border-radius: var(--rad-sm);
    background: color-mix(in srgb, var(--acc) 12%, var(--bg-elevated));
    color: var(--acc);
    font: var(--fw-med) 11px/1 var(--font-ui);
    cursor: pointer;
    transition: background 140ms ease, border-color 140ms ease, transform 100ms ease;
  }

  .update-button.rail {
    width: 32px;
    height: 32px;
    flex-basis: 32px;
    border: 0;
    border-radius: 50%;
    background: var(--acc);
    color: var(--fg-on-accent);
  }
  .update-button.rail:hover:not(:disabled) {
    background: color-mix(in srgb, var(--acc) 86%, var(--fg-primary));
  }
  .update-button:hover:not(:disabled) {
    background: color-mix(in srgb, var(--acc) 19%, var(--bg-elevated));
    border-color: var(--acc);
  }

  .update-button:focus-visible {
    outline: 2px solid var(--acc);
    outline-offset: 2px;
  }

  .update-button:active:not(:disabled) {
    transform: translateY(1px);
  }

  .update-button:disabled {
    cursor: wait;
    opacity: 0.78;
    background:
      linear-gradient(var(--bg-elevated), var(--bg-elevated)) padding-box,
      conic-gradient(var(--acc) var(--update-progress), var(--bd-default) 0) border-box;
    border-color: transparent;
  }

  .update-button.busy:not(.installing) svg {
    animation: update-pulse 900ms ease-in-out infinite alternate;
  }

  .update-button.installing svg {
    animation: update-install 900ms linear infinite;
  }

  @keyframes update-pulse {
    from { opacity: 0.45; transform: translateY(-1px); }
    to { opacity: 1; transform: translateY(1px); }
  }

  @keyframes update-install {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .update-button { transition: none; }
    .update-button.busy svg { animation: none; }
  }
</style>
