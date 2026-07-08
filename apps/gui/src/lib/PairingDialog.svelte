<script lang="ts">
  /**
   * PairingDialog —— 给手机 App 扫描的配对弹层。
   *
   * 显示:
   *   - 二维码(`kode://pair?host=…&port=…&token=…`)
   *   - 可编辑的 host(默认 127.0.0.1,用户改成 LAN IP / Tailscale 主机名)
   *   - port + token(只读 + 一键复制)
   *   - 提示
   *
   * 用户改 host 后,QR 实时重算。
   */
  import { onMount } from 'svelte'
  import { ipc, type PairingPayload } from './ipc'
  import Icon from './Icon.svelte'
  import { outsidePressClose } from './outside_close'

  type Props = { onClose: () => void }
  let { onClose }: Props = $props()

  let payload = $state<PairingPayload | null>(null)
  let host = $state('')
  let qrDataUrl = $state('')
  let copyState = $state<'token' | 'uri' | null>(null)
  let error = $state('')
  // qrcode 库 lazy import:配对弹层默认不打开,主 bundle 不应背着它
  let qrcode: typeof import('qrcode') | null = null

  onMount(async () => {
    try {
      const [pl, qr] = await Promise.all([
        ipc.getPairingPayload(),
        import('qrcode'),
      ])
      payload = pl
      host = pl.host || '127.0.0.1'
      qrcode = qr.default
    } catch (e) {
      error = String(e)
    }
  })

  // host 编辑 → 重算 URI + QR
  let currentUri = $derived(
    payload && host && !payload.bridge_disabled
      ? `kode://pair?host=${encodeURIComponent(host)}&port=${payload.port}&token=${payload.token}`
      : '',
  )

  $effect(() => {
    if (!currentUri || !qrcode) {
      qrDataUrl = ''
      return
    }
    qrcode
      .toDataURL(currentUri, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 280,
        color: { dark: '#000000', light: '#ffffff' },
      })
      .then((url) => (qrDataUrl = url))
      .catch((e) => (error = `qr render: ${e}`))
  })

  async function copy(text: string, kind: 'token' | 'uri') {
    try {
      await navigator.clipboard.writeText(text)
      copyState = kind
      setTimeout(() => (copyState = null), 1200)
    } catch (e) {
      error = `clipboard: ${e}`
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose()
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" use:outsidePressClose={{ onClose }} role="presentation">
  <div class="dialog" role="dialog">
    <header>
      <h2>Pair Mobile App</h2>
      <button class="close" onclick={onClose} aria-label="Close">×</button>
    </header>

    {#if !payload}
      <p class="loading">loading…</p>
    {:else if payload.bridge_disabled}
      <div class="warn">
        <strong>Remote bridge disabled.</strong>
        <p>
          The HTTP/WS bridge was disabled (KODE_BRIDGE_DISABLE env). Mobile app
          pairing requires the bridge to be running.
        </p>
      </div>
    {:else}
      <div class="qr-row">
        {#if qrDataUrl}
          <img src={qrDataUrl} alt="Pairing QR" width="280" height="280" />
        {:else}
          <div class="qr-placeholder">…</div>
        {/if}
      </div>

      <div class="fields">
        <label>
          <span class="lbl">Host</span>
          <input
            type="text"
            bind:value={host}
            placeholder="127.0.0.1 / 100.x.x.x / mac.tail-scale.ts"
            spellcheck="false"
            autocomplete="off"
          />
        </label>
        <p class="hint">
          Default <code>127.0.0.1</code> only works if the phone is on the same
          machine. For real pairing, change to a LAN IP or Tailscale hostname
          the phone can reach.
        </p>

        <div class="row">
          <span class="lbl">Port</span>
          <code>{payload.port}</code>
        </div>

        <div class="row">
          <span class="lbl">Token</span>
          <code class="mono">{payload.token}</code>
          <button
            class="copy"
            onclick={() => copy(payload!.token, 'token')}
            title="Copy token"
          >
            {#if copyState === 'token'}<Icon name="check" />{:else}copy{/if}
          </button>
        </div>

        <div class="row">
          <span class="lbl">URI</span>
          <code class="mono uri">{currentUri}</code>
          <button
            class="copy"
            onclick={() => copy(currentUri, 'uri')}
            title="Copy pairing URI"
          >
            {#if copyState === 'uri'}<Icon name="check" />{:else}copy{/if}
          </button>
        </div>
      </div>
    {/if}

    {#if error}
      <p class="err">{error}</p>
    {/if}

    <footer>
      <p class="footnote">
        Scan the QR with the kode mobile app, or copy the URI manually.
      </p>
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
    padding-top: 8vh;
  }
  .dialog {
    width: 460px;
    max-width: 90vw;
    background: var(--bg-elevated);
    border-radius: var(--rad-lg);
    box-shadow: var(--sh-modal);
    color: var(--fg-primary);
    font-family: var(--font-ui);
    font-size: var(--fs-md);
    overflow: hidden;
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

  .loading,
  .warn,
  .err {
    padding: var(--sp-4);
    color: var(--fg-secondary);
  }
  .warn strong {
    color: var(--fg-primary);
  }
  .err {
    color: var(--st-err);
  }

  .qr-row {
    display: flex;
    justify-content: center;
    padding: var(--sp-4) 0 var(--sp-2);
    background: #fff;          /* QR 必须白底,扫码兼容性 */
    margin: 0 var(--sp-4);
    border-radius: var(--rad-md);
  }
  .qr-placeholder {
    width: 280px;
    height: 280px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-tertiary);
  }

  .fields {
    padding: var(--sp-3) var(--sp-4);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .fields label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .lbl {
    color: var(--fg-secondary);
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
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
  .hint {
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
    margin: 0 0 var(--sp-1);
  }
  .hint code {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--fg-secondary);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .row code {
    flex: 1;
    background: var(--bg-input);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    padding: var(--sp-2);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row .uri {
    overflow: auto;
  }
  .copy {
    background: var(--bg-input);
    color: var(--fg-secondary);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    padding: var(--sp-1) var(--sp-2);
    cursor: pointer;
    font-size: var(--fs-xs);
    font-family: var(--font-mono);
    min-width: 48px;
  }
  .copy:hover {
    background: var(--bg-tab-hover);
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
