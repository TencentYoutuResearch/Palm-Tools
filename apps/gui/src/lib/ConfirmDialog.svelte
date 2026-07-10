<script lang="ts">
  /**
   * ConfirmDialog.svelte —— 通用二次确认对话框。
   * 用于破坏性操作前的二次确认(如关闭 tab / 删除 endpoint)。
   * 默认聚焦 Cancel 按钮,避免误按 Enter 触发破坏性操作。
   * Esc 取消;Enter 激活当前聚焦按钮(native button 行为)。
   */
  import { onMount } from 'svelte'
  import { outsidePressClose } from './outside_close'

  type Props = {
    title: string
    message?: string
    confirmLabel?: string
    cancelLabel?: string
    /** 危险操作:确认按钮渲染为红色破坏样式。 */
    danger?: boolean
    onConfirm: () => void
    onClose: () => void
  }

  let {
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false,
    onConfirm,
    onClose,
  }: Props = $props()

  let cancelEl: HTMLButtonElement

  onMount(() => {
    cancelEl?.focus()
  })

  function onKey(e: KeyboardEvent) {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }
</script>

<div class="backdrop" use:outsidePressClose={{ onClose }} role="presentation">
  <div
    class="dlg"
    onclick={(e) => e.stopPropagation()}
    onkeydown={onKey}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <div class="title">{title}</div>
    {#if message}
      <div class="msg">{message}</div>
    {/if}
    <div class="actions">
      <button class="btn cancel" bind:this={cancelEl} onclick={onClose}>
        {cancelLabel}
      </button>
      <button class="btn confirm" class:danger onclick={onConfirm}>
        {confirmLabel}
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-modal-backdrop);
    backdrop-filter: var(--blur-modal);
    -webkit-backdrop-filter: var(--blur-modal);
    z-index: 1100;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 22vh;
    animation: fadeIn 100ms ease-out;
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .dlg {
    width: 400px;
    max-width: 90vw;
    background: var(--bg-elevated);
    border-radius: var(--rad-lg);
    box-shadow: var(--sh-modal);
    color: var(--fg-primary);
    padding: var(--sp-4);
    font-family: var(--font-ui);
    animation: slideIn 120ms ease-out;
  }
  @keyframes slideIn {
    from { transform: translateY(-8px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
  .title {
    font-size: var(--fs-md);
    font-weight: var(--fw-semi);
    color: var(--fg-primary);
  }
  .msg {
    margin-top: var(--sp-2);
    font-size: var(--fs-sm);
    color: var(--fg-secondary);
    line-height: 1.5;
  }
  .actions {
    margin-top: var(--sp-4);
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
  }
  .btn {
    padding: var(--sp-2) var(--sp-3);
    border-radius: var(--rad-md);
    border: 1px solid var(--bd-default);
    background: var(--bg-input);
    color: var(--fg-primary);
    font: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast);
  }
  .btn:hover {
    background: var(--bg-tab-hover);
  }
  .btn:focus-visible {
    outline: 2px solid var(--acc);
    outline-offset: 1px;
  }
  .confirm {
    background: var(--acc);
    border-color: var(--acc);
    color: var(--fg-on-accent);
    font-weight: var(--fw-med);
  }
  .confirm:hover {
    background: color-mix(in srgb, var(--acc) 86%, white);
  }
  .confirm.danger {
    background: var(--st-err);
    border-color: var(--st-err);
    color: var(--fg-on-accent);
  }
  .confirm.danger:hover {
    background: color-mix(in srgb, var(--st-err) 88%, white);
  }
</style>
