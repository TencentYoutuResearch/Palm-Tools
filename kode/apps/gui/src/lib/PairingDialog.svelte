<script lang="ts">
  /** Cloud relay deployment, backend selection, and one-time mobile pairing. */
  import { listen, type UnlistenFn } from '@tauri-apps/api/event'
  import { onDestroy, onMount } from 'svelte'
  import {
    ipc,
    type CloudBackendSummary,
    type CloudDeployProgress,
    type CloudPairingPayload,
    type CloudSyncStatus,
  } from './ipc'
  import Icon from './Icon.svelte'
  import { currentLocale, t } from './i18n'
  import { outsidePressClose } from './outside_close'

  type Props = { onClose: () => void }
  type View = 'pair' | 'deploy'
  type DeployMode = 'ssh' | 'existing'
  type SshDeployKind = 'standalone' | 'docker'
  type BusyKind = '' | 'pairing' | 'switching' | 'deploying'
  type StepStatus = 'pending' | 'running' | 'done' | 'failed'

  let { onClose }: Props = $props()

  const DEPLOY_STEPS = [
    'CheckingHost',
    'Uploading',
    'StoppingOld',
    'Extracting',
    'StartingNew',
    'LocalHealth',
    'PublicHealth',
    'SavingBackend',
    'Done',
  ] as const

  let status = $state<CloudSyncStatus | null>(null)
  let pairing = $state<CloudPairingPayload | null>(null)
  let view = $state<View>('pair')
  let deployMode = $state<DeployMode>('ssh')
  let sshDeployKind = $state<SshDeployKind>('standalone')
  let redeployBackendId = $state('')
  let selectedBackendId = $state('')
  let busy = $state<BusyKind>('')
  let error = $state('')
  let copied = $state(false)
  let qrDataUrl = $state('')
  let now = $state(Date.now())
  let backendName = $state('')
  let sshHost = $state('')
  let sshPort = $state('22')
  let remotePort = $state('8787')
  let publicUrl = $state('')
  let remoteDeployDir = $state('')
  let existingUrl = $state('')
  let deploySteps = $state(
    DEPLOY_STEPS.map((step) => ({ step, status: 'pending' as StepStatus })),
  )
  let dialogEl: HTMLDivElement
  let sshHostInput = $state<HTMLInputElement | null>(null)
  let publicUrlInput = $state<HTMLInputElement | null>(null)
  let remoteDeployDirInput = $state<HTMLInputElement | null>(null)
  let existingUrlInput = $state<HTMLInputElement | null>(null)
  let qrcode: typeof import('qrcode') | null = null
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let unlistenProgress: UnlistenFn | null = null

  let expiresIn = $derived(
    pairing ? Math.max(0, Math.ceil((pairing.expires_at - now) / 1000)) : 0,
  )
  let redeployingCurrent = $derived(Boolean(redeployBackendId))
  let activeBackend = $derived<CloudBackendSummary | null>(
    status?.backends.find((backend) => backend.id === status?.active_backend_id) ?? null,
  )
  let tr = $derived.by(() => {
    void $currentLocale
    return t
  })

  onMount(() => {
    void initialize()
  })

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer)
    unlistenProgress?.()
  })

  $effect(() => {
    const uri = pairing?.uri ?? ''
    if (!uri || !qrcode) {
      qrDataUrl = ''
      return
    }
    qrcode
      .toDataURL(uri, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 280,
        color: { dark: '#000000', light: '#ffffff' },
      })
      .then((url) => (qrDataUrl = url))
      .catch((reason) => (error = tr('pairing.qrFailed', { error: String(reason) })))
  })

  async function initialize() {
    try {
      qrcode = (await import('qrcode')).default
      unlistenProgress = await listen<CloudDeployProgress>(
        'cloud-deploy-progress',
        (event) => {
          const next = event.payload
          const index = deploySteps.findIndex((step) => step.step === next.step)
          if (index < 0) return
          deploySteps[index] = {
            step: next.step as (typeof DEPLOY_STEPS)[number],
            status: next.status,
          }
          deploySteps = [...deploySteps]
        },
      )
      await refreshStatus()
      if ((status?.backends.length ?? 0) > 0) {
        view = 'pair'
        await createPairing(status?.server_url ?? '')
      } else {
        view = 'deploy'
        queueMicrotask(() => sshHostInput?.focus())
      }
      pollTimer = setInterval(() => {
        now = Date.now()
        void refreshStatus(false)
      }, 1000)
    } catch (reason) {
      error = tr('pairing.statusFailed', { error: String(reason) })
    }
  }

  async function refreshStatus(showError = true) {
    try {
      const next = await ipc.cloudSyncStatus()
      status = next
      selectedBackendId = next.active_backend_id ?? selectedBackendId
    } catch (reason) {
      if (showError) error = tr('pairing.statusFailed', { error: String(reason) })
    }
  }

  async function createPairing(targetUrl = activeBackend?.server_url ?? '') {
    if (!targetUrl || busy) return
    busy = 'pairing'
    error = ''
    pairing = null
    try {
      pairing = await ipc.cloudSyncCreatePairing(targetUrl)
      now = Date.now()
      await refreshStatus()
    } catch (reason) {
      error = tr('pairing.createFailed', { error: String(reason) })
    } finally {
      busy = ''
    }
  }

  async function switchBackend(backendId: string) {
    if (!backendId || backendId === status?.active_backend_id || busy) return
    busy = 'switching'
    error = ''
    pairing = null
    try {
      status = await ipc.cloudSyncActivateBackend(backendId)
      selectedBackendId = backendId
      busy = ''
      await createPairing(status.server_url)
    } catch (reason) {
      error = tr('pairing.switchFailed', { error: String(reason) })
      busy = ''
    }
  }

  function resetDeploySteps() {
    deploySteps = DEPLOY_STEPS.map((step) => ({ step, status: 'pending' }))
  }

  function validatePort(raw: string): number | null {
    const port = Number(raw)
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
  }

  function validHttpsOrigin(raw: string): boolean {
    try {
      const url = new URL(raw.trim())
      return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash
    } catch {
      return false
    }
  }

  function hostFromOrigin(raw: string): string {
    try {
      return new URL(raw).hostname
    } catch {
      return ''
    }
  }

  async function deployBackend() {
    if (busy) return
    const sshPortValue = validatePort(sshPort)
    const remotePortValue = validatePort(remotePort)
    if (!sshHost.trim()) {
      error = tr('pairing.deploy.hostRequired')
      sshHostInput?.focus()
      return
    }
    if (!sshPortValue || !remotePortValue) {
      error = tr('pairing.deploy.portInvalid')
      return
    }
    if (sshDeployKind === 'docker' && !remoteDeployDir.trim()) {
      error = tr('pairing.deploy.remoteDirRequired')
      remoteDeployDirInput?.focus()
      return
    }
    if (!validHttpsOrigin(publicUrl)) {
      error = tr('pairing.deploy.urlInvalid')
      publicUrlInput?.focus()
      return
    }

    busy = 'deploying'
    error = ''
    pairing = null
    resetDeploySteps()
    try {
      const result = await ipc.cloudSyncDeploy({
        name: backendName.trim(),
        ssh_host: sshHost.trim(),
        ssh_port: sshPortValue,
        remote_port: remotePortValue,
        server_url: publicUrl.trim(),
        deployment_kind: sshDeployKind,
        remote_deploy_dir: sshDeployKind === 'docker' ? remoteDeployDir.trim() : null,
      })
      await refreshStatus()
      selectedBackendId = result.backend.id
      redeployBackendId = ''
      view = 'pair'
      busy = ''
      await createPairing(result.backend.server_url)
    } catch (reason) {
      error = tr('pairing.deploy.failed', { error: String(reason) })
      busy = ''
    }
  }

  async function connectExisting() {
    if (busy) return
    if (!validHttpsOrigin(existingUrl)) {
      error = tr('pairing.deploy.urlInvalid')
      existingUrlInput?.focus()
      return
    }
    await createPairing(existingUrl.trim())
    if (pairing) {
      await refreshStatus()
      view = 'pair'
    }
  }

  async function copyUri() {
    if (!pairing || copied) return
    try {
      await navigator.clipboard.writeText(pairing.uri)
      copied = true
      setTimeout(() => (copied = false), 1200)
    } catch (reason) {
      error = tr('pairing.copyFailed', { error: String(reason) })
    }
  }

  function showDeploy() {
    if (busy) return
    redeployBackendId = ''
    deployMode = 'ssh'
    sshDeployKind = 'standalone'
    backendName = ''
    sshHost = ''
    sshPort = '22'
    remotePort = '8787'
    publicUrl = ''
    remoteDeployDir = ''
    resetDeploySteps()
    view = 'deploy'
    pairing = null
    error = ''
    queueMicrotask(() => sshHostInput?.focus())
  }

  function showRedeploy(backend: CloudBackendSummary) {
    if (busy) return
    redeployBackendId = backend.id
    deployMode = 'ssh'
    sshDeployKind = backend.deployment_kind === 'standalone' ? 'standalone' : 'docker'
    backendName = backend.name
    sshHost = backend.ssh_host ?? hostFromOrigin(backend.server_url)
    sshPort = String(backend.ssh_port ?? 22)
    remotePort = String(backend.remote_port ?? 8787)
    publicUrl = backend.server_url
    remoteDeployDir =
      backend.remote_deploy_dir ?? '~/kode-sync-server-0.2.2-dev-linux-amd64'
    resetDeploySteps()
    view = 'deploy'
    pairing = null
    error = ''
    queueMicrotask(() => sshHostInput?.focus())
  }

  function showPair() {
    if (busy || !activeBackend) return
    redeployBackendId = ''
    view = 'pair'
    error = ''
    if (!pairing) void createPairing(activeBackend.server_url)
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (!busy) onClose()
      return
    }
    if (event.key !== 'Tab' || !dialogEl) return
    const focusable = Array.from(
      dialogEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div
  class="backdrop"
  use:outsidePressClose={{ onClose, disabled: Boolean(busy) }}
  role="presentation"
>
  <div
    bind:this={dialogEl}
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="cloud-relay-title"
    aria-describedby="cloud-relay-description"
  >
    <header>
      <div class="title-lockup">
        <span class="eyebrow">{tr('pairing.eyebrow')}</span>
        <h2 id="cloud-relay-title">{tr('pairing.relayTitle')}</h2>
      </div>
      <button
        type="button"
        class="icon-button"
        onclick={onClose}
        disabled={Boolean(busy)}
        aria-label={tr('pairing.close')}
      >
        <Icon name="x" />
      </button>
    </header>

    <div class="body">
      <p id="cloud-relay-description" class="intro">
        {view === 'pair'
          ? tr('pairing.readyDescription')
          : redeployingCurrent
            ? tr('pairing.deploy.redeployDescription')
            : tr('pairing.deploy.description')}
      </p>

      {#if error}
        <div id="cloud-relay-error" class="inline-error" role="alert">
          <Icon name="alert-triangle" size={15} />
          <span>{error}</span>
        </div>
      {/if}

      {#if view === 'pair' && activeBackend}
        <section class="backend-bar" aria-label={tr('pairing.backendLabel')}>
          <span class="backend-mark"><Icon name="server" size={16} /></span>
          <div class="backend-copy">
            <span class="label">{tr('pairing.backendLabel')}</span>
            <select
              aria-label={tr('pairing.switchBackend')}
              value={selectedBackendId}
              onchange={(event) =>
                void switchBackend((event.currentTarget as HTMLSelectElement).value)}
              disabled={Boolean(busy)}
            >
              {#each status?.backends ?? [] as backend (backend.id)}
                <option value={backend.id}>{backend.name}</option>
              {/each}
            </select>
            <code>{activeBackend.server_url}</code>
          </div>
          <div class="backend-state" class:online={status?.connected}>
            <span class="state-dot" aria-hidden="true"></span>
            <span>
              {busy === 'switching'
                ? tr('pairing.switching')
                : status?.connected
                  ? tr('pairing.online')
                  : tr('pairing.offline')}
            </span>
          </div>
        </section>

        <div class="pair-layout">
          <section class="pair-copy">
            <div class="section-heading">
              <span class="step-number">01</span>
              <div>
                <h3>{tr('pairing.scanTitle')}</h3>
                <p>{tr('pairing.scanHint')}</p>
              </div>
            </div>

            <div class="permission-list" aria-label={tr('pairing.permissions')}>
              <span><Icon name="eye" size={14} /> {tr('pairing.readSessions')}</span>
              <span><Icon name="terminal" size={14} /> {tr('pairing.sendMessages')}</span>
            </div>

            {#if status?.sync_enabled}
              <div class="sync-state success" role="status">
                <Icon name="check" size={15} />
                <div>
                  <strong>{tr('pairing.connected')}</strong>
                  <span>{tr('pairing.connectedHint', { count: status.binding_count })}</span>
                </div>
              </div>
            {:else}
              <div class="sync-state waiting" role="status">
                <span class="state-dot" aria-hidden="true"></span>
                <div>
                  <strong>{tr('pairing.waiting')}</strong>
                  <span>{tr('pairing.waitingHint')}</span>
                </div>
              </div>
            {/if}

            <div class="backend-actions">
              <button
                type="button"
                class="text-button"
                onclick={() => showRedeploy(activeBackend)}
                disabled={Boolean(busy)}
              >
                <Icon name="refresh-cw" size={13} />
                {tr('pairing.redeployCurrent')}
              </button>
              <button type="button" class="text-button" onclick={showDeploy} disabled={Boolean(busy)}>
                <Icon name="plus" size={13} />
                {tr('pairing.deployAnother')}
              </button>
            </div>
          </section>

          <section class="qr-column" aria-label={tr('pairing.scanTitle')}>
            <div class="qr-frame" class:loading={!qrDataUrl}>
              {#if qrDataUrl}
                <img src={qrDataUrl} alt={tr('pairing.qrAlt')} width="280" height="280" />
              {:else}
                <div class="qr-placeholder" aria-label={tr('pairing.qrLoading')}>
                  <span class="spinner dark" aria-hidden="true"></span>
                </div>
              {/if}
            </div>
            <div class="qr-meta">
              <span class:expired={expiresIn === 0}>
                {expiresIn > 0
                  ? tr('pairing.expiresIn', { seconds: expiresIn })
                  : tr('pairing.expired')}
              </span>
              {#if pairing}<code>{pairing.pairing_id}</code>{/if}
            </div>
            <div class="qr-actions">
              <button
                type="button"
                class="button secondary"
                onclick={copyUri}
                disabled={!pairing || copied || Boolean(busy)}
              >
                <Icon name={copied ? 'check' : 'copy'} size={14} />
                {copied ? tr('pairing.copied') : tr('pairing.copyUri')}
              </button>
              <button
                type="button"
                class="button primary"
                onclick={() => void createPairing(activeBackend.server_url)}
                disabled={Boolean(busy)}
                aria-busy={busy === 'pairing'}
              >
                {#if busy === 'pairing'}
                  <span class="spinner" aria-hidden="true"></span>
                {:else}
                  <Icon name="refresh-cw" size={14} />
                {/if}
                {tr('pairing.refreshCode')}
              </button>
            </div>
          </section>
        </div>
      {:else if view === 'deploy'}
        <div class="deploy-mode" aria-label={tr('pairing.deploy.modeLabel')}>
          <button
            type="button"
            class:active={deployMode === 'ssh'}
            aria-pressed={deployMode === 'ssh'}
            onclick={() => (deployMode = 'ssh')}
            disabled={Boolean(busy)}
          >
            <Icon name="terminal" size={14} /> {tr('pairing.deploy.modeSsh')}
          </button>
          <button
            type="button"
            class:active={deployMode === 'existing'}
            aria-pressed={deployMode === 'existing'}
            onclick={() => (deployMode = 'existing')}
            disabled={Boolean(busy)}
          >
            <Icon name="link" size={14} /> {tr('pairing.deploy.modeExisting')}
          </button>
        </div>

        {#if deployMode === 'ssh'}
          <div class="deploy-layout">
            <form
              class="deploy-form"
              novalidate
              onsubmit={(event) => {
                event.preventDefault()
                void deployBackend()
              }}
            >
              <div class="field">
                <span class="field-label">{tr('pairing.deploy.installType')}</span>
                <div class="deploy-kind" aria-label={tr('pairing.deploy.installType')}>
                  <button
                    type="button"
                    class:active={sshDeployKind === 'standalone'}
                    aria-pressed={sshDeployKind === 'standalone'}
                    onclick={() => (sshDeployKind = 'standalone')}
                    disabled={Boolean(busy)}
                  >{tr('pairing.deploy.installStandalone')}</button>
                  <button
                    type="button"
                    class:active={sshDeployKind === 'docker'}
                    aria-pressed={sshDeployKind === 'docker'}
                    onclick={() => (sshDeployKind = 'docker')}
                    disabled={Boolean(busy)}
                  >{tr('pairing.deploy.installDocker')}</button>
                </div>
              </div>

              <div class="field">
                <label for="cloud-backend-name">{tr('pairing.deploy.name')}</label>
                <input
                  id="cloud-backend-name"
                  type="text"
                  bind:value={backendName}
                  placeholder={tr('pairing.deploy.namePlaceholder')}
                  autocomplete="off"
                  spellcheck="false"
                  disabled={Boolean(busy)}
                />
              </div>

              <div class="field">
                <label for="cloud-ssh-host">{tr('pairing.deploy.sshHost')}</label>
                <input
                  id="cloud-ssh-host"
                  bind:this={sshHostInput}
                  type="text"
                  bind:value={sshHost}
                  placeholder="user@host"
                  autocomplete="off"
                  autocapitalize="none"
                  spellcheck="false"
                  disabled={Boolean(busy)}
                  aria-invalid={error === tr('pairing.deploy.hostRequired') ? 'true' : 'false'}
                  aria-describedby="cloud-ssh-host-hint"
                />
                <p id="cloud-ssh-host-hint">{tr('pairing.deploy.sshHint')}</p>
              </div>

              <div class="field-row">
                <div class="field">
                  <label for="cloud-ssh-port">{tr('pairing.deploy.sshPort')}</label>
                  <input
                    id="cloud-ssh-port"
                    type="text"
                    inputmode="numeric"
                    bind:value={sshPort}
                    autocomplete="off"
                    disabled={Boolean(busy)}
                  />
                </div>
                {#if sshDeployKind === 'standalone'}
                <div class="field">
                  <label for="cloud-service-port">{tr('pairing.deploy.servicePort')}</label>
                  <input
                    id="cloud-service-port"
                    type="text"
                    inputmode="numeric"
                    bind:value={remotePort}
                    autocomplete="off"
                    disabled={Boolean(busy)}
                  />
                </div>
                {/if}
              </div>

              {#if sshDeployKind === 'docker'}
                <div class="field">
                  <label for="cloud-remote-deploy-dir">{tr('pairing.deploy.remoteDir')}</label>
                  <input
                    id="cloud-remote-deploy-dir"
                    bind:this={remoteDeployDirInput}
                    type="text"
                    bind:value={remoteDeployDir}
                    placeholder="~/kode-sync-server-0.2.2-dev-linux-amd64"
                    autocomplete="off"
                    autocapitalize="none"
                    spellcheck="false"
                    disabled={Boolean(busy)}
                  />
                  <p>{tr('pairing.deploy.remoteDirHint')}</p>
                </div>
              {/if}

              <div class="field">
                <label for="cloud-public-url">{tr('pairing.deploy.publicUrl')}</label>
                <input
                  id="cloud-public-url"
                  bind:this={publicUrlInput}
                  type="url"
                  bind:value={publicUrl}
                  placeholder="https://sync.example.com"
                  autocomplete="url"
                  autocapitalize="none"
                  spellcheck="false"
                  disabled={Boolean(busy)}
                  aria-describedby="cloud-public-url-hint"
                />
                <p id="cloud-public-url-hint">{tr('pairing.deploy.publicHint')}</p>
              </div>

              <div class="ingress-note">
                <Icon name="lock" size={14} />
                <span>{sshDeployKind === 'docker'
                  ? tr('pairing.deploy.dockerNote')
                  : tr('pairing.deploy.ingressNote', { port: remotePort || '8787' })}</span>
              </div>

              <div class="form-actions">
                {#if activeBackend}
                  <button type="button" class="button secondary" onclick={showPair} disabled={Boolean(busy)}>
                    {tr('pairing.backToQr')}
                  </button>
                {:else}
                  <button type="button" class="button secondary" onclick={onClose} disabled={Boolean(busy)}>
                    {tr('memory.common.close')}
                  </button>
                {/if}
                <button
                  type="submit"
                  class="button primary"
                  disabled={Boolean(busy)}
                  aria-busy={busy === 'deploying'}
                >
                  {#if busy === 'deploying'}
                    <span class="spinner" aria-hidden="true"></span>
                    {tr('pairing.deploy.deploying')}
                  {:else}
                    <Icon name={redeployingCurrent ? 'refresh-cw' : 'server'} size={14} />
                    {redeployingCurrent
                      ? tr('pairing.deploy.redeployAction')
                      : tr('pairing.deploy.action')}
                  {/if}
                </button>
              </div>
            </form>

            <section class="deployment-rail" aria-label={tr('pairing.deploy.progress')}>
              <span class="label">{tr('pairing.deploy.progress')}</span>
              <ol>
                {#each deploySteps as item, index (item.step)}
                  <li class={item.status}>
                    <span class="rail-marker" aria-hidden="true">
                      {#if item.status === 'done'}
                        <Icon name="check" size={12} />
                      {:else if item.status === 'failed'}
                        <Icon name="x" size={12} />
                      {:else if item.status === 'running'}
                        <span class="spinner tiny"></span>
                      {:else}
                        {String(index + 1).padStart(2, '0')}
                      {/if}
                    </span>
                    <span>{tr(`pairing.deploy.step.${item.step}`)}</span>
                  </li>
                {/each}
              </ol>
            </section>
          </div>
        {:else}
          <form
            class="existing-form"
            novalidate
            onsubmit={(event) => {
              event.preventDefault()
              void connectExisting()
            }}
          >
            <div class="existing-mark"><Icon name="link" size={22} /></div>
            <div>
              <h3>{tr('pairing.deploy.existingTitle')}</h3>
              <p>{tr('pairing.deploy.existingHint')}</p>
            </div>
            <div class="field">
              <label for="cloud-existing-url">{tr('pairing.serverUrl')}</label>
              <input
                id="cloud-existing-url"
                bind:this={existingUrlInput}
                type="url"
                bind:value={existingUrl}
                placeholder="https://sync.example.com"
                autocomplete="url"
                autocapitalize="none"
                spellcheck="false"
                disabled={Boolean(busy)}
              />
            </div>
            <div class="form-actions">
              {#if activeBackend}
                <button type="button" class="button secondary" onclick={showPair} disabled={Boolean(busy)}>
                  {tr('pairing.backToQr')}
                </button>
              {/if}
              <button type="submit" class="button primary" disabled={Boolean(busy)}>
                {#if busy === 'pairing'}<span class="spinner" aria-hidden="true"></span>{/if}
                {tr('pairing.deploy.connectExisting')}
              </button>
            </div>
          </form>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--sp-4);
    background: var(--bg-modal-backdrop);
    backdrop-filter: var(--blur-modal);
    -webkit-backdrop-filter: var(--blur-modal);
  }
  .dialog {
    display: flex;
    width: min(760px, 96vw);
    max-height: min(780px, calc(100vh - 32px));
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-lg);
    background: var(--bg-elevated);
    box-shadow: var(--sh-modal);
    color: var(--fg-primary);
    font: var(--fs-md) var(--font-ui);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--bd-default);
  }
  .title-lockup { min-width: 0; }
  .eyebrow,
  .label {
    color: var(--fg-tertiary);
    font: var(--fs-xs) var(--font-mono);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  h2 {
    margin: 2px 0 0;
    font-size: var(--fs-lg);
    font-weight: 600;
  }
  h3 {
    margin: 0;
    font-size: var(--fs-md);
    font-weight: 600;
  }
  p { margin: 0; }
  .icon-button {
    display: grid;
    width: 30px;
    height: 30px;
    place-items: center;
    border: 0;
    border-radius: var(--rad-sm);
    background: transparent;
    color: var(--fg-secondary);
    cursor: pointer;
  }
  .icon-button:hover:not(:disabled) { background: var(--bg-tab-hover); color: var(--fg-primary); }
  .body {
    min-height: 0;
    overflow-y: auto;
    padding: var(--sp-4);
    scrollbar-gutter: stable;
  }
  .intro {
    margin-bottom: var(--sp-3);
    color: var(--fg-secondary);
    line-height: 1.5;
  }
  .inline-error {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
    margin-bottom: var(--sp-3);
    border-left: 3px solid var(--st-err);
    background: color-mix(in srgb, var(--st-err) 7%, var(--bg-input));
    padding: var(--sp-2) var(--sp-3);
    color: var(--st-err);
    font-size: var(--fs-xs);
    overflow-wrap: anywhere;
  }
  .backend-bar {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--sp-3);
    margin-bottom: var(--sp-4);
    border-block: 1px solid var(--bd-default);
    padding: var(--sp-3) 0;
  }
  .backend-mark,
  .existing-mark {
    display: grid;
    width: 34px;
    height: 34px;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--acc) 45%, var(--bd-default));
    border-radius: var(--rad-md);
    color: var(--acc);
  }
  .backend-copy { display: grid; min-width: 0; gap: 2px; }
  .backend-copy select {
    width: fit-content;
    max-width: 100%;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--fg-primary);
    font: 600 var(--fs-sm) var(--font-ui);
    cursor: pointer;
  }
  .backend-copy select:focus-visible { box-shadow: 0 0 0 2px var(--acc); }
  .backend-copy code,
  .qr-meta code {
    overflow: hidden;
    color: var(--fg-tertiary);
    font: var(--fs-xs) var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .backend-state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
  }
  .backend-state.online { color: var(--st-ok); }
  .state-dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: currentColor; }
  .pair-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    gap: var(--sp-5);
    align-items: start;
  }
  .pair-copy { display: flex; min-width: 0; flex-direction: column; gap: var(--sp-4); }
  .section-heading { display: flex; align-items: flex-start; gap: var(--sp-3); }
  .section-heading p { margin-top: 4px; color: var(--fg-secondary); font-size: var(--fs-sm); line-height: 1.45; }
  .step-number { color: var(--acc); font: 600 var(--fs-sm) var(--font-mono); }
  .permission-list { display: grid; gap: var(--sp-2); }
  .permission-list span { display: flex; align-items: center; gap: var(--sp-2); color: var(--fg-secondary); font-size: var(--fs-sm); }
  .sync-state { display: flex; align-items: flex-start; gap: var(--sp-2); border-left: 3px solid currentColor; padding: var(--sp-2) var(--sp-3); background: var(--bg-input); }
  .sync-state.success { color: var(--st-ok); }
  .sync-state.waiting { color: var(--st-warn); }
  .sync-state div { display: grid; gap: 2px; }
  .sync-state span { color: var(--fg-secondary); font-size: var(--fs-xs); line-height: 1.4; }
  .text-button { display: inline-flex; width: fit-content; align-items: center; gap: 6px; border: 0; background: transparent; padding: 0; color: var(--fg-secondary); font: var(--fs-sm) var(--font-ui); cursor: pointer; }
  .text-button:hover:not(:disabled) { color: var(--acc); }
  .backend-actions { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
  .qr-column { display: flex; flex-direction: column; gap: var(--sp-2); }
  .qr-frame { display: grid; width: 100%; aspect-ratio: 1; place-items: center; border-radius: var(--rad-md); background: #fff; padding: var(--sp-2); }
  .qr-frame.loading { background: color-mix(in srgb, #fff 88%, var(--fg-tertiary)); }
  .qr-frame img,
  .qr-placeholder { width: 100%; height: 100%; }
  .qr-placeholder { display: grid; place-items: center; color: #202522; }
  .qr-meta { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: var(--sp-2); color: var(--fg-tertiary); font-size: var(--fs-xs); }
  .qr-meta code { max-width: 150px; }
  .expired { color: var(--st-err); }
  .qr-actions,
  .form-actions { display: flex; justify-content: flex-end; gap: var(--sp-2); }
  .button,
  .deploy-mode button,
  .deploy-kind button {
    display: inline-flex;
    min-height: 34px;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border-radius: var(--rad-sm);
    padding: 0 var(--sp-3);
    font: 600 var(--fs-sm) var(--font-ui);
    cursor: pointer;
  }
  .button.primary { border: 1px solid var(--acc); background: var(--acc); color: var(--fg-on-accent); }
  .button.primary:hover:not(:disabled) { filter: brightness(1.05); }
  .button.secondary { border: 1px solid var(--bd-default); background: var(--bg-input); color: var(--fg-secondary); }
  .button.secondary:hover:not(:disabled) { border-color: var(--bd-strong); color: var(--fg-primary); }
  button:focus-visible,
  select:focus-visible,
  input:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; }
  button:disabled,
  select:disabled,
  input:disabled { cursor: not-allowed; opacity: 0.55; }
  .deploy-mode { display: flex; width: fit-content; gap: 2px; margin-bottom: var(--sp-4); border: 1px solid var(--bd-default); border-radius: var(--rad-md); padding: 2px; background: var(--bg-input); }
  .deploy-mode button { min-height: 30px; border: 0; background: transparent; color: var(--fg-tertiary); }
  .deploy-mode button.active { background: var(--bg-elevated); color: var(--fg-primary); box-shadow: inset 0 0 0 1px var(--bd-default); }
  .field-label,
  .field label { color: var(--fg-secondary); font-size: var(--fs-xs); font-weight: 600; }
  .deploy-kind { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; border: 1px solid var(--bd-default); border-radius: var(--rad-md); padding: 2px; background: var(--bg-input); }
  .deploy-kind button { min-height: 30px; border: 0; background: transparent; color: var(--fg-tertiary); }
  .deploy-kind button.active { background: var(--bg-elevated); color: var(--fg-primary); box-shadow: inset 0 0 0 1px var(--bd-default); }
  .deploy-layout { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: var(--sp-5); align-items: start; }
  .deploy-form { display: grid; gap: var(--sp-3); }
  .field { display: grid; gap: 5px; min-width: 0; }
  .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); }
  .field input {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    outline: none;
    background: var(--bg-input);
    padding: 9px 10px;
    color: var(--fg-primary);
    font: var(--fs-sm) var(--font-mono);
  }
  .field input:focus-visible { border-color: var(--acc); box-shadow: 0 0 0 2px color-mix(in srgb, var(--acc) 18%, transparent); }
  .field input[aria-invalid='true'] { border-color: var(--st-err); }
  .field p { color: var(--fg-tertiary); font-size: var(--fs-xs); line-height: 1.4; }
  .ingress-note { display: flex; align-items: flex-start; gap: var(--sp-2); border-left: 3px solid var(--st-info); padding: var(--sp-2) var(--sp-3); background: color-mix(in srgb, var(--st-info) 6%, var(--bg-input)); color: var(--fg-secondary); font-size: var(--fs-xs); line-height: 1.45; }
  .form-actions { margin-top: var(--sp-2); }
  .deployment-rail { border-left: 1px solid var(--bd-default); padding-left: var(--sp-4); }
  .deployment-rail ol { display: grid; margin: var(--sp-3) 0 0; padding: 0; list-style: none; }
  .deployment-rail li { position: relative; display: grid; min-height: 42px; grid-template-columns: 25px 1fr; align-items: start; gap: var(--sp-2); color: var(--fg-tertiary); font-size: var(--fs-xs); }
  .deployment-rail li:not(:last-child)::after { position: absolute; top: 22px; bottom: 0; left: 11px; width: 1px; background: var(--bd-default); content: ''; }
  .rail-marker { z-index: 1; display: grid; width: 23px; height: 23px; place-items: center; border: 1px solid var(--bd-default); border-radius: 50%; background: var(--bg-elevated); font: 9px var(--font-mono); }
  .deployment-rail li.running { color: var(--st-info); }
  .deployment-rail li.done { color: var(--st-ok); }
  .deployment-rail li.failed { color: var(--st-err); }
  .deployment-rail li.running .rail-marker,
  .deployment-rail li.done .rail-marker,
  .deployment-rail li.failed .rail-marker { border-color: currentColor; }
  .existing-form { display: grid; max-width: 520px; grid-template-columns: auto 1fr; gap: var(--sp-3); align-items: start; }
  .existing-form > .field,
  .existing-form > .form-actions { grid-column: 1 / -1; }
  .existing-form p { margin-top: 4px; color: var(--fg-secondary); font-size: var(--fs-sm); line-height: 1.45; }
  .spinner { width: 13px; height: 13px; box-sizing: border-box; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 700ms linear infinite; }
  .spinner.dark { width: 20px; height: 20px; }
  .spinner.tiny { width: 10px; height: 10px; border-width: 1.5px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 680px) {
    .dialog { width: 100%; max-height: calc(100vh - 16px); }
    .pair-layout,
    .deploy-layout { grid-template-columns: 1fr; }
    .qr-column { width: min(300px, 100%); justify-self: center; }
    .deployment-rail { border-top: 1px solid var(--bd-default); border-left: 0; padding-top: var(--sp-3); padding-left: 0; }
    .backend-bar { grid-template-columns: auto minmax(0, 1fr); }
    .backend-state { grid-column: 2; }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation-duration: 1400ms; }
  }
</style>
