<script lang="ts">
  /**
   * RenameDialog.svelte —— 重命名当前 tab title 的简单对话框。
   * F2 触发,Enter 提交,Esc 取消。
   */
  import { onMount } from 'svelte'
  import { outsidePressClose } from './outside_close'

  type Props = {
    initial: string
    onSubmit: (next: string) => void
    onClose: () => void
  }

  let { initial, onSubmit, onClose }: Props = $props()

  let value = $state('')
  $effect(() => { value = initial })
  let inputEl: HTMLInputElement

  onMount(() => {
    inputEl?.focus()
    inputEl?.select()
  })

  function onKey(e: KeyboardEvent) {
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

<div class="backdrop" use:outsidePressClose={{ onClose }} role="presentation">
  <div class="dlg" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" tabindex="-1">
    <div class="label">Rename tab</div>
    <input
      bind:this={inputEl}
      bind:value
      onkeydown={onKey}
      spellcheck="false"
      autocomplete="off"
    />
    <div class="hint">
      <kbd>↵</kbd> save
      <span class="sep">·</span>
      <kbd>esc</kbd> cancel
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
    margin-top: var(--sp-3);
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
    display: flex;
    align-items: center;
    gap: var(--sp-1);
  }
  .hint .sep { margin: 0 var(--sp-1); }
  kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 3px;
    background: var(--bg-tab-hover);
    color: var(--fg-secondary);
    font-family: var(--font-mono);
    font-size: 10px;
    border: 1px solid var(--bd-default);
  }
</style>
