<script lang="ts">
  import { toasts, removeToast, type Toast } from './toast'
  import Icon from './Icon.svelte'

  function onClose(e: MouseEvent, t: Toast) {
    e.stopPropagation()
    removeToast(t.id)
  }
</script>

<div class="toast-host" role="region" aria-live="polite" aria-label="Notifications">
  {#each $toasts as t (t.id)}
    <div class="toast toast-{t.severity}" role="status">
      <span class="toast-dot" aria-hidden="true"></span>
      <div class="toast-body">
        <strong>{t.title}</strong>
        {#if t.detail}
          <span class="toast-detail">{t.detail}</span>
        {/if}
      </div>
      <button
        class="toast-close"
        title="Dismiss"
        aria-label="Dismiss notification"
        onclick={(e) => onClose(e, t)}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  {/each}
</div>

<style>
  .toast-host {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 100;
    display: flex;
    flex-direction: column-reverse;
    gap: 8px;
    max-width: min(380px, calc(100vw - 32px));
    pointer-events: auto;
  }

  .toast {
    display: grid;
    grid-template-columns: 8px minmax(0, 1fr) 22px;
    align-items: start;
    gap: var(--sp-2);
    padding: 10px 12px;
    border-radius: var(--rad-md);
    border: 1px solid var(--bd-default);
    background: color-mix(in srgb, var(--bg-elevated) 96%, var(--bg-base));
    box-shadow: var(--sh-lg);
    color: var(--fg-primary);
    animation: toast-slide 180ms ease-out;
  }

  .toast-dot {
    width: 8px;
    height: 8px;
    margin-top: 5px;
    border-radius: 50%;
    background: var(--fg-tertiary);
  }
  .toast-info    .toast-dot { background: var(--st-info); }
  .toast-success .toast-dot { background: var(--st-ok); }
  .toast-warning .toast-dot { background: var(--st-warn); }
  .toast-error   .toast-dot { background: var(--st-err); }

  .toast-body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .toast-body strong {
    font-size: var(--fs-sm);
    font-weight: var(--fw-semi);
    color: var(--fg-primary);
  }
  .toast-detail {
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .toast-close {
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: var(--rad-sm);
    background: transparent;
    color: var(--fg-tertiary);
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
  }
  .toast-close:hover {
    background: var(--bg-hover);
    border-color: var(--bd-default);
    color: var(--fg-primary);
  }

  @keyframes toast-slide {
    from { transform: translateY(8px); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast { animation: none; }
  }
</style>
