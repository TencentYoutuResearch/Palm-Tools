<script lang="ts">
  /**
   * 远端 Bridge 部署面板。
   *
   * 用户填 user@host + ssh_port + remote_port → 点 Deploy → 后端通过 SSH:
   *   上传 tarball → 停旧服务 → 解压 → 起新服务 → 健康检查 → 取 token → 建/复用 endpoint
   *
   * 分步进度通过 `deploy-progress` event 实时推送,这里订阅显示。
   * 成功后自动创建/复用 endpoint,用户可直接在 BackendChooser 选 Remote 用。
   */
  import { onMount, onDestroy } from 'svelte'
  import { listen, type UnlistenFn } from '@tauri-apps/api/event'
  import { deployIpc, endpointIpc, type DeployProgress, type DeployResult } from './ipc'
  import Icon from './Icon.svelte'
  import Combobox from './Combobox.svelte'
  import { outsidePressClose } from './outside_close'
  import { currentLocale, t } from './i18n'

  type Props = {
    onClose: () => void
    onDeployed?: (result: DeployResult) => void
  }
  let { onClose, onDeployed }: Props = $props()

  // 表单
  let sshHost = $state('')           // user@host 或 ~/.ssh/config 别名
  let remoteName = $state('')
  let sshPort = $state('22')
  let remotePort = $state('9870')

  // ssh_host 下拉候选:已配 endpoint 的 ssh_host 去重(非空)
  let sshHostOptions: string[] = $state([])

  // 状态
  let deploying = $state(false)
  let error = $state('')
  let result = $state<DeployResult | null>(null)

  type StepStatus = 'pending' | 'running' | 'done' | 'failed'
  interface Step {
    step: string
    status: StepStatus
    message: string
  }

  const STEP_KEYS = [
    'Uploading',
    'StoppingOld',
    'Extracting',
    'StartingNew',
    'HealthCheck',
    'FetchingToken',
    'CreatingEndpoint',
    'Done',
  ] as const
  const stepDefs = $derived.by(() => {
    void $currentLocale
    return STEP_KEYS.map((step) => ({ step, label: t(`deploy.step.${step}`) }))
  })
  let steps = $state<Step[]>([])

  let tr = $derived.by(() => {
    void $currentLocale
    return t
  })

  let unlistenFn: UnlistenFn | null = null

  onMount(async () => {
    unlistenFn = await listen<DeployProgress>('deploy-progress', (e) => {
      const { step, status, message } = e.payload
      const idx = steps.findIndex((s) => s.step === step)
      if (idx >= 0) {
        steps[idx] = { step, status: status as StepStatus, message }
        steps = [...steps]
        // 失败时把 error 也填上,方便用户在结果区看到
        if (status === 'failed') {
          error = `${labelOf(step)}: ${message}`
        }
      }
    })
    // 拉已配 endpoint,提取 ssh_host 去重作为下拉候选
    try {
      const eps = await endpointIpc.list()
      const seen = new Set<string>()
      sshHostOptions = eps
        .map((e) => e.ssh_host)
        .filter((h) => {
          const t = h.trim()
          if (!t || seen.has(t)) return false
          seen.add(t)
          return true
        })
    } catch (e) {
      // 拉 endpoint 失败不阻塞部署,只是没下拉候选
      console.warn('load endpoints for ssh_host options failed:', e)
    }
  })

  onDestroy(() => {
    if (unlistenFn) unlistenFn()
  })

  function resetSteps() {
    steps = stepDefs.map((d) => ({ step: d.step, status: 'pending', message: '' }))
  }

  function labelOf(step: string): string {
    return stepDefs.find((d) => d.step === step)?.label ?? step
  }

  function progressMessage(message: string): string {
    const key = `deploy.progress.message.${message}`
    const translated = tr(key)
    return translated === key ? message : translated
  }

  async function deploy() {
    if (!sshHost.trim()) {
      error = tr('deploy.error.hostRequired')
      return
    }
    deploying = true
    error = ''
    result = null
    resetSteps()
    try {
      result = await deployIpc.deploy({
        ssh_host: sshHost.trim(),
        display_name: remoteName.trim() || undefined,
        ssh_port: Number(sshPort) || 22,
        remote_port: Number(remotePort) || 9870,
      })
      onDeployed?.(result)
    } catch (e) {
      error = String(e)
    } finally {
      deploying = false
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && !deploying) onClose()
  }

  const canDeploy = $derived(sshHost.trim().length > 0 && !deploying)
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" use:outsidePressClose={{ onClose, disabled: deploying }} role="presentation">
  <div class="dialog" role="dialog">
    <header>
      <h2>{tr('deploy.title')}</h2>
      <button class="close" onclick={onClose} disabled={deploying} aria-label={tr('memory.common.close')}>×</button>
    </header>

    {#if error}
      <div class="err">{error}</div>
    {/if}

    {#if result}
      <div class="success">
        <Icon name="check" />
        <div>
          <strong>{tr('deploy.success.title')}</strong>
          {#if result.endpoint_created}
            <span> · {tr('deploy.success.created')} <code>{result.endpoint_id}</code></span>
          {:else}
            <span> · {tr('deploy.success.reused')} <code>{result.endpoint_id}</code>{tr('deploy.success.tokenUpdated')}</span>
          {/if}
          <p class="hint">{tr('deploy.success.hint', { endpoint: result.endpoint_id })}</p>
        </div>
      </div>
    {/if}

    <section class="section">
      <h3>{tr('deploy.ssh.title')}</h3>
      <div class="field">
        <label for="deploy-ssh-host">user@host</label>
        <Combobox
          id="deploy-ssh-host"
          bind:value={sshHost}
          options={sshHostOptions}
          placeholder={tr('deploy.ssh.hostPlaceholder')}
          disabled={deploying}
        />
        <p class="hint-line">{tr('deploy.ssh.hostHintBefore')} <code>~/.ssh/config</code>{tr('deploy.ssh.hostHintAfter')}</p>
      </div>
      <div class="field">
        <label for="deploy-remote-name">{tr('deploy.remoteName')}</label>
        <input
          id="deploy-remote-name"
          type="text"
          bind:value={remoteName}
          placeholder={tr('deploy.remoteNamePlaceholder')}
          spellcheck="false"
          autocomplete="off"
          disabled={deploying}
        />
        <p class="hint-line">{tr('deploy.remoteNameHint')}</p>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="deploy-ssh-port">{tr('deploy.ssh.port')}</label>
          <input
            id="deploy-ssh-port"
            type="text"
            inputmode="numeric"
            bind:value={sshPort}
            placeholder="22"
            spellcheck="false"
            autocomplete="off"
            disabled={deploying}
          />
        </div>
        <div class="field">
          <label for="deploy-remote-port">{tr('deploy.remotePort')}</label>
          <input
            id="deploy-remote-port"
            type="text"
            inputmode="numeric"
            bind:value={remotePort}
            placeholder="9870"
            spellcheck="false"
            autocomplete="off"
            disabled={deploying}
          />
        </div>
      </div>
      <div class="actions">
        <button class="btn primary" onclick={deploy} disabled={!canDeploy}>
          {deploying ? tr('deploy.action.deploying') : tr('deploy.action.deploy')}
        </button>
        <button class="btn ghost" onclick={onClose} disabled={deploying}>{tr('memory.common.close')}</button>
      </div>
    </section>

    {#if steps.length > 0 && (deploying || result || error)}
      <section class="section">
        <h3>{tr('deploy.progress.title')}</h3>
        <ol class="steps">
          {#each steps as s (s.step)}
            <li class="step {s.status}">
              <span class="step-icon">
                {#if s.status === 'done'}
                  <Icon name="check" />
                {:else if s.status === 'failed'}
                  <Icon name="x" />
                {:else if s.status === 'running'}
                  <span class="spinner"></span>
                {:else}
                  <span class="dot"></span>
                {/if}
              </span>
              <span class="step-body">
                <span class="step-label">{labelOf(s.step)}</span>
                {#if s.message}
                  <span class="step-msg">{progressMessage(s.message)}</span>
                {/if}
              </span>
            </li>
          {/each}
        </ol>
      </section>
    {/if}

    <section class="section">
      <h3>{tr('deploy.notes.title')}</h3>
      <p class="hint">
        {tr('deploy.notes.flowStart')}
        <code>~/.local/kode-remote-memory-bridge/</code>
        {tr('deploy.notes.flowMiddle')}
        <code>~/.kode/state.json</code>
        {tr('deploy.notes.flowEnd')}
      </p>
      <p class="hint">
        {tr('deploy.notes.requirementsBefore')} <code>tar</code> / <code>curl</code> / <code>nohup</code> / <code>pkill</code>
        {tr('deploy.notes.requirementsAfter')}
      </p>
    </section>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.42);
    z-index: 800;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .dialog {
    width: 580px;
    max-width: 92vw;
    max-height: 88vh;
    overflow-y: auto;
    background: var(--bg-elevated);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-xl);
    padding: var(--sp-5);
    box-shadow: var(--sh-lg);
    color: var(--fg-primary);
    font-family: var(--font-ui);
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: var(--sp-4);
  }
  h2 {
    margin: 0;
    font-size: var(--fs-xl);
    font-weight: var(--fw-semi);
  }
  h3 {
    margin: 0 0 var(--sp-2) 0;
    font-size: var(--fs-md);
    color: var(--fg-secondary);
    font-weight: var(--fw-med);
  }
  .close {
    width: 32px;
    height: 32px;
    border: none;
    background: transparent;
    color: var(--fg-tertiary);
    font-size: 22px;
    cursor: pointer;
    border-radius: var(--rad-sm);
  }
  .close:hover:not(:disabled) {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
  .close:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .section {
    margin-bottom: var(--sp-4);
    padding-bottom: var(--sp-3);
    border-bottom: 1px solid var(--bd-default);
  }
  .section:last-child {
    border-bottom: none;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: var(--sp-3);
  }
  .field-row {
    display: flex;
    gap: var(--sp-3);
  }
  .field-row .field {
    flex: 1;
  }
  label {
    font-size: var(--fs-xs);
    font-weight: var(--fw-med);
    color: var(--fg-secondary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  input[type='text'] {
    background: var(--bg-base);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    padding: 6px 10px;
    color: var(--fg-primary);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
  }
  input[type='text']:focus {
    outline: none;
    border-color: var(--acc);
  }
  input:disabled {
    opacity: 0.6;
  }

  .hint,
  .hint-line {
    margin: 0;
    font-size: 11px;
    color: var(--fg-tertiary);
    line-height: 1.5;
  }
  .hint code,
  .hint-line code {
    font-family: var(--font-mono);
    background: var(--bg-tab-hover);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .actions {
    display: flex;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }
  .btn {
    border: 1px solid var(--bd-default);
    background: transparent;
    color: var(--fg-secondary);
    padding: 6px 16px;
    font-size: var(--fs-sm);
    border-radius: var(--rad-sm);
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast);
  }
  .btn:hover:not(:disabled) {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
  .btn.primary {
    background: var(--acc);
    color: var(--fg-on-accent);
    border-color: var(--acc);
    font-weight: var(--fw-med);
  }
  .btn.primary:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .err {
    background: rgba(193, 18, 31, 0.16);
    color: #c1121f;
    border: 1px solid rgba(193, 18, 31, 0.32);
    padding: 8px 12px;
    border-radius: var(--rad-sm);
    font-size: var(--fs-sm);
    font-family: var(--font-mono);
    margin-bottom: var(--sp-3);
    white-space: pre-wrap;
  }

  .success {
    display: flex;
    gap: var(--sp-2);
    align-items: flex-start;
    background: rgba(38, 166, 91, 0.12);
    color: #26a65b;
    border: 1px solid rgba(38, 166, 91, 0.32);
    padding: 10px 12px;
    border-radius: var(--rad-sm);
    font-size: var(--fs-sm);
    margin-bottom: var(--sp-3);
  }
  .success :global(svg) {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    margin-top: 1px;
  }
  .success code {
    font-family: var(--font-mono);
    background: rgba(38, 166, 91, 0.16);
    padding: 1px 4px;
    border-radius: 3px;
  }
  .success .hint {
    margin-top: 4px;
    color: rgba(38, 166, 91, 0.8);
  }

  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .step {
    display: flex;
    gap: 10px;
    padding: 6px 0;
    align-items: flex-start;
  }
  .step-icon {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-top: 1px;
  }
  .step-icon :global(svg) {
    width: 16px;
    height: 16px;
  }
  .step.done .step-icon {
    color: #26a65b;
  }
  .step.failed .step-icon {
    color: #c1121f;
  }
  .step.running .step-icon {
    color: var(--acc);
  }
  .step.pending .step-icon {
    color: var(--fg-tertiary);
  }
  .step.pending {
    opacity: 0.55;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    display: inline-block;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .step-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .step-label {
    font-size: var(--fs-sm);
    font-weight: var(--fw-med);
    color: var(--fg-primary);
  }
  .step-msg {
    font-size: 11px;
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .step.failed .step-msg {
    color: #c1121f;
  }
</style>
