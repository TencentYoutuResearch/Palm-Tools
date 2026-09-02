<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from './Icon.svelte'
  import { pluginIpc, type NativePluginOverview, type PluginOverview } from './ipc'
  import { outsidePressClose } from './outside_close'
  import { t } from './i18n'

  let { onClose }: { onClose: () => void } = $props()
  let data: PluginOverview | null = $state(null)
  let remote = $state('')
  let branch = $state('main')
  let autoPush = $state(false)
  let busy = $state(false)
  let error = $state('')
  let result = $state('')
  let createName = $state('')
  let createDescription = $state('')
  let nativeData: NativePluginOverview | null = $state(null)
  let nativeBusy = $state(false)
  let nativeError = $state('')

  async function load() {
    data = await pluginIpc.overview()
    remote = data.config.remote ?? ''
    branch = data.config.branch
    autoPush = data.config.auto_push
  }
  async function scanNative() {
    nativeBusy = true
    nativeError = ''
    try { nativeData = await pluginIpc.nativeOverview() }
    catch (e) { nativeError = String(e) }
    finally { nativeBusy = false }
  }
  onMount(() => {
    load().catch((e) => (error = String(e)))
    scanNative()
  })

  async function sync() {
    busy = true; error = ''; result = ''
    try {
      await pluginIpc.setConfig(remote.trim(), branch.trim() || 'main', autoPush)
      const report = await pluginIpc.syncNow()
      result = t('plugins.syncResult', { count: Object.values(report.deployed).reduce((a, b) => a + b, 0) })
      await load()
    } catch (e) { error = String(e) } finally { busy = false }
  }
  async function toggle(name: string, enabled: boolean) {
    try { await pluginIpc.setEnabled(name, enabled); await load() } catch (e) { error = String(e) }
  }
  async function createPlugin() {
    if (!createName.trim()) return
    busy = true; error = ''
    try {
      await pluginIpc.create(createName, createDescription)
      createName = ''; createDescription = ''; result = t('plugins.created'); await load()
    } catch (e) { error = String(e) } finally { busy = false }
  }
</script>

<div class="backdrop" use:outsidePressClose={{ onClose }} role="presentation">
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="plugin-title">
    <header>
      <div><span class="eyebrow">CODEX · CLAUDE · CURSOR · CODEBUDDY</span><h2 id="plugin-title">{t('plugins.title')}</h2></div>
      <button class="icon" onclick={onClose} aria-label={t('memory.common.close')}><Icon name="x" /></button>
    </header>
    <div class="body">
      {#if error}<div class="notice error" role="alert">{error}</div>{/if}
      {#if result}<div class="notice success" role="status">{result}</div>{/if}
      <form novalidate onsubmit={(e) => { e.preventDefault(); sync() }}>
        <h3>{t('plugins.marketplace')}</h3>
        <p class="form-hint">{t('plugins.marketplaceHint')}</p>
        <label for="plugin-remote">{t('plugins.remote')}</label>
        <input id="plugin-remote" bind:value={remote} placeholder="git@github.com:you/kode-plugins.git" disabled={busy} />
        <div class="form-row">
          <div><label for="plugin-branch">{t('plugins.branch')}</label><input id="plugin-branch" bind:value={branch} disabled={busy} /></div>
          <label class="check"><input type="checkbox" bind:checked={autoPush} disabled={busy} /> {t('plugins.autoPush')}</label>
          <button class="primary" disabled={busy}>{busy ? t('plugins.syncing') : t('plugins.sync')}</button>
        </div>
      </form>
      <form class="create" novalidate onsubmit={(e) => { e.preventDefault(); createPlugin() }}>
        <h3>{t('plugins.create')}</h3>
        <div class="create-row"><input aria-label={t('plugins.name')} bind:value={createName} placeholder={t('plugins.name')} disabled={busy} /><input aria-label={t('plugins.pluginDescription')} bind:value={createDescription} placeholder={t('plugins.pluginDescription')} disabled={busy} /><button class="secondary" disabled={busy || !createName.trim()}>{t('plugins.createAction')}</button></div>
      </form>
      {#if data}
        <p class="root">{data.root}</p>
        <div class="list">
          {#each data.plugins as plugin (plugin.name)}
            <article>
              <div class="plugin-head"><label class="plugin-check"><input type="checkbox" checked={plugin.enabled} onchange={(e) => toggle(plugin.name, (e.currentTarget as HTMLInputElement).checked)} /><strong>{plugin.name}</strong></label><span>{plugin.platforms.reduce((n, p) => n + p.available_skills, 0)} skills</span></div>
              <div class="matrix">
                {#each plugin.platforms as platform (platform.platform)}
                  <div class="platform"><span>{platform.platform}</span><em class={platform.compatibility}>{platform.compatibility}</em><small>{platform.available_skills}</small></div>
                {/each}
              </div>
            </article>
          {:else}
            <div class="empty"><Icon name="archive" /><strong>{t('plugins.empty')}</strong><span>{t('plugins.emptyHint')}</span></div>
          {/each}
        </div>
      {/if}
      <section class="native-section" aria-labelledby="native-plugin-title">
        <div class="section-head">
          <div><h3 id="native-plugin-title">{t('plugins.native.title')}</h3><p>{t('plugins.native.hint')}</p></div>
          <button class="secondary scan" onclick={scanNative} disabled={nativeBusy}>{nativeBusy ? t('plugins.native.scanning') : t('plugins.native.scan')}</button>
        </div>
        {#if nativeError}<div class="notice error" role="alert">{nativeError}</div>{/if}
        {#if nativeData}
          <div class="backend-grid">
            {#each nativeData.backends as backend (backend.backend)}
              <article class="backend-card">
                <div class="backend-head">
                  <div><strong>{backend.backend}</strong><span class:ready={backend.status === 'ready'} class:partial={backend.status === 'partial'} class:error-state={backend.status === 'error'}>{t(`plugins.native.status.${backend.status}`)}</span></div>
                  <small>{t('plugins.native.count', { count: backend.plugins.length })}</small>
                </div>
                <p class="capabilities">{backend.capabilities.join(' · ')}</p>
                {#if backend.detail}<p class="backend-detail">{t(`plugins.native.detail.${backend.detail}`)}</p>{/if}
                {#if backend.plugins.length}
                  <details>
                    <summary>{t('plugins.native.showInstalled')}</summary>
                    <ul class="native-list">
                      {#each backend.plugins as plugin (plugin.id)}
                        <li><span><strong>{plugin.name}</strong><small>{plugin.source ?? t('plugins.native.unknownSource')}</small></span><code>{plugin.version ?? '—'}</code></li>
                      {/each}
                    </ul>
                  </details>
                {:else}
                  <p class="backend-empty">{backend.status === 'unavailable' ? t('plugins.native.cliMissing') : t('plugins.native.none')}</p>
                {/if}
              </article>
            {/each}
          </div>
        {:else if nativeBusy}
          <div class="native-loading" role="status">{t('plugins.native.scanning')}</div>
        {/if}
      </section>
    </div>
  </div>
</div>

<style>
  .backdrop{position:fixed;inset:0;z-index:1100;background:var(--bg-modal-backdrop);backdrop-filter:var(--blur-modal);display:flex;justify-content:flex-end}.panel{width:min(720px,94vw);height:100vh;background:var(--bg-elevated);color:var(--fg-primary);display:flex;flex-direction:column;box-shadow:var(--sh-modal)}header{display:flex;align-items:center;justify-content:space-between;padding:var(--sp-4);border-bottom:1px solid var(--bd-default)}h2{margin:3px 0 0;font-size:var(--fs-lg)}h3{margin:0 0 4px;font-size:var(--fs-md)}.form-hint{margin:0 0 12px;color:var(--fg-muted);font-size:var(--fs-sm)}.eyebrow{font:10px var(--font-mono);letter-spacing:.1em;color:var(--st-ok)}.icon{width:32px;height:32px;border:0;border-radius:var(--rad-sm);background:transparent;color:var(--fg-secondary);cursor:pointer}.icon:hover{background:var(--bg-hover);color:var(--fg-primary)}.body{padding:var(--sp-4);overflow:auto}.notice{padding:10px 12px;border:1px solid;border-radius:var(--rad-md);margin-bottom:12px}.error{color:var(--st-danger);border-color:var(--st-danger)}.success{color:var(--st-ok);border-color:var(--st-ok)}form{padding:14px;border:1px solid var(--bd-default);border-radius:var(--rad-lg);background:var(--bg-secondary)}form.create{margin-top:10px}label{display:block;margin-bottom:6px;font-size:var(--fs-sm);color:var(--fg-secondary)}input{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid var(--bd-default);border-radius:var(--rad-sm);background:var(--bg-input);color:var(--fg-primary);font-family:var(--font-mono)}input:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.form-row{display:grid;grid-template-columns:120px 1fr auto;align-items:end;gap:12px;margin-top:12px}.create-row{display:grid;grid-template-columns:150px 1fr auto;gap:8px}.check,.plugin-check{display:flex;align-items:center;gap:7px;margin:0}.check{margin-bottom:9px}.check input,.plugin-check input{width:auto}.primary,.secondary{height:36px;padding:0 15px;border-radius:var(--rad-sm);font-weight:600;cursor:pointer}.primary{border:0;background:var(--accent);color:var(--bg-primary)}.secondary{border:1px solid var(--bd-default);background:var(--bg-tertiary);color:var(--fg-primary)}.primary:disabled,.secondary:disabled{opacity:.55;cursor:default}.root{font:11px var(--font-mono);color:var(--fg-muted);overflow-wrap:anywhere}.list{display:grid;gap:9px}article{padding:12px;border:1px solid var(--bd-default);border-radius:var(--rad-lg);background:var(--bg-secondary)}.plugin-head{display:flex;justify-content:space-between;margin-bottom:10px}.plugin-head span{font:11px var(--font-mono);color:var(--fg-muted)}.matrix{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.platform{display:grid;grid-template-columns:1fr auto;gap:3px 6px;padding:7px;border:1px solid var(--bd-subtle);border-radius:var(--rad-sm)}.platform>span{font:11px var(--font-mono)}em{font-size:10px;font-style:normal;color:var(--fg-muted)}em.native{color:var(--st-ok)}em.adapted{color:var(--st-info)}em.partial{color:var(--st-warning)}small{grid-column:2;font-family:var(--font-mono);color:var(--fg-muted)}.empty{min-height:180px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;color:var(--fg-muted)}.empty strong{color:var(--fg-secondary)}.native-section{margin-top:24px;padding-top:18px;border-top:1px solid var(--bd-default)}.section-head{display:flex;align-items:start;justify-content:space-between;gap:16px;margin-bottom:10px}.section-head p{margin:3px 0 0;max-width:500px;color:var(--fg-muted);font-size:var(--fs-sm)}.scan{flex:none}.backend-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.backend-card{min-width:0}.backend-head{display:flex;align-items:start;justify-content:space-between;gap:8px}.backend-head>div{display:flex;align-items:center;gap:8px}.backend-head>div>strong{text-transform:capitalize}.backend-head>div>span{font:10px var(--font-mono);color:var(--fg-muted)}.backend-head>div>span.ready{color:var(--st-ok)}.backend-head>div>span.partial{color:var(--st-warning)}.backend-head>div>span.error-state{color:var(--st-danger)}.backend-head>small{grid-column:auto;white-space:nowrap}.capabilities{margin:7px 0 0;font:10px var(--font-mono);color:var(--fg-muted);overflow-wrap:anywhere}.backend-detail,.backend-empty{margin:8px 0 0;color:var(--fg-muted);font-size:11px;line-height:1.45}.backend-detail{color:var(--st-warning)}details{margin-top:9px;border-top:1px solid var(--bd-subtle);padding-top:8px}summary{width:max-content;color:var(--fg-secondary);font-size:11px;cursor:pointer}.native-list{list-style:none;padding:6px 0 0;margin:0;display:grid;gap:2px}.native-list li{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px solid var(--bd-subtle)}.native-list li:last-child{border-bottom:0}.native-list span{min-width:0;display:flex;flex-direction:column}.native-list strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.native-list small{grid-column:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.native-list code{flex:none;color:var(--fg-muted);font-size:10px}.native-loading{min-height:120px;display:grid;place-items:center;color:var(--fg-muted)}@media(max-width:560px){.matrix,.backend-grid{grid-template-columns:1fr}.form-row,.create-row{grid-template-columns:1fr}.check{margin:0}.primary,.secondary{width:100%}.section-head{align-items:stretch;flex-direction:column}}@media(prefers-reduced-motion:no-preference){.panel{animation:enter 160ms ease-out}@keyframes enter{from{transform:translateX(18px);opacity:.5}}}
</style>
