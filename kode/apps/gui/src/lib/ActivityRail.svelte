<script lang="ts">
  /**
   * Activity rail: the narrow strip at the window's left edge, modelled on
   * the Codex/Slack desktop rail. Kode's own surfaces (sessions, memory,
   * plugins) sit at the top, extension-contributed views below a divider,
   * and identity plus settings at the bottom. The session sidebar beside it
   * only lists conversations.
   */
  import type { CloudSyncStatus } from './ipc'
  import { panelKey, type PanelTarget, type SessionViewTarget } from './extensions'
  import { ICON_NAMES, type IconName } from './Icon.svelte'
  import AccountMenu from './AccountMenu.svelte'
  import UpdateButton from './UpdateButton.svelte'
  import Icon from './Icon.svelte'
  import { currentLocale, t } from './i18n'

  type Props = {
    sessionsVisible: boolean
    onToggleSessions: () => void
    memoryPending: number
    onOpenMemory: () => void
    onOpenPlugins: () => void
    views: SessionViewTarget[]
    /** Extension id of the view in front, null in the terminal mode. */
    activeView: string | null
    switching: boolean
    onOpenView: (target: SessionViewTarget) => void
    panels: PanelTarget[]
    /** `panelKey` of the panel in front, null when none is. */
    activePanel: string | null
    panelBadges: Record<string, number>
    onOpenPanel: (target: PanelTarget) => void
    onManageExtensions: () => void
    accountStatus: CloudSyncStatus | null
    onAccountOpen: () => void
    onAccountSettings: () => void
    onRelaySettings: () => void
    onSignOut: () => void
    onOpenSettings: () => void
    /** Bound so the host can close it (Escape, settings) and keep native
     *  extension views out of its way while it is open. */
    accountOpen?: boolean
  }
  let {
    sessionsVisible,
    onToggleSessions,
    memoryPending,
    onOpenMemory,
    onOpenPlugins,
    views,
    activeView,
    switching,
    onOpenView,
    panels,
    activePanel,
    panelBadges,
    onOpenPanel,
    onManageExtensions,
    accountStatus,
    onAccountOpen,
    onAccountSettings,
    onRelaySettings,
    onSignOut,
    onOpenSettings,
    accountOpen = $bindable(false),
  }: Props = $props()
  let tr = $derived.by(() => {
    void $currentLocale
    return t
  })

  let account = $derived(accountStatus?.backends.find((b) => b.kind === 'account_relay') ?? null)
  let accountEl: HTMLButtonElement | undefined = $state()

  function accountInitial(label: string | null | undefined): string {
    return ((label ?? '').split('@')[0].trim().slice(0, 1) || 'K').toUpperCase()
  }
  let accountState = $derived(
    !account
      ? tr('pairing.account.sidebarSignIn')
      : !account.active
        ? tr('pairing.account.inactive')
        : accountStatus?.sync_enabled
          ? tr('pairing.account.viewing')
          : accountStatus?.connected
            ? tr('pairing.account.standby')
            : tr('pairing.offline'),
  )
  const panelIcon = (name: string | null): IconName => (name && (ICON_NAMES as string[]).includes(name) ? (name as IconName) : 'puzzle')
  function toggleAccount() {
    accountOpen = !accountOpen
    if (accountOpen) onAccountOpen()
  }
</script>

<nav class="rail" aria-label={tr('rail.label')}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="rail-drag" data-tauri-drag-region></div>
  <div class="rail-group">
    <button
      class="rail-btn"
      class:active={sessionsVisible && !activeView}
      aria-pressed={sessionsVisible}
      title={`${tr('rail.sessions')} (⌘B)`}
      aria-label={tr('rail.sessions')}
      onclick={onToggleSessions}
    >
      <Icon name="house" size={18} />
    </button>
    <button
      class="rail-btn"
      title={memoryPending > 0 ? tr('memory.metrics.reviewQueueTitle', { count: memoryPending }) : tr('rail.memory')}
      aria-label={tr('rail.memory')}
      onclick={onOpenMemory}
    >
      <Icon name="brain" size={18} />
      {#if memoryPending > 0}<span class="rail-badge">{memoryPending > 99 ? '99+' : memoryPending}</span>{/if}
    </button>
    <button class="rail-btn" title={tr('plugins.title')} aria-label={tr('plugins.title')} onclick={onOpenPlugins}>
      <Icon name="puzzle" size={18} />
    </button>
  </div>

  <div class="rail-sep" aria-hidden="true"></div>

  <div class="rail-group">
    {#each views as target (`${target.extension}:${target.view.id}`)}
      <button
        class="rail-btn"
        class:active={activeView === target.extension}
        aria-pressed={activeView === target.extension}
        disabled={switching}
        title={tr('extensions.switch.toView', { name: target.view.title })}
        aria-label={target.view.title}
        onclick={() => onOpenView(target)}
      >
        <Icon name="message-square" size={18} />
      </button>
    {/each}
    {#each panels as target (panelKey(target))}
      {@const badge = panelBadges[panelKey(target)] ?? 0}
      <button
        class="rail-btn"
        class:active={activePanel === panelKey(target)}
        aria-pressed={activePanel === panelKey(target)}
        title={target.view.title}
        aria-label={target.view.title}
        onclick={() => onOpenPanel(target)}
      >
        <Icon name={panelIcon(target.view.icon)} size={18} />
        {#if badge > 0}<span class="rail-badge">{badge > 99 ? '99+' : badge}</span>{/if}
      </button>
    {/each}
    <button class="rail-btn" title={tr('extensions.title')} aria-label={tr('extensions.title')} onclick={onManageExtensions}>
      <Icon name="layout-grid" size={18} />
    </button>
  </div>

  <div class="rail-spacer"></div>

  <div class="rail-group rail-bottom">
    <UpdateButton variant="rail" />
    <button
      bind:this={accountEl}
      class="rail-account"
      aria-haspopup="menu"
      aria-expanded={accountOpen}
      title={account?.account_label ? `${account.account_label} · ${accountState}` : accountState}
      aria-label={account?.account_label ?? tr('pairing.account.sidebarSignIn')}
      onclick={toggleAccount}
    >
      <span class="avatar" class:empty={!account} aria-hidden="true">
        {#if account?.account_picture}
          <img src={account.account_picture} alt="" referrerpolicy="no-referrer" />
        {:else if account}{accountInitial(account.account_label)}{:else}<Icon name="user" size={16} />{/if}
      </span>
      {#if account?.active}
        <span class="presence" class:on={accountStatus?.connected} class:live={accountStatus?.sync_enabled}></span>
      {/if}
    </button>
    <button class="rail-btn" title={tr('settings.open')} aria-label={tr('settings.open')} onclick={onOpenSettings}>
      <Icon name="settings" size={18} />
    </button>
  </div>
  {#if accountOpen}
    <AccountMenu
      anchor={accountEl?.getBoundingClientRect() ?? null}
      status={accountStatus}
      {onAccountSettings}
      {onRelaySettings}
      {onSignOut}
      onClose={() => (accountOpen = false)}
    />
  {/if}
</nav>

<style>
  .rail {
    grid-row: 1 / 3;
    grid-column: 1 / 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    min-height: 0;
    padding-bottom: 10px;
    background: var(--bg-chrome, var(--bg-sidebar));
    user-select: none;
    -webkit-user-select: none;
  }
  /* The native traffic lights sit over this strip and the sidebar's top bar. */
  .rail-drag {
    flex: 0 0 44px;
    align-self: stretch;
    -webkit-app-region: drag;
  }
  .rail-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .rail-sep {
    width: 22px;
    height: 1px;
    margin: 10px 0;
    background: var(--bd-default);
  }
  .rail-spacer { flex: 1; }
  .rail-btn,
  .rail-account {
    position: relative;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: var(--rad-md);
    background: transparent;
    color: var(--fg-secondary);
    cursor: pointer;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .rail-btn:hover:not(:disabled),
  .rail-account:hover {
    background: color-mix(in srgb, var(--fg-primary) 8%, transparent);
    color: var(--fg-primary);
  }
  .rail-btn.active {
    background: color-mix(in srgb, var(--fg-primary) 10%, transparent);
    color: var(--acc);
  }
  .rail-btn:disabled { opacity: 0.5; cursor: default; }
  .rail-btn:focus-visible,
  .rail-account:focus-visible { outline: 2px solid var(--acc); outline-offset: 1px; }
  .rail-badge {
    position: absolute;
    top: 2px;
    right: 1px;
    min-width: 15px;
    height: 15px;
    padding: 0 4px;
    box-sizing: border-box;
    border-radius: 8px;
    background: var(--acc);
    color: var(--fg-on-accent);
    font: 600 9.5px/15px var(--font-ui);
    text-align: center;
  }
  .avatar {
    display: grid;
    width: 28px;
    height: 28px;
    place-items: center;
    overflow: hidden;
    border-radius: 50%;
    background: var(--acc);
    color: var(--fg-on-accent);
    font: 700 var(--fs-sm) var(--font-ui);
  }
  .avatar.empty { background: var(--bg-input); color: var(--fg-tertiary); }
  .avatar img { width: 100%; height: 100%; object-fit: cover; }
  .presence {
    position: absolute;
    right: 3px;
    bottom: 3px;
    width: 10px;
    height: 10px;
    box-sizing: border-box;
    border: 2px solid var(--bg-sidebar);
    border-radius: 50%;
    background: var(--fg-tertiary);
  }
  .presence.on { background: var(--st-warn); }
  .presence.live { background: var(--st-ok); }
</style>
