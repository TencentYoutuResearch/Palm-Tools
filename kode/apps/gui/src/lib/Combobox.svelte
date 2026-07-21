<script lang="ts">
  /**
   * Combobox.svelte —— input + 右侧 affordance 下拉按钮 + 浮层历史。
   *
   * 抽自 BackendChooser 的 cwd combobox,通用化:用户可自由输入,
   * 也可点右侧 caret 展开历史候选浮层。候选来自 `options` prop
   * (调用方负责去重 / 排序 / 持久化)。
   *
   * 设计要点(已记入 memory `combobox` 方案):
   * - 容器(.combobox)统一画边框/圆角/背景,input 去边框继承
   * - affordance 始终可见(无候选时 disabled 灰色),caret open 时翻转
   * - 浮层 absolute 贴容器下方,点外部关闭(由调用方 root onclick 关闭,
   *   本组件 stopPropagation 防冒泡)
   * - 不用原生 <select>(样式不可控),不用 chip 列表(占空间)
   */
  import { outsideElementPressClose } from './outside_close'

  type Props = {
    value: string
    placeholder?: string
    options: string[]
    id?: string
    disabled?: boolean
    /// 候选为空时是否仍显示 affordance(灰色 disabled)。默认 true,让用户知道这里可下拉。
    showAffordanceWhenEmpty?: boolean
    onchange?: (value: string) => void
    onselect?: (value: string) => void
  }

  let {
    value = $bindable(),
    placeholder = '',
    options,
    id,
    disabled = false,
    showAffordanceWhenEmpty = true,
    onchange,
    onselect,
  }: Props = $props()

  let open = $state(false)
  let wrapEl: HTMLElement
  // listbox 唯一 id,供 aria-controls 关联
  const listboxId = `combobox-listbox-${Math.random().toString(36).slice(2, 9)}`

  function toggle() {
    if (disabled || options.length === 0) return
    open = !open
  }

  function select(v: string) {
    value = v
    open = false
    onselect?.(v)
    onchange?.(v)
  }

  function onInput(e: Event) {
    value = (e.target as HTMLInputElement).value
    onchange?.(value)
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') open = false
  }

  // 点组件内部不冒泡到 root(调用方 root onclick 关闭浮层)
  function stop(e: MouseEvent) {
    e.stopPropagation()
  }

  const hasOptions = $derived(options.length > 0 && !disabled)
  const showAffordance = $derived(hasOptions || showAffordanceWhenEmpty)
</script>

<div
  bind:this={wrapEl}
  class="combobox"
  class:open
  use:outsideElementPressClose={{ onClose: () => (open = false), disabled: !open }}
  onclick={stop}
  onkeydown={onKeydown}
  role="combobox"
  aria-expanded={open}
  aria-haspopup="listbox"
  aria-controls={listboxId}
  tabindex="-1"
>
  <input
    {id}
    type="text"
    {value}
    oninput={onInput}
    onkeydown={(e) => { if (e.key === 'Escape') open = false }}
    {placeholder}
    spellcheck="false"
    autocomplete="off"
    disabled={disabled}
  />
  {#if showAffordance}
    <button
      type="button"
      class="affordance"
      class:disabled={!hasOptions}
      disabled={!hasOptions}
      onclick={toggle}
      aria-label="Show options"
      aria-expanded={open}
      title={hasOptions ? 'Recent' : 'No options yet'}
    >
      <span class="caret" class:up={open}>
        <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
          <path d="M1.5 3l3 3 3-3" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
    </button>
  {/if}
  {#if open && hasOptions}
    <ul class="popover" role="listbox" id={listboxId}>
      {#each options as opt (opt)}
        <li>
          <button
            type="button"
            class="popover-item"
            class:current={opt === value}
            onclick={() => select(opt)}
            title={opt}
          >
            <span class="popover-text">{opt}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .combobox {
    position: relative;
    flex: 1;
    display: flex;
    align-items: stretch;
    min-width: 0;
    background: var(--bg-input);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    transition: border-color var(--t-fast), box-shadow var(--t-fast);
  }
  .combobox:focus-within {
    border-color: var(--acc);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--acc) 14%, transparent);
  }
  .combobox.open {
    border-color: var(--acc);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--acc) 14%, transparent);
  }

  .combobox input {
    flex: 1;
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 8px 10px;
    color: var(--fg-primary);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    min-width: 0;
  }
  .combobox input:focus {
    outline: none;
    border-color: transparent;
  }
  .combobox input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .affordance {
    flex: 0 0 auto;
    width: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 10px;
    margin: 0;
    border: none;
    border-left: 1px solid var(--bd-default);
    border-radius: 0 var(--rad-md) var(--rad-md) 0;
    background: transparent;
    color: var(--fg-tertiary);
    cursor: pointer;
    font: inherit;
    text-align: left;
    transition: color var(--t-fast), background var(--t-fast);
  }
  .affordance:hover:not(:disabled) {
    color: var(--fg-primary);
    background: var(--bg-tab-hover);
    border-color: var(--bd-default);
    box-shadow: none;
  }
  .affordance:disabled,
  .affordance.disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
  .combobox.open .affordance {
    color: var(--acc);
    background: color-mix(in srgb, var(--acc) 10%, transparent);
    border-left-color: color-mix(in srgb, var(--acc) 30%, var(--bd-default));
  }

  .caret {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: transform var(--t-fast);
  }
  .caret.up {
    transform: rotate(180deg);
  }

  .popover {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 50;
    list-style: none;
    margin: 0;
    padding: 4px;
    background: var(--bg-elevated);
    border: 1px solid var(--bd-strong);
    border-radius: var(--rad-md);
    box-shadow: var(--sh-md, 0 4px 16px rgba(0, 0, 0, 0.18));
    max-height: 240px;
    overflow-y: auto;
    animation: popoverIn 90ms ease-out;
  }
  @keyframes popoverIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .popover-item {
    width: 100%;
    border: none;
    background: transparent;
    color: var(--fg-secondary);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    padding: 7px 10px;
    border-radius: var(--rad-sm);
    cursor: pointer;
    text-align: left;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .popover-item:hover {
    background: var(--acc-soft);
    color: var(--fg-primary);
    border-color: transparent;
    box-shadow: none;
  }
  .popover-item.current {
    color: var(--acc);
    background: color-mix(in srgb, var(--acc) 8%, transparent);
  }
  .popover-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
