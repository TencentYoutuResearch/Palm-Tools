<script lang="ts">
  /**
   * Kode account body, shared by Settings › Account and the standalone
   * AccountDialog. The relay lists the sign-in methods it offers; this pane
   * shows exactly those, in the relay's order, so new methods (WeChat,
   * Google) appear without reshaping the UI.
   *
   * Polls only while a QR is on screen (PalmX, or a palm handoff a phone
   * approves with Kode's own palm scan); otherwise status is read when the
   * pane opens and after each action.
   */
  import { onDestroy, onMount } from 'svelte'
  import {
    ipc,
    type CloudBackendSummary,
    type CloudSyncStatus,
    type LoginMethodInfo,
    type PalmxProgress,
  } from './ipc'
  import Icon, { type IconName } from './Icon.svelte'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import { currentLocale, t } from './i18n'

  type Props = { onSignedIn?: () => void }
  let { onSignedIn }: Props = $props()

  const RELAY_URL_KEY = 'kode.accountRelayUrl'
  /** Methods this build can run. Others the relay lists are skipped. */
  const SUPPORTED: Record<string, { icon: IconName; label: string }> = {
    palm: { icon: 'hand', label: 'pairing.account.method.palm' },
    palmx: { icon: 'smartphone', label: 'pairing.account.method.palmx' },
    email: { icon: 'mail', label: 'pairing.account.method.email' },
  }

  let status = $state<CloudSyncStatus | null>(null)
  let busy = $state(false)
  let error = $state('')
  // Last relay used here, else the machine's configured default (read at
  // startup in initialize), else empty: users enter the relay they trust.
  let relayUrl = $state(localStorage.getItem(RELAY_URL_KEY) ?? '')
  let methods = $state<LoginMethodInfo[]>([])
  let method = $state('')
  let linked = $state<string[]>([])
  let email = $state('')
  let code = $state('')
  let codeSentTo = $state('')
  let codeMinutes = $state(10)
  let palmx = $state<PalmxProgress | null>(null)
  let palmxPurpose = $state<'sign_in' | 'bind'>('sign_in')
  /** Which flow the on-screen QR belongs to. */
  let qrFlow = $state<'palmx' | 'palm'>('palmx')
  let qrDataUrl = $state('')
  let showRelay = $state(false)
  let editingName = $state(false)
  let nameDraft = $state('')
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let qrcode: typeof import('qrcode') | null = null

  let account = $derived<CloudBackendSummary | null>(
    status?.backends.find((backend) => backend.kind === 'account_relay') ?? null,
  )
  let accountActive = $derived(Boolean(account?.active))
  let usable = $derived(methods.filter((m) => m.id in SUPPORTED))
  let tr = $derived.by(() => {
    void $currentLocale
    return t
  })

  onMount(() => {
    void initialize()
  })
  onDestroy(() => {
    stopPolling()
    if (palmx) void cancelCall().catch(() => {})
  })

  function cancelCall() {
    return qrFlow === 'palm' ? ipc.cloudPalmCancel() : ipc.cloudPalmxCancel()
  }

  async function initialize() {
    qrcode = (await import('qrcode')).default
    if (!relayUrl) relayUrl = await ipc.accountDefaultRelay().catch(() => '')
    await refresh()
    if (account) {
      // Picks up a name or avatar set on a phone.
      if (account.active) status = await ipc.cloudAccountProfile().catch(() => status)
      await loadLinked()
    } else await loadMethods()
  }

  async function refresh() {
    try {
      status = await ipc.cloudSyncStatus()
    } catch (reason) {
      error = tr('pairing.statusFailed', { error: String(reason) })
    }
  }

  async function loadMethods() {
    if (!validOrigin(relayUrl)) {
      showRelay = true
      return
    }
    try {
      methods = (await ipc.cloudAccountMethods(relayUrl.trim())).methods
      if (!usable.some((m) => m.id === method)) method = usable[0]?.id ?? ''
    } catch (reason) {
      showRelay = true
      error = tr('pairing.account.failed', { error: String(reason) })
    }
  }

  async function loadLinked() {
    try {
      linked = (await ipc.cloudAccountLinked()).linked
      if (account) methods = (await ipc.cloudAccountMethods(account.server_url)).methods
    } catch {
      // An offline relay only hides the linked-methods list.
      linked = []
    }
  }

  function validOrigin(raw: string): boolean {
    try {
      const url = new URL(raw.trim())
      return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash
    } catch {
      return false
    }
  }

  async function run(action: () => Promise<void>) {
    if (busy) return
    busy = true
    error = ''
    try {
      await action()
    } catch (reason) {
      error = tr('pairing.account.failed', { error: String(reason) })
    } finally {
      busy = false
    }
  }

  function applyRelay() {
    if (!validOrigin(relayUrl)) {
      error = tr('pairing.deploy.urlInvalid')
      return
    }
    localStorage.setItem(RELAY_URL_KEY, relayUrl.trim())
    showRelay = false
    error = ''
    void loadMethods()
  }

  // ---- email ----
  function sendCode() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      error = tr('pairing.account.emailInvalid')
      return
    }
    void run(async () => {
      const sent = await ipc.cloudAccountSendCode(relayUrl.trim(), email.trim())
      codeSentTo = email.trim()
      codeMinutes = Math.max(1, Math.round(sent.expires_in / 60))
      code = ''
    })
  }

  function signInWithCode() {
    if (!code.trim()) {
      error = tr('pairing.account.codeRequired')
      return
    }
    void run(async () => {
      status = await ipc.cloudAccountSignIn(code.trim())
      codeSentTo = ''
      code = ''
      await loadLinked()
      onSignedIn?.()
    })
  }

  // ---- PalmX ----
  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = undefined
  }

  async function renderQr(payload: string) {
    qrDataUrl = qrcode
      ? await qrcode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: 240 })
      : ''
  }

  function startPalmx(purpose: 'sign_in' | 'bind') {
    void run(async () => {
      stopPolling()
      qrFlow = 'palmx'
      palmxPurpose = purpose
      if (purpose === 'sign_in') localStorage.setItem(RELAY_URL_KEY, relayUrl.trim())
      palmx = await ipc.cloudPalmxStart(purpose, purpose === 'sign_in' ? relayUrl.trim() : undefined)
      await renderQr(palmx.qr_payload)
      schedulePoll()
    })
  }

  /** Palm images are biometric data: ask before every capture, like mobile. */
  let palmConsentOpen = $state(false)

  /** Scans the palm with this Mac's camera through the relay's capture page. */
  function scanPalmHere() {
    const palm = methods.find((m) => m.id === 'palm')
    if (!palm?.app_id) return
    palmConsentOpen = false
    void run(async () => {
      cancelPalmx()
      localStorage.setItem(RELAY_URL_KEY, relayUrl.trim())
      let sdkOrigin: string | null = null
      try {
        sdkOrigin = palm.sdk_url ? new URL(palm.sdk_url).origin : null
      } catch {
        sdkOrigin = null
      }
      const result = await ipc.palmCapture(relayUrl.trim(), palm.app_id!, sdkOrigin, $currentLocale)
      if (result.code === 10002) return
      const sessionId = result.data?.sessionId
      if (result.code !== 0 || !sessionId) {
        throw new Error(palmCodeMessage(result.code, result.message ?? ''))
      }
      status = await ipc.cloudPalmSignIn(relayUrl.trim(), sessionId)
      await loadLinked()
      onSignedIn?.()
    })
  }

  function palmCodeMessage(code: number, message: string): string {
    const known: Record<number, string> = {
      10003: 'pairing.account.palm.err.camera',
      10006: 'pairing.account.palm.err.unsupported',
      10008: 'pairing.account.palm.err.timeout',
      10101: 'pairing.account.palm.err.unclear',
      10200: 'pairing.account.palm.err.noMatch',
      10500: 'pairing.account.palm.err.network',
    }
    return known[code] ? tr(known[code]) : `${code} ${message}`.trim()
  }

  // ---- profile ----
  function startRename() {
    nameDraft = account?.account_label ?? ''
    if (!status?.account_name) nameDraft = ''
    editingName = true
  }

  function saveName() {
    const name = nameDraft.trim()
    if (!name || [...name].length > 32) {
      error = tr('pairing.account.nameInvalid')
      return
    }
    void run(async () => {
      status = await ipc.cloudAccountSetName(name)
      editingName = false
    })
  }

  /** A `kode://palm-login` QR the phone app approves with a palm scan. */
  function startPalm() {
    void run(async () => {
      stopPolling()
      qrFlow = 'palm'
      palmxPurpose = 'sign_in'
      localStorage.setItem(RELAY_URL_KEY, relayUrl.trim())
      palmx = await ipc.cloudPalmStart(relayUrl.trim())
      await renderQr(palmx.qr_payload)
      schedulePoll()
    })
  }

  function schedulePoll() {
    stopPolling()
    pollTimer = setTimeout(() => void poll(), 2000)
  }

  async function poll() {
    if (!palmx) return
    try {
      const next = qrFlow === 'palm' ? await ipc.cloudPalmPoll() : await ipc.cloudPalmxPoll()
      palmx = next
      if (next.done) {
        palmx = null
        await refresh()
        await loadLinked()
        if (palmxPurpose === 'sign_in') onSignedIn?.()
        return
      }
      if (next.state === 'pending' || next.state === 'scanned') schedulePoll()
    } catch (reason) {
      palmx = null
      error = tr('pairing.account.failed', { error: String(reason) })
    }
  }

  function cancelPalmx() {
    stopPolling()
    palmx = null
    void cancelCall().catch(() => {})
  }

  // ---- signed in ----
  function unbindPalmx() {
    void run(async () => {
      await ipc.cloudPalmxUnbind()
      await loadLinked()
    })
  }

  function activate() {
    if (!account) return
    const id = account.id
    void run(async () => {
      status = await ipc.cloudSyncActivateBackend(id)
    })
  }

  function signOut() {
    if (!account) return
    const id = account.id
    void run(async () => {
      status = await ipc.cloudAccountSignOut(id)
      linked = []
      await loadMethods()
    })
  }

  function initials(label: string): string {
    const name = label.split('@')[0].trim()
    return (name.slice(0, 1) || 'K').toUpperCase()
  }

  let palmxOffered = $derived(methods.some((m) => m.id === 'palmx'))
  let palmOffered = $derived(methods.some((m) => m.id === 'palm'))
  let methodLabel = $derived(
    account?.account_method ? tr(SUPPORTED[account.account_method]?.label ?? 'pairing.account.title') : '',
  )
</script>

{#snippet palmxQr()}
  {#if palmx}
    <div class="palmx">
      <div class="qr-frame">
        {#if qrDataUrl}
          <img src={qrDataUrl} alt={tr('pairing.account.palmx.qrAlt')} width="200" height="200" />
        {:else}
          <span class="spinner" aria-hidden="true"></span>
        {/if}
      </div>
      <div class="palmx-copy">
        <strong>
          {qrFlow === 'palm'
            ? palmx.state === 'expired'
              ? tr('pairing.account.palmx.expired')
              : tr('pairing.account.palm.scan')
            : palmx.state === 'scanned'
            ? tr('pairing.account.palmx.scanned')
            : palmx.state === 'denied'
              ? tr('pairing.account.palmx.denied')
              : palmx.state === 'expired'
                ? tr('pairing.account.palmx.expired')
                : tr('pairing.account.palmx.scan')}
        </strong>
        <span>{tr(qrFlow === 'palm' ? 'pairing.account.palm.hint' : 'pairing.account.palmx.noCamera')}</span>
        <div class="row">
          {#if palmx.state === 'denied' || palmx.state === 'expired'}
            <button
              type="button"
              class="button primary"
              onclick={() => (qrFlow === 'palm' ? startPalm() : startPalmx(palmxPurpose))}
              disabled={busy}
            >
              <Icon name="refresh-cw" size={14} />{tr('pairing.account.palmx.retry')}
            </button>
          {/if}
          <button type="button" class="button secondary" onclick={cancelPalmx}>{tr('pairing.account.palmx.cancel')}</button>
        </div>
      </div>
    </div>
  {/if}
{/snippet}

<div class="pane" data-locale={$currentLocale}>
  {#if error}
    <div class="inline-error" role="alert">
      <Icon name="alert-triangle" size={15} />
      <span>{error}</span>
    </div>
  {/if}

  {#if account}
    <section class="card">
      {#if account.account_picture}
        <img class="avatar" src={account.account_picture} alt="" referrerpolicy="no-referrer" />
      {:else}
        <span class="avatar" aria-hidden="true">{initials(account.account_label ?? '')}</span>
      {/if}
      <div class="card-copy">
        {#if editingName}
          <form
            class="rename"
            onsubmit={(event) => {
              event.preventDefault()
              saveName()
            }}
          >
            <!-- svelte-ignore a11y_autofocus -->
            <input
              bind:value={nameDraft}
              maxlength="32"
              autofocus
              placeholder={tr('pairing.account.namePlaceholder')}
              aria-label={tr('pairing.account.name')}
              disabled={busy}
              onkeydown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  editingName = false
                }
              }}
            />
            <button type="submit" class="text-button" disabled={busy}>{tr('pairing.account.nameSave')}</button>
          </form>
        {:else}
          <strong>
            {account.account_label}
            {#if accountActive}
              <button type="button" class="text-button inline" onclick={startRename} title={tr('pairing.account.rename')}>
                {tr('pairing.account.rename')}
              </button>
            {/if}
          </strong>
        {/if}
        <span>{methodLabel}</span>
      </div>
      <span class="state" class:on={accountActive && status?.connected}>
        <span class="dot" aria-hidden="true"></span>
        {!accountActive
          ? tr('pairing.account.inactive')
          : status?.sync_enabled
            ? tr('pairing.account.viewing')
            : status?.connected
              ? tr('pairing.account.standby')
              : status?.last_error?.startsWith('account session expired')
                ? tr('pairing.account.expired')
                : tr('pairing.offline')}
      </span>
    </section>
    {#if !accountActive}
      <p class="hint">{tr('pairing.account.inactiveHint')}</p>
    {:else if status?.last_error && !status.connected}
      <p class="hint">{status.last_error}</p>
    {:else}
      <p class="hint">{tr('pairing.account.phoneHint')}</p>
    {/if}

    {#if palmOffered || (palmxOffered && account.account_method !== 'palmx')}
      <section class="group">
        <h3>{tr('pairing.account.linkedTitle')}</h3>
        {#if palmOffered}
          <div class="linked">
            <Icon name="hand" size={15} />
            <span class="linked-name">{tr('pairing.account.method.palm')}</span>
            {#if linked.includes('palm')}
              <span class="tag">{tr('pairing.account.palm.enrolled')}</span>
            {:else}
              <span class="muted">{tr('pairing.account.palm.enrolOnPhone')}</span>
            {/if}
          </div>
        {/if}
      </section>
    {/if}
    {#if palmxOffered && account.account_method !== 'palmx'}
      <section class="group">
        <div class="linked">
          <Icon name="hand" size={15} />
          <span class="linked-name">{tr('pairing.account.method.palmx')}</span>
          {#if linked.includes('palmx')}
            <span class="tag">{tr('pairing.account.linked')}</span>
            <button type="button" class="text-button" onclick={unbindPalmx} disabled={busy}>{tr('pairing.account.unlink')}</button>
          {:else if !palmx}
            <button type="button" class="text-button" onclick={() => startPalmx('bind')} disabled={busy}>{tr('pairing.account.link')}</button>
          {/if}
        </div>
        {@render palmxQr()}
      </section>
    {/if}

    <div class="actions">
      {#if !accountActive}
        <button type="button" class="button primary" onclick={activate} disabled={busy}>{tr('pairing.account.activate')}</button>
      {/if}
      <button type="button" class="button secondary" onclick={signOut} disabled={busy}>
        <Icon name="log-out" size={14} />{tr('pairing.account.signOut')}
      </button>
    </div>
  {:else}
    {#if usable.length > 1}
      <div class="methods" role="tablist" aria-label={tr('pairing.account.methodsLabel')}>
        {#each usable as option (option.id)}
          <button
            type="button"
            role="tab"
            aria-selected={method === option.id}
            class:active={method === option.id}
            onclick={() => {
              cancelPalmx()
              method = option.id
              error = ''
            }}
            disabled={busy}
          >
            <Icon name={SUPPORTED[option.id].icon} size={15} />
            {tr(SUPPORTED[option.id].label)}
          </button>
        {/each}
      </div>
    {/if}

    {#if method === 'palm'}
      {#if palmx}
        {@render palmxQr()}
      {:else}
        <p class="hint">{tr('pairing.account.palm.description')}</p>
        <div class="actions">
          <button type="button" class="button secondary" onclick={startPalm} disabled={busy}>
            <Icon name="smartphone" size={14} />{tr('pairing.account.palm.start')}
          </button>
          <button type="button" class="button primary" onclick={() => (palmConsentOpen = true)} disabled={busy}>
            {#if busy}<span class="spinner" aria-hidden="true"></span>{:else}<Icon name="hand" size={14} />{/if}
            {tr('pairing.account.palm.scanHere')}
          </button>
        </div>
      {/if}
    {:else if method === 'palmx'}
      {#if palmx}
        {@render palmxQr()}
      {:else}
        <p class="hint">{tr('pairing.account.palmx.description')}</p>
        <div class="actions">
          <button type="button" class="button primary" onclick={() => startPalmx('sign_in')} disabled={busy}>
            {#if busy}<span class="spinner" aria-hidden="true"></span>{:else}<Icon name="hand" size={14} />{/if}
            {tr('pairing.account.palmx.start')}
          </button>
        </div>
      {/if}
    {:else if method === 'email'}
      <form
        class="form"
        novalidate
        onsubmit={(event) => {
          event.preventDefault()
          if (codeSentTo) signInWithCode()
          else sendCode()
        }}
      >
        <label class="field">
          <span>{tr('pairing.account.email')}</span>
          <input type="email" bind:value={email} autocomplete="email" spellcheck="false" disabled={busy || Boolean(codeSentTo)} />
        </label>
        {#if codeSentTo}
          <label class="field">
            <span>{tr('pairing.account.code')}</span>
            <input type="text" inputmode="numeric" bind:value={code} autocomplete="one-time-code" disabled={busy} />
            <small>{tr('pairing.account.codeSent', { email: codeSentTo, minutes: codeMinutes })}</small>
          </label>
        {/if}
        <div class="actions">
          {#if codeSentTo}
            <button type="button" class="button secondary" onclick={() => (codeSentTo = '')} disabled={busy}>{tr('pairing.account.resendCode')}</button>
          {/if}
          <button type="submit" class="button primary" disabled={busy} aria-busy={busy}>
            {#if busy}<span class="spinner" aria-hidden="true"></span>{/if}
            {codeSentTo ? tr('pairing.account.signIn') : tr('pairing.account.sendCode')}
          </button>
        </div>
      </form>
    {/if}

    <div class="relay">
      {#if showRelay}
        <label class="field">
          <span>{tr('pairing.account.relayUrl')}</span>
          <input type="url" bind:value={relayUrl} autocomplete="off" spellcheck="false" disabled={busy} />
          <small>{tr('pairing.account.relayHint')}</small>
        </label>
        <div class="actions">
          <button type="button" class="button secondary" onclick={applyRelay} disabled={busy}>{tr('pairing.account.relayApply')}</button>
        </div>
      {:else}
        <button type="button" class="text-button" onclick={() => (showRelay = true)}>
          <Icon name="server" size={13} />{tr('pairing.account.relayChange')}
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .pane { display: grid; gap: var(--sp-3); color: var(--fg-primary); font: var(--fs-md) var(--font-ui); }
  h3 { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); font-weight: 600; color: var(--fg-secondary); }
  .card { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3); border: 1px solid var(--bd-default); border-radius: var(--rad-md); background: var(--bg-input); }
  .avatar { display: grid; width: 36px; height: 36px; flex: 0 0 auto; place-items: center; border-radius: var(--rad-sm); background: var(--acc); color: var(--fg-on-accent); font-weight: 700; object-fit: cover; }
  .rename { display: flex; gap: var(--sp-2); align-items: center; }
  .rename input { min-width: 0; flex: 1; height: 26px; border: 1px solid var(--bd-default); border-radius: var(--rad-sm); background: var(--bg-elevated); padding: 0 var(--sp-2); color: var(--fg-primary); font: var(--fs-sm) var(--font-ui); outline: none; }
  .rename input:focus-visible { border-color: var(--acc); }
  .text-button.inline { margin-left: var(--sp-2); font-size: var(--fs-xs); font-weight: 400; }
  .card-copy { display: grid; min-width: 0; flex: 1; gap: 2px; }
  .card-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-copy span { color: var(--fg-tertiary); font-size: var(--fs-xs); }
  .state { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-tertiary); font-size: var(--fs-xs); white-space: nowrap; }
  .state.on { color: var(--st-ok); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .hint { margin: 0; color: var(--fg-secondary); font-size: var(--fs-sm); line-height: 1.5; }
  .group { display: grid; gap: var(--sp-2); }
  .linked { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--bd-default); border-radius: var(--rad-sm); }
  .linked-name { flex: 1; }
  .muted { color: var(--fg-tertiary); font-size: var(--fs-xs); }
  .tag { padding: 1px 6px; border-radius: 999px; background: color-mix(in srgb, var(--st-ok) 16%, transparent); color: var(--st-ok); font-size: var(--fs-xs); }
  .methods { display: flex; gap: 4px; padding: 3px; border: 1px solid var(--bd-default); border-radius: var(--rad-md); background: var(--bg-input); width: fit-content; }
  .methods button { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 var(--sp-3); border: 0; border-radius: var(--rad-sm); background: transparent; color: var(--fg-secondary); font: var(--fs-sm) var(--font-ui); cursor: pointer; }
  .methods button.active { background: var(--bg-elevated); color: var(--fg-primary); box-shadow: 0 1px 2px rgb(0 0 0 / 0.12); }
  .palmx { display: flex; gap: var(--sp-4); align-items: center; }
  .qr-frame { display: grid; width: 216px; height: 216px; flex: 0 0 auto; place-items: center; border-radius: var(--rad-md); background: #fff; }
  .palmx-copy { display: grid; gap: var(--sp-2); }
  .palmx-copy span { color: var(--fg-secondary); font-size: var(--fs-sm); line-height: 1.5; }
  .row, .actions { display: flex; gap: var(--sp-2); }
  .actions { justify-content: flex-end; }
  .form { display: grid; gap: var(--sp-3); max-width: 420px; }
  .field { display: grid; gap: 5px; }
  .field span { color: var(--fg-secondary); font-size: var(--fs-xs); font-weight: 600; }
  .field small { color: var(--fg-tertiary); font-size: var(--fs-xs); }
  .field input { box-sizing: border-box; height: 34px; border: 1px solid var(--bd-default); border-radius: var(--rad-sm); background: var(--bg-input); padding: 0 var(--sp-2); color: var(--fg-primary); font: var(--fs-sm) var(--font-ui); outline: none; }
  .field input:focus-visible { border-color: var(--acc); }
  .relay { display: grid; gap: var(--sp-2); padding-top: var(--sp-2); border-top: 1px solid var(--bd-default); }
  .inline-error { display: flex; gap: var(--sp-2); border-left: 3px solid var(--st-err); padding: var(--sp-2) var(--sp-3); background: var(--bg-input); color: var(--st-err); font-size: var(--fs-sm); overflow-wrap: anywhere; }
  .button { display: inline-flex; height: 32px; align-items: center; gap: 6px; border-radius: var(--rad-sm); padding: 0 var(--sp-3); font: var(--fs-sm) var(--font-ui); cursor: pointer; }
  .button:disabled { opacity: 0.55; cursor: default; }
  .button.primary { border: 1px solid var(--acc); background: var(--acc); color: var(--fg-on-accent); }
  .button.secondary { border: 1px solid var(--bd-default); background: var(--bg-input); color: var(--fg-secondary); }
  .text-button { display: inline-flex; width: fit-content; align-items: center; gap: 6px; border: 0; background: transparent; padding: 0; color: var(--fg-secondary); font: var(--fs-sm) var(--font-ui); cursor: pointer; }
  .text-button:hover:not(:disabled) { color: var(--acc); }
  .spinner { width: 13px; height: 13px; box-sizing: border-box; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 700ms linear infinite; }
  .qr-frame .spinner { color: #555; width: 20px; height: 20px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>

{#if palmConsentOpen}
  <ConfirmDialog
    title={tr('pairing.account.palm.consent.title')}
    message={tr('pairing.account.palm.consent.body')}
    confirmLabel={tr('pairing.account.palm.consent.agree')}
    cancelLabel={tr('pairing.account.palm.consent.cancel')}
    onConfirm={scanPalmHere}
    onClose={() => (palmConsentOpen = false)}
  />
{/if}
