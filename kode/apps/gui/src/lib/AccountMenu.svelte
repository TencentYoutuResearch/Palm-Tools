<script lang="ts">
  /**
   * Sidebar account popover, modelled on Slack's profile menu: identity card
   * first, then account-scoped actions. It reads status once on open and
   * never polls.
   */
  import { onMount } from 'svelte'
  import type { CloudSyncStatus } from './ipc'
  import Icon from './Icon.svelte'
  import { currentLocale, t } from './i18n'

  type Props = {
    status: CloudSyncStatus | null
    onAccountSettings: () => void
    onRelaySettings: () => void
    onSignOut: () => void
    onClose: () => void
    /** Trigger rect in the compact sidebar: the sidebar clips overflow, so the
     *  menu is fixed beside the trigger instead of above it. */
    anchor?: DOMRect | null
  }
  let { status, onAccountSettings, onRelaySettings, onSignOut, onClose, anchor = null }: Props = $props()
  let anchorStyle = $derived(
    anchor ? `position:fixed;left:${anchor.right + 8}px;bottom:${window.innerHeight - anchor.bottom}px` : '',
  )

  let menuEl: HTMLDivElement
  let account = $derived(status?.backends.find((b) => b.kind === 'account_relay') ?? null)
  let tr = $derived.by(() => {
    void $currentLocale
    return t
  })

  onMount(() => {
    menuEl.querySelector<HTMLElement>('button')?.focus()
    const onPointer = (event: PointerEvent) => {
      if (!menuEl.contains(event.target as Node)) onClose()
    }
    // Defer so the click that opened the menu doesn't close it.
    const timer = setTimeout(() => window.addEventListener('pointerdown', onPointer, true))
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerdown', onPointer, true)
    }
  })

  function onKey(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }

  function initial(label: string | null | undefined): string {
    return ((label ?? '').split('@')[0].trim().slice(0, 1) || 'K').toUpperCase()
  }

  let stateLabel = $derived(
    !account
      ? tr('pairing.account.menu.signedOut')
      : !account.active
        ? tr('pairing.account.inactive')
        : status?.sync_enabled
          ? tr('pairing.account.viewing')
          : status?.connected
            ? tr('pairing.account.standby')
            : tr('pairing.offline'),
  )
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="menu" role="menu" tabindex="-1" bind:this={menuEl} onkeydown={onKey} style={anchorStyle}>
  <div class="identity">
    {#if account?.account_picture}
      <img class="avatar" src={account.account_picture} alt="" referrerpolicy="no-referrer" />
    {:else}
      <span class="avatar" class:empty={!account} aria-hidden="true">
        {#if account}{initial(account.account_label)}{:else}<Icon name="user" size={16} />{/if}
      </span>
    {/if}
    <div class="identity-copy">
      <strong>{account?.account_label ?? tr('pairing.account.title')}</strong>
      <span class="state" class:on={Boolean(account?.active && status?.connected)}>
        <span class="dot" aria-hidden="true"></span>{stateLabel}
      </span>
    </div>
  </div>
  <div class="divider" role="separator"></div>
  <button role="menuitem" onclick={onAccountSettings}>
    <Icon name="user" size={14} />
    {account ? tr('pairing.account.menu.settings') : tr('pairing.account.sidebarSignIn')}
  </button>
  <button role="menuitem" onclick={onRelaySettings}>
    <Icon name="smartphone" size={14} />{tr('pairing.account.menu.relay')}
  </button>
  {#if account}
    <div class="divider" role="separator"></div>
    <button role="menuitem" class="danger" onclick={onSignOut}>
      <Icon name="log-out" size={14} />{tr('pairing.account.signOut')}
    </button>
  {/if}
</div>

<style>
  .menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 8px;
    z-index: 900;
    display: grid;
    width: 248px;
    padding: 6px;
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    background: var(--bg-elevated);
    box-shadow: var(--sh-modal);
    color: var(--fg-primary);
    font: var(--fs-sm) var(--font-ui);
    white-space: normal;
    outline: none;
  }
  .identity { display: flex; align-items: center; gap: 10px; padding: 8px; }
  .avatar { display: grid; width: 36px; height: 36px; flex: 0 0 auto; place-items: center; border-radius: var(--rad-sm); background: var(--acc); color: var(--fg-on-accent); font-weight: 700; object-fit: cover; }
  .avatar.empty { background: var(--bg-input); color: var(--fg-tertiary); }
  .identity-copy { display: grid; min-width: 0; gap: 2px; }
  .identity-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-tertiary); font-size: var(--fs-xs); }
  .state.on { color: var(--st-ok); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .divider { height: 1px; margin: 4px 0; background: var(--bd-default); }
  button { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 8px; border: 0; border-radius: var(--rad-sm); background: transparent; color: var(--fg-primary); font: inherit; text-align: left; cursor: pointer; }
  button:hover, button:focus-visible { background: var(--bg-tab-hover); outline: none; }
  .danger { color: var(--st-err); }
</style>
