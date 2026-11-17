<script lang="ts">
  /**
   * Covers the session area while a conversation moves between the terminal
   * and an extension view, so the user sees what is happening instead of a
   * disappearing tab. The first switch into a view also installs that
   * view's runtime; its own progress shows under the `start` step.
   */
  import Icon from './Icon.svelte'
  import { extensionProgress } from './extensions'
  import type { SwitchProgress, SwitchStep } from './runtime_switch'
  import { currentLocale, t } from './i18n'

  let { progress }: { progress: SwitchProgress } = $props()

  const tr = (key: string, params?: Record<string, string | number>) => {
    void $currentLocale
    return t(key, params)
  }

  const labels: Record<SwitchStep, string> = {
    start: 'extensions.progress.start',
    stop: 'extensions.progress.stop',
    import: 'extensions.progress.import',
    open: 'extensions.progress.open',
    resume: 'extensions.progress.resume',
  }

  const currentIndex = $derived(progress.steps.indexOf(progress.current))
  const startup = $derived(progress.extension ? $extensionProgress[progress.extension] : undefined)
</script>

<div class="switch-overlay" role="status" aria-live="polite">
  <div class="card">
    <div class="head">
      <Icon name={progress.to === 'view' ? 'message-square' : 'terminal'} size={16} />
      <span>{progress.to === 'view' ? tr('extensions.progress.toView', { name: progress.viewTitle }) : tr('extensions.progress.toTui')}</span>
    </div>
    <p class="session">{progress.title}</p>
    <ol>
      {#each progress.steps as step, index (step)}
        <li class:done={index < currentIndex} class:current={index === currentIndex}>
          <span class="mark" aria-hidden="true">
            {#if index < currentIndex}
              <Icon name="check" size={12} />
            {:else if index === currentIndex}
              <span class="spinner"></span>
            {/if}
          </span>
          <span class="label">
            {tr(labels[step], { name: progress.viewTitle })}
            {#if step === 'start' && index === currentIndex && startup}
              <small>
                {#if startup.step && startup.total}<b>{startup.step}/{startup.total}</b>{/if}
                {startup.message}
              </small>
            {/if}
          </span>
        </li>
      {/each}
    </ol>
  </div>
</div>

<style>
  .switch-overlay {
    position: absolute;
    inset: 0;
    z-index: 4;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--bg-base) 82%, transparent);
    backdrop-filter: blur(2px);
  }
  .card {
    width: min(380px, calc(100% - 48px));
    padding: var(--sp-4);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-lg);
    background: var(--bg-elevated);
    box-shadow: var(--sh-md);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    color: var(--fg-primary);
    font-size: var(--fs-md);
    font-weight: var(--fw-semi);
  }
  .session {
    margin: 4px 0 var(--sp-3);
    color: var(--fg-tertiary);
    font-size: var(--fs-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  li {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
    color: var(--fg-tertiary);
    font-size: var(--fs-sm);
  }
  li.done {
    color: var(--fg-secondary);
  }
  li.current {
    color: var(--fg-primary);
  }
  .mark {
    flex: none;
    display: grid;
    place-items: center;
    width: 16px;
    height: 18px;
    color: var(--st-ok);
  }
  .mark:empty::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--bd-strong);
  }
  .label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  small {
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
  }
  small b {
    margin-right: 4px;
    font-weight: var(--fw-med);
    font-variant-numeric: tabular-nums;
  }
  .spinner {
    width: 12px;
    height: 12px;
    border: 1.5px solid var(--bd-default);
    border-top-color: var(--acc);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
