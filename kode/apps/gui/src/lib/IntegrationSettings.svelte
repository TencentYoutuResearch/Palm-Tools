<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { currentLocale, t } from './i18n'
  type Settings = { messaging_enabled: boolean; memory_enabled: boolean }
  let settings: Settings | null = $state(null)
  let busy = $state(false), error = $state('')
  let revision = 0
  let outcomes: { backend: string; success: boolean; error?: string }[] = $state([])
  const tr = (key: string) => { $currentLocale; return t(key) }
  async function refresh() {
    busy = true; error = ''
    try { const result = await invoke<{ settings: Settings }>('integration_action', { action: 'status' }); settings = result.settings }
    catch (e) { error = String(e) }
    finally { busy = false }
  }
  async function toggle(key: keyof Settings) {
    if (!settings || busy) return
    revision++
    busy = true; error = ''
    try { settings = await invoke<Settings>('integration_action', { action: 'configure', payload: { [key]: !settings[key] } }) }
    catch (e) { error = String(e) }
    finally { busy = false }
  }
  async function setupAgents() {
    busy = true; error = ''; outcomes = []
    try { outcomes = await invoke<typeof outcomes>('setup_shared_services') }
    catch (e) { error = String(e) }
    finally { busy = false }
  }
  onMount(() => {
    let alive = true
    void refresh()
    const timer = setInterval(async () => {
      if (busy) return
      const before = revision
      try { const result = await invoke<{ settings: Settings }>('integration_action', { action: 'status' }); if (alive && !busy && revision === before) settings = result.settings } catch { /* Keep the last settings during a reconnect. */ }
    }, 5000)
    return () => { alive = false; clearInterval(timer) }
  })
</script>

<section aria-busy={busy}>
  <h2>{tr('settings.integrations.title')}</h2>
  <p class="description">{tr('settings.integrations.description')}</p>
  {#if settings}
    {#each ['messaging_enabled', 'memory_enabled'] as key}
      <div class="feature">
        <div>
          <h3 id={`integration-${key}`}>{tr(`settings.integrations.${key}`)}</h3>
          <p>{tr(`settings.integrations.${key}Description`)}</p>
        </div>
        <button class="toggle" class:enabled={settings[key as keyof Settings]} type="button" role="switch" aria-checked={settings[key as keyof Settings]} aria-labelledby={`integration-${key}`} disabled={busy} onclick={() => toggle(key as keyof Settings)}><span></span></button>
      </div>
    {/each}
    <div class="setup">
      <h3>{tr('settings.integrations.agentAccess')}</h3>
      <p class="description">{tr('settings.integrations.agentAccessDescription')}</p>
      <button class="retry" type="button" disabled={busy} onclick={setupAgents}>{tr(busy ? 'settings.integrations.configuring' : 'settings.integrations.configureAgents')}</button>
      {#if outcomes.length}
        <ul aria-live="polite">
          {#each outcomes as outcome}
            <li class:error={!outcome.success}>{outcome.backend}: {outcome.success ? tr('settings.integrations.configured') : outcome.error}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else if busy}
    <p role="status">{tr('settings.integrations.loading')}</p>
  {/if}
  {#if error}
    <p class="error" role="alert">{error}</p>
    <button class="retry" type="button" disabled={busy} onclick={refresh}>{tr('settings.integrations.retry')}</button>
  {/if}
</section>

<style>
  section { max-width: 680px; }
  h2 { margin: 0 0 8px; font-size: 19px; font-weight: 600; }
  .description { margin: 0 0 24px; color: var(--fg-tertiary); line-height: 1.6; }
  .feature { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding: 18px 0; border-bottom: 1px solid var(--bd-default); }
  .feature > div { min-width: 0; }
  h3 { margin: 0 0 6px; font-size: 14px; font-weight: 600; }
  .feature p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--fg-tertiary); }
  .toggle { flex: none; display: flex; align-items: center; width: 38px; height: 22px; padding: 3px; border: 1px solid var(--bd-default); border-radius: 12px; background: var(--bg-elevated); cursor: pointer; }
  .toggle span { width: 14px; height: 14px; border-radius: 50%; background: var(--fg-tertiary); }
  .toggle.enabled { background: var(--acc); border-color: var(--acc); justify-content: flex-end; }
  .toggle.enabled span { background: var(--bg-base); }
  button:focus-visible { outline: 2px solid var(--acc); outline-offset: 3px; }
  button:disabled { opacity: .55; cursor: wait; }
  .error { color: var(--st-err); overflow-wrap: anywhere; }
  .retry { padding: 6px 12px; border: 1px solid var(--bd-default); border-radius: 6px; background: var(--bg-elevated); color: inherit; cursor: pointer; }
  .setup { margin-top: 28px; }
  .setup .description { margin-bottom: 14px; font-size: 13px; }
  ul { padding-left: 20px; font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
</style>
