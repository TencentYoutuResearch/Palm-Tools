<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../shared/Icon.svelte';
  import AvatarSprite from '../shared/AvatarSprite.svelte';
  import Markdown from '../shared/Markdown.svelte';
  import AvatarPicker from './AvatarPicker.svelte';
  import { api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n.ts';
  import { onWindowDragMouseDown } from '../../lib/windowDrag.ts';

  type ProfileName = 'default' | 'analysis' | 'implementation' | 'review';
  type Profile = { backend?: string; model?: string; avatar?: string; prompt_file?: string };
  type Backend = { key: string; display_name: string; model_flag?: string | null; enabled: boolean };
  type DiscoveredModel = { id: string; label: string; description?: string; is_default?: boolean };
  type ModelCatalog = { backend: string; source: string; version?: string; custom_allowed: boolean; models: DiscoveredModel[]; warning?: string };
  type Resolved = { backend: string; model?: string; avatar?: string };
  type SettingsResponse = {
    profiles: Record<ProfileName, Profile>;
    resolved: Record<ProfileName, Resolved>;
    backends: Backend[];
    prompts: Record<'analysis' | 'implementation' | 'review', { content: string; source: string; builtin: boolean }>;
  };

  const names: ProfileName[] = ['default', 'analysis', 'implementation', 'review'];
  let data = $state<SettingsResponse | null>(null);
  let draft = $state<Record<ProfileName, Profile>>({ default: {}, analysis: {}, implementation: {}, review: {} });
  let loading = $state(true);
  let saving = $state(false);
  let dirty = $state(false);
  let error = $state<string | null>(null);
  let saved = $state(false);
  let editingAvatar = $state<ProfileName | null>(null);
  let previewingPrompt = $state<ProfileName | null>(null);
  let modelCatalogs = $state<Record<string, ModelCatalog>>({});
  let modelLoading = $state<Record<string, boolean>>({});
  let modelErrors = $state<Record<string, string>>({});
  let customModelEditing = $state<Partial<Record<ProfileName, boolean>>>({});

  function cloneProfiles(profiles: Record<ProfileName, Profile>): Record<ProfileName, Profile> {
    return Object.fromEntries(names.map((name) => [name, { ...profiles[name] }])) as Record<ProfileName, Profile>;
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      data = await api.get<SettingsResponse>('/api/settings/agents');
      draft = cloneProfiles(data.profiles);
      for (const backend of new Set(names.map((name) => resolvedBackend(name)))) void loadModels(backend);
      dirty = false;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  function update(name: ProfileName, field: keyof Profile, value: string): void {
    draft[name] = field === 'backend'
      ? { ...draft[name], backend: value || undefined, model: undefined }
      : { ...draft[name], [field]: value || undefined };
    if (field === 'backend') {
      customModelEditing = { ...customModelEditing, [name]: false };
      void loadModels(resolvedBackend(name));
    }
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

  function backendChoices(name: ProfileName): Backend[] {
    const choices = data?.backends ?? [];
    const configured = draft[name].backend;
    if (!configured || choices.some((backend) => backend.key === configured)) return choices;
    return [{ key: configured, display_name: configured, enabled: true }, ...choices];
  }

  function supportsModel(name: ProfileName): boolean {
    const key = resolvedBackend(name);
    if (modelCatalogs[key] !== undefined) return modelCatalogs[key].custom_allowed;
    const backend = data?.backends.find((item) => item.key === key);
    return backend === undefined || Boolean(backend.model_flag);
  }

  async function loadModels(backend: string, refresh = false): Promise<void> {
    if (!backend || modelLoading[backend] || (!refresh && modelCatalogs[backend])) return;
    modelLoading = { ...modelLoading, [backend]: true };
    const nextErrors = { ...modelErrors };
    delete nextErrors[backend];
    modelErrors = nextErrors;
    try {
      const suffix = refresh ? '?refresh=1' : '';
      const catalog = await api.get<ModelCatalog>(`/api/settings/models/${encodeURIComponent(backend)}${suffix}`);
      modelCatalogs = { ...modelCatalogs, [backend]: catalog };
    } catch (err) {
      modelErrors = { ...modelErrors, [backend]: err instanceof Error ? err.message : String(err) };
    } finally {
      modelLoading = { ...modelLoading, [backend]: false };
    }
  }

  function catalogFor(name: ProfileName): ModelCatalog | undefined {
    return modelCatalogs[resolvedBackend(name)];
  }

  function modelChoice(name: ProfileName): string {
    if (customModelEditing[name]) return '__custom__';
    const value = draft[name].model ?? '';
    if (!value) return '';
    return catalogFor(name)?.models.some((model) => model.id === value) ? value : '__custom__';
  }

  function chooseModel(name: ProfileName, value: string): void {
    if (value === '__custom__') {
      const current = draft[name].model ?? '';
      customModelEditing = { ...customModelEditing, [name]: true };
      if (catalogFor(name)?.models.some((model) => model.id === current)) update(name, 'model', '');
      else { dirty = true; saved = false; }
      return;
    }
    customModelEditing = { ...customModelEditing, [name]: false };
    update(name, 'model', value);
  }

  function resolvedAvatar(name: ProfileName): string | null {
    if (draft[name].avatar) return draft[name].avatar;
    if (name !== 'default' && draft.default.avatar) return draft.default.avatar;
    return data?.resolved[name]?.avatar ?? null;
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
              {#if name !== 'default' && (draft[name].backend || draft[name].model || draft[name].avatar || draft[name].prompt_file)}
                <button class="inherit" type="button" onclick={() => reset(name)}>{t('specops.settings.reset')}</button>
              {/if}
            </div>

            <div class="fields">
              <label class="runtime-field">
                <span class="field-label-row"><span>{t('specops.settings.backend')}</span></span>
                <select value={draft[name].backend ?? ''} onchange={(event) => update(name, 'backend', event.currentTarget.value)}>
                  <option value="" selected={!draft[name].backend}>{name === 'default' ? t('specops.settings.builtinDefault') : t('specops.settings.inheritDefault')}</option>
                  {#each backendChoices(name) as backend (backend.key)}
                    <option value={backend.key}>{backend.display_name || backend.key}</option>
                  {/each}
                </select>
              </label>
              <label class="runtime-field model-field">
                <span class="field-label-row">
                  <span>{t('specops.settings.model')}</span>
                  <button type="button" class="model-refresh" onclick={() => loadModels(resolvedBackend(name), true)} disabled={modelLoading[resolvedBackend(name)]} aria-label={t('specops.settings.refreshModels')}>
                    <Icon name="refresh" size={12} />
                  </button>
                </span>
                <select value={modelChoice(name)} onchange={(event) => chooseModel(name, event.currentTarget.value)} disabled={!supportsModel(name)}>
                  <option value="">{t('specops.settings.backendDefault')}</option>
                  {#each catalogFor(name)?.models ?? [] as model (model.id)}
                    <option value={model.id}>{model.label}{model.is_default ? ` · ${t('specops.settings.defaultModel')}` : ''}</option>
                  {/each}
                  {#if supportsModel(name)}<option value="__custom__">{t('specops.settings.customModel')}</option>{/if}
                </select>
                {#if modelChoice(name) === '__custom__'}
                  <input class="custom-model" value={draft[name].model ?? ''} oninput={(event) => update(name, 'model', event.currentTarget.value)} placeholder={t('specops.settings.modelId')} />
                {/if}
                <small class="catalog-status" class:error={Boolean(modelErrors[resolvedBackend(name)])}>
                  {#if modelLoading[resolvedBackend(name)]}
                    {t('specops.settings.detectingModels')}
                  {:else if modelErrors[resolvedBackend(name)]}
                    {t('specops.settings.customModelFallback')}
                  {:else if catalogFor(name)}
                    {catalogFor(name)?.models.length ?? 0} {t('specops.settings.modelsDetected')} · {catalogFor(name)?.source}{catalogFor(name)?.version ? ` ${catalogFor(name)?.version}` : ''}
                  {:else}
                    {t('specops.settings.customModelFallback')}
                  {/if}
                </small>
              </label>
            </div>

            <label class="avatar-field">
              <span>{t('specops.settings.avatar')}</span>
              <button class="avatar-editor" type="button" onclick={() => editingAvatar = name}>
                <span class="avatar-preview"><AvatarSprite avatarId={resolvedAvatar(name)} backendKey={resolvedBackend(name)} status="idle" size={30} /></span>
                <span><strong>{resolvedAvatar(name)?.replace(/^gallery\//, '') ?? t('specops.settings.followBackend')}</strong><small>{t('specops.settings.editAvatar')}</small></span>
                <Icon name="chevron-right" size={14} />
              </button>
            </label>

            {#if editingAvatar === name}
              <AvatarPicker
                backendKey={resolvedBackend(name)}
                currentAvatarId={resolvedAvatar(name)}
                onPick={(avatarId) => { update(name, 'avatar', avatarId ?? ''); editingAvatar = null; }}
                onClose={() => editingAvatar = null}
              />
            {/if}

            {#if name !== 'default'}
              <div class="prompt-section">
                <label class="prompt-file">
                  <span>{t('specops.settings.promptFile')}</span>
                  <input
                    value={draft[name].prompt_file ?? ''}
                    oninput={(event) => update(name, 'prompt_file', event.currentTarget.value)}
                    placeholder={name === 'analysis' ? '.specops/agents/clarify.md' : `.specops/agents/${name}.md`}
                  />
                  <small>{draft[name].prompt_file || data.prompts[name].source}</small>
                </label>
                <button class="preview-toggle" type="button" onclick={() => previewingPrompt = previewingPrompt === name ? null : name}>
                  {previewingPrompt === name ? t('specops.settings.hidePreview') : t('specops.settings.previewMarkdown')}
                </button>
                {#if previewingPrompt === name}
                  <div class="prompt-preview"><Markdown source={data.prompts[name].content} /></div>
                {/if}
              </div>
            {/if}

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
  .fields { margin-top: 14px; display: grid; grid-template-columns: 1fr 1fr; align-items: start; gap: 12px; padding: 11px; border: 1px solid var(--bd-muted); border-radius: var(--rad-md); background: color-mix(in srgb, var(--bg-input) 54%, transparent); }
  .avatar-field { margin-top: 12px; }
  .avatar-preview { width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid var(--bd-default); border-radius: var(--rad-md); background: var(--bg-input); }
  .avatar-editor { width: 100%; display: grid; grid-template-columns: 34px minmax(0, 1fr) 16px; align-items: center; gap: 9px; padding: 6px 8px; border: 1px solid var(--bd-default); border-radius: var(--rad-md); background: var(--bg-input); color: var(--fg-secondary); text-align: left; }
  .avatar-editor:hover { border-color: var(--bd-focus); }
  .avatar-editor > span:nth-child(2) { min-width: 0; display: grid; gap: 2px; }
  .avatar-editor strong { overflow: hidden; color: var(--fg-primary); font-family: var(--font-mono); font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; }
  .avatar-editor small { color: var(--fg-tertiary); font-size: 9px; }
  .prompt-file { margin-top: 12px; }
  .prompt-file small { overflow: hidden; color: var(--fg-tertiary); font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
  .prompt-section { position: relative; }
  .preview-toggle { margin-top: 7px; padding: 0; border: 0; background: transparent; color: var(--acc); font-size: var(--fs-xs); }
  .prompt-preview { max-height: 300px; margin-top: 9px; padding: 12px; overflow: auto; border: 1px solid var(--bd-muted); border-radius: var(--rad-md); background: var(--bg-base); }
  label { display: grid; gap: 6px; color: var(--fg-secondary); font-size: var(--fs-xs); }
  .runtime-field { min-width: 0; align-content: start; grid-template-rows: 22px 34px auto; gap: 5px; }
  .field-label-row { min-height: 22px; display: flex; align-items: center; justify-content: space-between; }
  .model-refresh { width: 22px; height: 22px; display: grid; place-items: center; padding: 0; border: 1px solid transparent; border-radius: var(--rad-sm); background: transparent; color: var(--fg-tertiary); }
  .model-refresh:hover:not(:disabled) { border-color: var(--bd-default); background: var(--bg-hover); color: var(--fg-primary); }
  .model-refresh:disabled { opacity: .45; }
  .fields label > small { overflow: hidden; color: var(--fg-tertiary); font-family: var(--font-mono); font-size: 8px; line-height: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .fields label > small.error { color: var(--st-warn); }
  select, input { width: 100%; height: 34px; padding: 0 9px; border: 1px solid var(--bd-default); border-radius: var(--rad-md); background: var(--bg-input); color: var(--fg-primary); outline: none; }
  select:focus, input:focus { border-color: var(--bd-focus); }
  select { cursor: pointer; }
  .custom-model { margin-top: 0; font-family: var(--font-mono); }
  .catalog-status { min-height: 11px; padding: 0 2px; }
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
