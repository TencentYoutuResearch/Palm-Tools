<script lang="ts">
  /**
   * RenameDialog.svelte —— 重命名当前 tab title 的简单对话框。
   * F2 触发,Enter 提交,Esc 取消。
   */
  import { onMount } from 'svelte'
  import { outsidePressClose } from './outside_close'
  import { modalFocus } from './modal_focus'

  type Props = {
    initial: string
    submitLabel?: string
    cancelLabel?: string
    title?: string
    hint?: string
    busy?: boolean
    error?: string
    onSubmit: (next: string) => void
    onClose: () => void
  }

  let { initial, title = 'Rename tab', submitLabel = 'Save', cancelLabel = 'Cancel', hint = '↵ save · esc cancel', busy = false, error = '', onSubmit, onClose }: Props = $props()

  let value = $state('')
  $effect(() => { value = initial })
  let inputEl: HTMLInputElement

  onMount(() => {
    inputEl?.focus()
    inputEl?.select()
  })

  function onKey(e: KeyboardEvent) {
    if (e.isComposing || busy) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const v = value.trim()
      if (v) onSubmit(v)
      else onClose()
    }
  }
</script>

<div class="backdrop" use:outsidePressClose={{ onClose, disabled: busy }} role="presentation">
  <div class="dlg" use:modalFocus onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title} tabindex="-1">
    <label class="label" for="rename-value">{title}</label>
    <input
      id="rename-value"
      disabled={busy}
      aria-invalid={!!error}
      aria-describedby="rename-feedback"
      bind:this={inputEl}
      bind:value
      onkeydown={onKey}
      spellcheck="false"
      autocomplete="off"
    />
    <div class="hint" id="rename-feedback" role="status">{error || hint}
    </div>
    <div class="actions">
      <button disabled={busy} onclick={onClose}>{cancelLabel}</button>
      <button disabled={busy || !value.trim()} onclick={() => onSubmit(value.trim())}>{submitLabel}</button>
    </div>
  </div>
</div>

<style>
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .actions button { border: 1px solid var(--bd-default); border-radius: var(--rad-md); padding: 6px 12px; background: var(--bg-input); color: var(--fg-primary); cursor: pointer; }
  .actions button:hover { background: var(--bg-tab-hover); }
  .actions button:focus-visible { outline: 2px solid var(--acc); }
  .actions button:disabled { opacity: .5; cursor: default; }

  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-modal-backdrop);
    backdrop-filter: var(--blur-modal);
    -webkit-backdrop-filter: var(--blur-modal);
    z-index: 1000;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 18vh;
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
  .label {
    display: block;
    font-size: var(--fs-sm);
    color: var(--fg-secondary);
    margin-bottom: var(--sp-2);
    font-weight: var(--fw-med);
  }
  input {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg-input);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    color: var(--fg-primary);
    font: inherit;
    font-size: var(--fs-md);
    padding: var(--sp-2) var(--sp-3);
    outline: none;
    transition: border-color var(--t-fast), box-shadow var(--t-fast);
  }
  input:focus {
    border-color: var(--acc);
    box-shadow: 0 0 0 3px var(--acc-soft);
  }
  .hint {
    overflow-wrap: anywhere;
    margin-top: var(--sp-3);
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
    display: flex;
    align-items: center;
    gap: var(--sp-1);
  }
</style>
