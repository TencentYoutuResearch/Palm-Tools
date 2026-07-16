<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../shared/Icon.svelte';
  import { api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n.ts';
  import { onWindowDragMouseDown } from '../../lib/windowDrag.ts';

  type ProfileName = 'default' | 'analysis' | 'implementation' | 'review';
  type Profile = { backend?: string; model?: string };
  type Backend = { key: string; display_name: string; model_flag?: string | null; enabled: boolean };
  type Resolved = { backend: string; model?: string };
  type SettingsResponse = {
    profiles: Record<ProfileName, Profile>;
    resolved: Record<ProfileName, Resolved>;
    backends: Backend[];
  };

  const names: ProfileName[] = ['default', 'analysis', 'implementation', 'review'];

  let data = $state<SettingsResponse | null>(null);
  let draft = $state<Record<ProfileName, Profile>>({ default: {}, analysis: {}, implementation: {}, review: {} });
  let loading = $state(true);
  let saving = $state(false);
  let dirty = $state(false);
  let error = $state<string | null>(null);
  let saved = $state(false);

  function cloneProfiles(profiles: Record<ProfileName, Profile>): Record<ProfileName, Profile> {
    return Object.fromEntries(names.map((name) => [name, { ...profiles[name] }])) as Record<ProfileName, Profile>;
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      data = await api.get<SettingsResponse>('/api/settings/agents');
      draft = cloneProfiles(data.profiles);
      dirty = false;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  function update(name: ProfileName, field: keyof Profile, value: string): void {
    draft[name] = { ...draft[name], [field]: value || undefined };
    dirty = true;
    saved = false;
  }

  function reset(name: ProfileName): void {
    draft[name] = {};
    dirty = true;
    saved = false;
  }

  function resolvedBackend(name: ProfileName): string {
    return draft[name].backend || (name === 'default' ? 'codebuddy' : draft.default.backend || data?.resolved[name]?.backend || 'codebuddy');
  }

  function supportsModel(name: ProfileName): boolean {
    const key = resolvedBackend(name);
    const backend = data?.backends.find((item) => item.key === key);
    return backend === undefined || Boolean(backend.model_flag);
  }

  async function save(): Promise<void> {
    if (!dirty || saving) return;
    saving = true;
    error = null;
    saved = false;
    try {
      data = await api.put<SettingsResponse>('/api/settings/agents', { profiles: draft });
      draft = cloneProfiles(data.profiles);
      dirty = false;
      saved = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  onMount(() => { void load(); });
</script>

<section class="settings-module">
  <header class="settings-head" role="presentation" data-tauri-drag-region onmousedown={onWindowDragMouseDown}>
    <div data-tauri-drag-region>
      <span class="eyebrow">{t('specops.settings.eyebrow')}</span>
      <h1>{t('specops.settings.agents')}</h1>
    </div>
    <button class="reload" type="button" onclick={load} disabled={loading || saving} aria-label={t('specops.action.refresh')}>
      <Icon name="refresh" size={14} />
    </button>
  </header>

  <div class="settings-scroll">
    <div class="intro">
      <p>{t('specops.settings.intro')}</p>
      <span>{t('specops.settings.newRuns')}</span>
    </div>

    {#if loading && data === null}
      <p class="empty">{t('specops.loading')}</p>
    {:else if data !== null}
      <div class="profiles">
        {#each names as name (name)}
          <article class="profile-card">
            <div class="profile-title">
              <div>
                <h2>{t(`specops.settings.profile.${name}`)}</h2>
                <p>{t(`specops.settings.profile.${name}Desc`)}</p>
              </div>
              {#if name !== 'default' && (draft[name].backend || draft[name].model)}
                <button class="inherit" type="button" onclick={() => reset(name)}>{t('specops.settings.reset')}</button>
              {/if}
            </div>

            <div class="fields">
              <label>
                <span>{t('specops.settings.backend')}</span>
                <select value={draft[name].backend ?? ''} onchange={(event) => update(name, 'backend', event.currentTarget.value)}>
                  <option value="">{name === 'default' ? t('specops.settings.builtinDefault') : t('specops.settings.inheritDefault')}</option>
                  {#each data.backends as backend (backend.key)}
                    <option value={backend.key}>{backend.display_name || backend.key}</option>
                  {/each}
                </select>
              </label>
              <label>
                <span>{t('specops.settings.model')}</span>
                <input
                  value={draft[name].model ?? ''}
                  oninput={(event) => update(name, 'model', event.currentTarget.value)}
                  placeholder={t('specops.settings.backendDefault')}
                  disabled={!supportsModel(name)}
                />
              </label>
            </div>

            <div class="resolved">
              <span>{t('specops.settings.effective')}</span>
              <code>{resolvedBackend(name)}</code>
              <span class="slash">/</span>
              <code>{draft[name].model || draft.default.model || t('specops.settings.backendDefault')}</code>
            </div>
          </article>
        {/each}
      </div>
    {/if}

    {#if error}<p class="message error">{error}</p>{/if}
    {#if saved}<p class="message ok">{t('specops.settings.saved')}</p>{/if}
  </div>

  <footer class="settings-actions">
    <span>{dirty ? t('specops.settings.unsaved') : t('specops.settings.synced')}</span>
    <button type="button" class="secondary" onclick={load} disabled={!dirty || saving}>{t('specops.action.cancel')}</button>
    <button type="button" class="primary" onclick={save} disabled={!dirty || saving}>{saving ? t('specops.settings.saving') : t('specops.settings.save')}</button>
  </footer>
</section>

<style>
  .settings-module { height: 100%; min-height: 0; display: grid; grid-template-rows: 72px minmax(0, 1fr) 58px; background: var(--bg-base); }
  .settings-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 24px; border-bottom: 1px solid var(--bd-default); background: var(--bg-sidebar); -webkit-app-region: drag; user-select: none; }
  .settings-head h1 { margin: 2px 0 0; font-size: var(--fs-xl); }
  .eyebrow { color: var(--fg-tertiary); font-size: var(--fs-xs); letter-spacing: .08em; text-transform: uppercase; }
  .reload { width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid var(--bd-default); border-radius: var(--rad-md); background: transparent; color: var(--fg-secondary); -webkit-app-region: no-drag; }
  .settings-scroll { min-height: 0; overflow: auto; padding: 24px; }
  .intro { max-width: 900px; margin: 0 auto 18px; display: flex; justify-content: space-between; gap: 20px; color: var(--fg-secondary); }
  .intro p { margin: 0; }
  .intro span { color: var(--st-warn); font-size: var(--fs-sm); white-space: nowrap; }
  .profiles { max-width: 900px; margin: 0 auto; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
  .profile-card { padding: 18px; border: 1px solid var(--bd-default); border-radius: var(--rad-lg); background: var(--bg-elevated); box-shadow: var(--sh-sm); }
  .profile-title { min-height: 54px; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .profile-title h2 { margin: 0 0 4px; font-size: var(--fs-lg); text-transform: capitalize; }
  .profile-title p { margin: 0; color: var(--fg-tertiary); font-size: var(--fs-sm); }
  .inherit { border: 0; background: transparent; color: var(--acc); font-size: var(--fs-xs); padding: 3px 0; white-space: nowrap; }
  .fields { margin-top: 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  label { display: grid; gap: 6px; color: var(--fg-secondary); font-size: var(--fs-xs); }
  select, input { width: 100%; height: 34px; padding: 0 9px; border: 1px solid var(--bd-default); border-radius: var(--rad-md); background: var(--bg-input); color: var(--fg-primary); outline: none; }
  select:focus, input:focus { border-color: var(--bd-focus); }
  input:disabled { opacity: .55; }
  .resolved { margin-top: 14px; display: flex; align-items: center; gap: 6px; color: var(--fg-tertiary); font-size: var(--fs-xs); }
  .resolved code { color: var(--st-info); font-family: var(--font-mono); }
  .slash { opacity: .5; }
  .message { max-width: 900px; margin: 14px auto 0; padding: 10px 12px; border-radius: var(--rad-md); font-size: var(--fs-sm); }
  .message.error { color: var(--st-err); background: color-mix(in srgb, var(--st-err) 10%, transparent); }
  .message.ok { color: var(--st-ok); background: color-mix(in srgb, var(--st-ok) 10%, transparent); }
  .empty { color: var(--fg-tertiary); text-align: center; }
  .settings-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 0 24px; border-top: 1px solid var(--bd-default); background: var(--bg-sidebar); }
  .settings-actions > span { margin-right: auto; color: var(--fg-tertiary); font-size: var(--fs-sm); }
  .settings-actions button { height: 32px; padding: 0 14px; border-radius: var(--rad-md); border: 1px solid var(--bd-default); }
  .settings-actions button:disabled { opacity: .45; cursor: default; }
  .secondary { background: transparent; color: var(--fg-secondary); }
  .primary { background: var(--acc); border-color: var(--acc) !important; color: var(--fg-on-accent); font-weight: var(--fw-semi); }
  @media (max-width: 760px) { .profiles { grid-template-columns: 1fr; } .intro { display: block; } .intro span { display: block; margin-top: 8px; } }
</style>
