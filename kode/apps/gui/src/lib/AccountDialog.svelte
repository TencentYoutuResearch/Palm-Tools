<script lang="ts">
  /** Standalone Kode account dialog (command palette). Settings › Account
   *  renders the same AccountPane inline. */
  import AccountPane from './AccountPane.svelte'
  import Icon from './Icon.svelte'
  import { currentLocale, t } from './i18n'
  import { outsidePressClose } from './outside_close'

  type Props = { onClose: () => void }
  let { onClose }: Props = $props()

  let tr = $derived.by(() => {
    void $currentLocale
    return t
  })

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Escape') onClose()
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" use:outsidePressClose={{ onClose }} role="presentation">
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="account-title">
    <header>
      <h2 id="account-title">{tr('pairing.account.title')}</h2>
      <button type="button" class="icon-button" onclick={onClose} aria-label={tr('pairing.close')}>
        <Icon name="x" />
      </button>
    </header>
    <div class="body"><AccountPane /></div>
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
    width: min(520px, 96vw);
    max-height: min(780px, calc(100vh - 32px));
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-lg);
    background: var(--bg-elevated);
    box-shadow: var(--sh-modal);
    color: var(--fg-primary);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--bd-default);
  }
  h2 { margin: 0; font-size: var(--fs-lg); font-weight: 600; }
  .icon-button { display: grid; width: 30px; height: 30px; place-items: center; border: 0; border-radius: var(--rad-sm); background: transparent; color: var(--fg-secondary); cursor: pointer; }
  .icon-button:hover { background: var(--bg-tab-hover); color: var(--fg-primary); }
  .body { overflow-y: auto; padding: var(--sp-4); }
</style>
