<script lang="ts">
  /**
   * Phase 11.4 EndpointDialog —— 配 / 列 / 删远端 kode-server endpoint。
   *
   * 一个面板顶两件事:
   *   - 列表区:已添加的 endpoint(显示连接状态点 ● ○),逐条 Remove 按钮
   *   - 表单区:添加新 endpoint(id / display / base_url / token + Test + Add)
   *
   * Test 按钮独立于 Add — 用户能先单纯 ping,失败时改字段重试,通过后再 Add。
   *
   * **粘贴 pairing URL** 支持:用户粘 `kode://pair?host=H&port=P&token=T` 进 base_url
   * 输入框时,自动拆字段填到对应位置。
   */
  import { onMount, onDestroy } from 'svelte'
  import {
    endpointIpc,
    type EndpointSummary,
    type EndpointTestResult,
  } from './ipc'
  import Icon from './Icon.svelte'
  import Combobox from './Combobox.svelte'
  import { outsidePressClose } from './outside_close'
  import { currentLocale, t } from './i18n'

  type Props = { onClose: () => void }
  let { onClose }: Props = $props()

  let endpoints = $state<EndpointSummary[]>([])
  let loadError = $state('')

  // 添加表单字段
  let formId = $state('')
  let formDisplayName = $state('')
  let formBaseUrl = $state('')
  let formToken = $state('')
  // 连接方式:'direct' 直连 HTTP / 'ssh' SSH 隧道
  let connMode = $state<'direct' | 'ssh'>('direct')
  let formSshHost = $state('')
  let formSshPort = $state('22')        // SSH 服务端口(ssh -p),默认 22
  let formSshRemotePort = $state('9870') // kode-server 端口(隧道 -L)
  // ssh_host 下拉候选:已配 endpoint 的 ssh_host 去重(非空)
  let sshHostOptions = $derived.by(() => {
    const seen = new Set<string>()
    return endpoints
      .map((e) => e.ssh_host)
      .filter((h) => {
        const t = h.trim()
        if (!t || seen.has(t)) return false
        seen.add(t)
        return true
      })
  })
  // 输入栏的状态
  let testing = $state(false)
  let testResult = $state<EndpointTestResult | null>(null)
  let adding = $state(false)
  let formError = $state('')
  let savingNameId = $state<string | null>(null)
  let nameDrafts = $state<Record<string, string>>({})
  // 删除确认 — 简单用 inline confirm 状态(避免开新 modal)
  let pendingDeleteId = $state<string | null>(null)

  let tr = $derived.by(() => {
    void $currentLocale
    return t
  })

  onMount(() => {
    window.addEventListener('keydown', onKeyCapture, { capture: true })
    refresh()
  })

  onDestroy(() => {
    window.removeEventListener('keydown', onKeyCapture, { capture: true })
  })

  async function refresh() {
    try {
      endpoints = await endpointIpc.list()
      nameDrafts = Object.fromEntries(endpoints.map((e) => [e.id, e.display_name || e.id]))
      loadError = ''
    } catch (e) {
      loadError = String(e)
    }
  }

  /**
   * `kode://pair?host=H&port=P&token=T` → base_url + token 自动填。
   * 不识别 → 不动,留给用户手填。
   */
  function tryParsePairingUri(text: string): { base_url: string; token: string } | null {
    if (!text.startsWith('kode://pair')) return null
    try {
      // URL parser 不接受 kode:// 当 file 协议处理,改成手解
      const queryIdx = text.indexOf('?')
      if (queryIdx < 0) return null
      const params = new URLSearchParams(text.slice(queryIdx + 1))
      const host = params.get('host')
      const port = params.get('port')
      const token = params.get('token')
      if (!host || !port || !token) return null
      return { base_url: `http://${host}:${port}`, token }
    } catch {
      return null
    }
  }

  function onBaseUrlInput(e: Event) {
    const v = (e.target as HTMLInputElement).value
    formBaseUrl = v
    const parsed = tryParsePairingUri(v)
    if (parsed) {
      formBaseUrl = parsed.base_url
      formToken = parsed.token
    }
  }

  /** SSH 模式下 base_url 是「远端视角」地址,默认 127.0.0.1:<remote_port>。
   *  用户不填 base_url 时按此推导;填了就用填的(高级:远端 server 绑了别的 host)。 */
  function effectiveBaseUrl(): string {
    if (connMode === 'ssh') {
      const port = formSshRemotePort.trim() || '9870'
      return formBaseUrl.trim() || `http://127.0.0.1:${port}`
    }
    return formBaseUrl.trim()
  }

  function sshPortNum(): number {
    const n = parseInt(formSshPort.trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : 22
  }

  function sshRemotePortNum(): number {
    const n = parseInt(formSshRemotePort.trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : 9870
  }

  async function doTest() {
    formError = ''
    testResult = null
    if (!formToken) {
      formError = tr('endpoint.error.tokenRequired')
      return
    }
    if (connMode === 'ssh' && !formSshHost.trim()) {
      formError = tr('endpoint.error.sshHostRequired')
      return
    }
    if (connMode === 'direct' && !formBaseUrl) {
      formError = tr('endpoint.error.baseUrlAndTokenRequired')
      return
    }
    testing = true
    try {
      testResult = await endpointIpc.testConnection(
        effectiveBaseUrl(),
        formToken,
        connMode === 'ssh' ? formSshHost.trim() : '',
        connMode === 'ssh' ? sshPortNum() : 0,
        connMode === 'ssh' ? sshRemotePortNum() : 0,
      )
    } catch (e) {
      formError = String(e)
    } finally {
      testing = false
    }
  }

  async function doAdd() {
    formError = ''
    if (!formId.trim()) {
      formError = tr('endpoint.error.idRequired')
      return
    }
    if (/[:/\s]/.test(formId)) {
      formError = tr('endpoint.error.idInvalid')
      return
    }
    if (endpoints.some((e) => e.id === formId)) {
      formError = tr('endpoint.error.idExists', { id: formId })
      return
    }
    if (!formToken) {
      formError = tr('endpoint.error.tokenRequired')
      return
    }
    if (connMode === 'ssh' && !formSshHost.trim()) {
      formError = tr('endpoint.error.sshHostRequired')
      return
    }
    if (connMode === 'direct' && !formBaseUrl) {
      formError = tr('endpoint.error.baseUrlAndTokenRequired')
      return
    }
    adding = true
    try {
      await endpointIpc.add(
        formId.trim(),
        formDisplayName.trim(),
        effectiveBaseUrl(),
        formToken.trim(),
        connMode === 'ssh' ? formSshHost.trim() : '',
        connMode === 'ssh' ? sshPortNum() : 0,
        connMode === 'ssh' ? sshRemotePortNum() : 0,
      )
      // 清表单 + 刷新
      formId = ''
      formDisplayName = ''
      formBaseUrl = ''
      formToken = ''
      formSshHost = ''
      formSshPort = '22'
      formSshRemotePort = '9870'
      connMode = 'direct'
      testResult = null
      await refresh()
    } catch (e) {
      formError = String(e)
    } finally {
      adding = false
    }
  }

  async function doRemove(id: string) {
    try {
      await endpointIpc.remove(id)
      pendingDeleteId = null
      await refresh()
    } catch (e) {
      loadError = tr('endpoint.error.removeFailed', { id, error: String(e) })
    }
  }

  async function saveName(ep: EndpointSummary) {
    const id = ep.id
    const next = (nameDrafts[id] ?? '').trim()
    const current = (ep.display_name || ep.id).trim()
    if (next === current) return
    savingNameId = id
    formError = ''
    try {
      await endpointIpc.updateDisplayName(id, next)
      await refresh()
      window.dispatchEvent(new CustomEvent('kode:endpoints-changed'))
    } catch (e) {
      formError = tr('endpoint.error.updateNameFailed', { id, error: String(e) })
      nameDrafts = { ...nameDrafts, [id]: ep.display_name || ep.id }
    } finally {
      savingNameId = null
    }
  }

  function resetNameDraft(ep: EndpointSummary) {
    nameDrafts = { ...nameDrafts, [ep.id]: ep.display_name || ep.id }
  }

  function onKeyCapture(e: KeyboardEvent) {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopImmediatePropagation()
    onClose()
  }
</script>

<div class="backdrop" use:outsidePressClose={{ onClose }} role="presentation">
  <div class="dialog" role="dialog" aria-label={tr('endpoint.title')} data-locale={$currentLocale}>
    <header>
      <h2>{tr('endpoint.title')}</h2>
      <button class="close" onclick={onClose} aria-label={tr('memory.common.close')}>×</button>
    </header>

    {#if loadError}
      <p class="err">{loadError}</p>
    {/if}

    <section class="list">
      <h3>{tr('endpoint.list.title')}</h3>
      {#if endpoints.length === 0}
        <p class="empty">{tr('endpoint.list.empty')}</p>
      {:else}
        <ul>
          {#each endpoints as ep (ep.id)}
            <li>
              <span class="status" class:on={ep.connected} title={ep.connected ? tr('endpoint.status.connected') : tr('endpoint.status.disconnected')}></span>
              <input
                class="name-input"
                type="text"
                value={nameDrafts[ep.id] ?? ep.display_name}
                placeholder={ep.id}
                spellcheck="false"
                autocomplete="off"
                disabled={savingNameId === ep.id}
                aria-label={tr('endpoint.form.displayNameLabel')}
                oninput={(e) => {
                  nameDrafts = { ...nameDrafts, [ep.id]: (e.target as HTMLInputElement).value }
                }}
                onblur={() => saveName(ep)}
                onkeydown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    ;(e.currentTarget as HTMLInputElement).blur()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    resetNameDraft(ep)
                    ;(e.currentTarget as HTMLInputElement).blur()
                  }
                }}
              />
              <code class="muted">{ep.base_url}</code>
              {#if pendingDeleteId === ep.id}
                <button class="danger" onclick={() => doRemove(ep.id)}>{tr('endpoint.action.confirmRemove')}</button>
                <button class="ghost" onclick={() => (pendingDeleteId = null)}>{tr('memory.common.cancel')}</button>
              {:else}
                <button class="ghost" onclick={() => (pendingDeleteId = ep.id)}>{tr('endpoint.action.remove')}</button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="form">
      <h3>{tr('endpoint.form.title')}</h3>
      <p class="hint">
        {tr('endpoint.form.pairHintBefore')} <code>kode://pair?host=…&amp;port=…&amp;token=…</code> {tr('endpoint.form.pairHintAfter')}
      </p>
      <label>
        <span class="lbl">{tr('endpoint.form.idLabel')}</span>
        <input
          type="text"
          bind:value={formId}
          placeholder="dev-server"
          spellcheck="false"
          autocomplete="off"
        />
      </label>
      <label>
        <span class="lbl">{tr('endpoint.form.displayNameLabel')}</span>
        <input
          type="text"
          bind:value={formDisplayName}
          placeholder={tr('endpoint.form.displayNamePlaceholder')}
          spellcheck="false"
          autocomplete="off"
        />
      </label>
      <div class="mode-toggle" role="radiogroup" aria-label={tr('endpoint.form.connectionMode')}>
        <button
          class="seg"
          class:active={connMode === 'direct'}
          onclick={() => (connMode = 'direct')}
          type="button"
        >{tr('endpoint.form.directHttp')}</button>
        <button
          class="seg"
          class:active={connMode === 'ssh'}
          onclick={() => (connMode = 'ssh')}
          type="button"
        >{tr('endpoint.form.sshTunnel')}</button>
      </div>

      {#if connMode === 'direct'}
        <label>
          <span class="lbl">{tr('endpoint.form.baseUrlLabel')}</span>
          <input
            type="text"
            value={formBaseUrl}
            oninput={onBaseUrlInput}
            placeholder={tr('endpoint.form.baseUrlPlaceholder')}
            spellcheck="false"
            autocomplete="off"
          />
        </label>
      {:else}
        <p class="hint">
          {tr('endpoint.form.sshHintBefore')} <code>ssh -N -L</code> {tr('endpoint.form.sshHintMiddle')}
          <code>~/.ssh/config</code> {tr('endpoint.form.sshHintAfter')}
        </p>
        <label>
          <span class="lbl">{tr('endpoint.form.sshHostLabel')}</span>
          <Combobox
            bind:value={formSshHost}
            options={sshHostOptions}
            placeholder={tr('endpoint.form.sshHostPlaceholder')}
          />
        </label>
        <div class="ssh-ports">
          <label>
            <span class="lbl">{tr('endpoint.form.sshPortLabel')}</span>
            <input
              type="text"
              bind:value={formSshPort}
              placeholder="22"
              spellcheck="false"
              autocomplete="off"
            />
          </label>
          <label>
            <span class="lbl">{tr('endpoint.form.remotePortLabel')}</span>
            <input
              type="text"
              bind:value={formSshRemotePort}
              placeholder="9870"
              spellcheck="false"
              autocomplete="off"
            />
          </label>
        </div>
      {/if}
      <label>
        <span class="lbl">{tr('endpoint.form.tokenLabel')}</span>
        <input
          type="text"
          bind:value={formToken}
          placeholder={tr('endpoint.form.tokenPlaceholder')}
          spellcheck="false"
          autocomplete="off"
        />
      </label>

      <div class="actions">
        <button class="ghost" onclick={doTest} disabled={testing || adding}>
          {#if testing}{tr('endpoint.action.testing')}{:else}{tr('endpoint.action.test')}{/if}
        </button>
        <button class="primary" onclick={doAdd} disabled={adding || !testResult?.ok}>
          {#if adding}{tr('endpoint.action.adding')}{:else}{tr('endpoint.action.add')}{/if}
        </button>
      </div>

      {#if testResult}
        {#if testResult.ok}
          <p class="ok">
            <Icon name="check" /> {tr('endpoint.test.ok', {
              backends: testResult.backends.map((b) => b.key).join(', ') || tr('endpoint.test.emptyBackends'),
            })}
          </p>
        {:else}
          <p class="err">{tr('endpoint.test.failed', { detail: testResult.detail })}</p>
        {/if}
      {/if}

      {#if formError}
        <p class="err">{formError}</p>
      {/if}

      <p class="warning">
        {tr('endpoint.warning.tokenBefore')} <code>state.json</code>{tr('endpoint.warning.tokenAfter')}
      </p>
    </section>

    <footer>
      <p class="footnote">{tr('endpoint.footer')}</p>
    </footer>
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
    padding-top: 6vh;
  }
  .dialog {
    width: 540px;
    max-width: 92vw;
    background: var(--bg-elevated);
    border-radius: var(--rad-lg);
    box-shadow: var(--sh-modal);
    color: var(--fg-primary);
    font-family: var(--font-ui);
    font-size: var(--fs-md);
    overflow: hidden;
    max-height: 84vh;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--bd-default);
  }
  h2 {
    margin: 0;
    font-size: var(--fs-lg);
    font-weight: 600;
  }
  h3 {
    margin: 0 0 var(--sp-2) 0;
    font-size: var(--fs-sm);
    color: var(--fg-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .close {
    background: none;
    border: none;
    color: var(--fg-secondary);
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
    border-radius: 4px;
  }
  .close:hover {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }

  .list,
  .form {
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--bd-default);
    overflow-y: auto;
  }
  .list:last-of-type,
  .form:last-of-type {
    border-bottom: none;
  }

  .list ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .list li {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2);
    background: var(--bg-input);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
  }
  .empty {
    color: var(--fg-tertiary);
    margin: 0;
  }

  .status {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fg-tertiary);
    flex-shrink: 0;
  }
  .status.on {
    background: var(--st-ok, #4ade80);
  }
  .name-input {
    width: 160px;
    min-width: 120px;
    flex: 0 1 180px;
    font-weight: 500;
  }
  .muted {
    color: var(--fg-tertiary);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-xs);
    font-family: var(--font-mono);
  }

  .form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: var(--sp-2);
  }
  .lbl {
    color: var(--fg-secondary);
    font-size: var(--fs-xs);
  }
  input[type='text'] {
    background: var(--bg-input);
    color: var(--fg-primary);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    padding: var(--sp-2);
    font: inherit;
    outline: none;
  }
  input[type='text']:focus {
    border-color: var(--acc);
  }
  .mode-toggle {
    display: flex;
    gap: 0;
    margin-bottom: var(--sp-2);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    overflow: hidden;
    width: fit-content;
  }
  .seg {
    background: var(--bg-input);
    color: var(--fg-secondary);
    border: none;
    padding: var(--sp-1) var(--sp-3);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-xs);
  }
  .seg.active {
    background: var(--acc);
    color: var(--bg-primary);
  }
  .seg:not(.active):hover {
    background: var(--bg-tab-hover);
  }
  .ssh-ports {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-2);
    margin-bottom: var(--sp-2);
  }
  .ssh-ports label {
    margin-bottom: 0;
  }
  .hint {
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
    margin: 0 0 var(--sp-2);
  }
  .hint code {
    font-family: var(--font-mono);
  }

  .actions {
    display: flex;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }
  button.primary {
    background: var(--acc);
    color: var(--bg-primary);
    border: none;
    border-radius: var(--rad-sm);
    padding: var(--sp-2) var(--sp-3);
    cursor: pointer;
    font: inherit;
  }
  button.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.ghost {
    background: var(--bg-input);
    color: var(--fg-secondary);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    padding: var(--sp-2) var(--sp-3);
    cursor: pointer;
    font: inherit;
  }
  button.ghost:hover {
    background: var(--bg-tab-hover);
  }
  button.danger {
    background: var(--st-err, #ef4444);
    color: white;
    border: none;
    border-radius: var(--rad-sm);
    padding: var(--sp-1) var(--sp-2);
    cursor: pointer;
    font-size: var(--fs-xs);
  }

  .ok {
    color: var(--st-ok, #4ade80);
    margin: var(--sp-2) 0 0;
    font-size: var(--fs-xs);
  }
  .err {
    color: var(--st-err, #ef4444);
    margin: var(--sp-2) 0 0;
    font-size: var(--fs-xs);
  }
  .warning {
    color: var(--st-warn, #f59e0b);
    background: var(--bg-input);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    padding: var(--sp-2);
    margin: var(--sp-3) 0 0;
    font-size: var(--fs-xs);
  }

  footer {
    padding: var(--sp-3) var(--sp-4);
    border-top: 1px solid var(--bd-default);
    background: var(--bg-input);
  }
  .footnote {
    margin: 0;
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
  }
</style>
