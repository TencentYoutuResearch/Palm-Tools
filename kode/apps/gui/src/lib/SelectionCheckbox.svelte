<script lang="ts">
  import Icon from './Icon.svelte'

  type Props = {
    checked?: boolean
    indeterminate?: boolean
    disabled?: boolean
    label?: string
    ariaLabel: string
    title?: string
    onChange?: (checked: boolean) => void
  }

  let {
    checked = false,
    indeterminate = false,
    disabled = false,
    label,
    ariaLabel,
    title,
    onChange,
  }: Props = $props()

  let inputEl: HTMLInputElement | undefined = $state()

  $effect(() => {
    if (inputEl) inputEl.indeterminate = indeterminate
  })
</script>

<label class="checkbox" class:disabled title={title}>
  <input
    bind:this={inputEl}
    type="checkbox"
    {checked}
    {disabled}
    aria-label={ariaLabel}
    onchange={(event) => onChange?.(event.currentTarget.checked)}
  />
  <span class="control" aria-hidden="true">
    {#if indeterminate}
      <span class="minus"></span>
    {:else if checked}
      <Icon name="check" size={12} stroke={2.4} />
    {/if}
  </span>
  {#if label}<span class="label">{label}</span>{/if}
</label>

<style>
  .checkbox {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 28px;
    color: var(--fg-secondary);
    font-size: var(--fs-xs);
    line-height: 1;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
  }

  input {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }

  .control {
    width: 17px;
    height: 17px;
    flex: 0 0 17px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--bd-strong);
    border-radius: 5px;
    background: var(--bg-input);
    color: var(--fg-on-accent);
    box-shadow: 0 1px 0 color-mix(in srgb, var(--fg-primary) 4%, transparent) inset;
    transition:
      border-color var(--t-fast),
      background var(--t-fast),
      box-shadow var(--t-fast),
      transform var(--t-fast);
  }

  .checkbox:hover:not(.disabled) .control {
    border-color: var(--acc);
    background: color-mix(in srgb, var(--acc) 7%, var(--bg-input));
  }

  input:checked + .control,
  input:indeterminate + .control {
    border-color: var(--acc);
    background: var(--acc);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--acc) 11%, transparent);
  }

  input:focus-visible + .control {
    outline: 2px solid var(--acc);
    outline-offset: 2px;
  }

  input:active:not(:disabled) + .control { transform: scale(0.92); }

  .disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .label {
    white-space: nowrap;
    font-weight: var(--fw-med);
  }

  .minus {
    width: 9px;
    height: 2px;
    border-radius: 999px;
    background: currentColor;
  }
</style>
