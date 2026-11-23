<script lang="ts">
  /**
   * Settings → Bots. A bot is a named, long-lived agent: persona, Agent,
   * memory scope and a permission limit. They live in the shared Kode
   * backend, so dsh, extensions (team channels) and phones use the same
   * ones. The first bot becomes the default — "my assistant".
   */
  import { open } from '@tauri-apps/plugin-dialog'
  import { botIpc, ipc, type BackendInfo, type Bot, type BotRoster, type PermissionCeiling } from './ipc'
  import { currentLocale, t } from './i18n'

  const tr = $derived.by(() => {
    void $currentLocale
    return (key: string, params?: Record<string, string | number>) => t(key, params)
  })

  const CEILINGS: PermissionCeiling[] = ['plan', 'default', 'acceptEdits', 'bypassPermissions']

  let roster = $state<BotRoster>({ bots: [], default_bot: null })
  let backends = $state<BackendInfo[]>([])
  let editing = $state<Partial<Bot> | null>(null)
  let busy = $state(false)
  let error = $state('')

  $effect(() => {
    void load()
  })

  async function load() {
    try {
      ;[roster, backends] = await Promise.all([botIpc.roster(), ipc.listBackends()])
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function act(work: () => Promise<BotRoster>) {
    busy = true
    error = ''
    try {
      roster = await work()
      editing = null
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  function startNew() {
    editing = { name: '', persona: '', backend_key: backends[0]?.key ?? '', permission_ceiling: 'default', model: null, default_cwd: null }
  }

  async function pickFolder() {
    const path = await open({ directory: true, multiple: false, title: tr('bots.workspace') })
    if (typeof path === 'string' && editing) editing.default_cwd = path
  }

  function save() {
    if (!editing) return
    const bot = { ...editing, model: editing.model?.trim() || null, default_cwd: editing.default_cwd?.trim() || null }
    delete bot.created_at
    delete bot.updated_at
    void act(() => botIpc.upsert(bot))
  }

  function remove(bot: Bot) {
    if (!confirm(tr('bots.confirmDelete', { name: bot.name, scope: `bot:${bot.id}` }))) return
    void act(() => botIpc.remove(bot.id))
  }

  function agentName(key: string) {
    return backends.find((b) => b.key === key)?.name ?? key
  }
</script>

<div class="content-head">
  <div>
    <h2>{tr('bots.title')}</h2>
    <p class="sub">{tr('bots.description')}</p>
  </div>
  <button class="btn primary sm" disabled={busy || editing !== null} onclick={startNew}>{tr('bots.new')}</button>
</div>

{#if error}
  <div class="banner err" role="alert"><pre>{error}</pre></div>
{/if}

{#snippet form(draft: Partial<Bot>)}
  <form class="form" onsubmit={(e) => { e.preventDefault(); save() }}>
    <label>
      <span>{tr('bots.name')}</span>
      <input bind:value={draft.name} maxlength="80" required />
    </label>
    <div class="row">
      <label>
        <span>{tr('bots.agent')}</span>
        <select bind:value={draft.backend_key} required>
          {#each backends as backend (backend.key)}
            <option value={backend.key}>{backend.name ?? backend.key}</option>
          {/each}
          {#if draft.backend_key && !backends.some((b) => b.key === draft.backend_key)}
            <option value={draft.backend_key}>{draft.backend_key}</option>
          {/if}
        </select>
      </label>
      <label>
        <span>{tr('bots.model')}</span>
        <input bind:value={draft.model} placeholder={backends.find((b) => b.key === draft.backend_key)?.default_model ?? ''} />
      </label>
      <label>
        <span>{tr('bots.ceiling')}</span>
        <select bind:value={draft.permission_ceiling}>
          {#each CEILINGS as ceiling (ceiling)}
            <option value={ceiling}>{tr(`bots.ceiling.${ceiling}`)}</option>
          {/each}
        </select>
      </label>
    </div>
    <label>
      <span>{tr('bots.workspace')}</span>
      <div class="pick">
        <input bind:value={draft.default_cwd} spellcheck="false" />
        <button type="button" class="btn ghost sm" onclick={pickFolder}>{tr('bots.pickFolder')}</button>
      </div>
    </label>
    <label>
      <span>{tr('bots.persona')}</span>
      <textarea bind:value={draft.persona} rows="6" placeholder={tr('bots.personaHint')}></textarea>
    </label>
    <div class="form-actions">
      <button type="button" class="btn ghost sm" onclick={() => (editing = null)}>{tr('bots.cancel')}</button>
      <button type="submit" class="btn primary sm" disabled={busy || !draft.name?.trim() || !draft.backend_key}>{tr('bots.save')}</button>
    </div>
  </form>
{/snippet}

{#if editing && !editing.id}
  {@render form(editing)}
{/if}

{#if roster.bots.length === 0 && !editing}
  <p class="empty">{tr('bots.empty')}</p>
{:else}
  <ul class="list">
    {#each roster.bots as bot (bot.id)}
      <li class="item">
        {#if editing?.id === bot.id}
          {@render form(editing)}
        {:else}
          <div class="item-body">
            <div class="item-title">
              <span class="name">{bot.name}</span>
              {#if roster.default_bot === bot.id}<span class="tag ok">{tr('bots.default')}</span>{/if}
              <span class="tag">{agentName(bot.backend_key)}</span>
              <span class="tag">{tr(`bots.ceiling.${bot.permission_ceiling}`)}</span>
            </div>
            {#if bot.persona}<span class="item-desc">{bot.persona}</span>{/if}
            <span class="item-cmd">{tr('bots.memoryScope', { scope: `bot:${bot.id}` })}{bot.default_cwd ? ` · ${bot.default_cwd}` : ''}</span>
          </div>
          <div class="item-actions">
            {#if roster.default_bot !== bot.id}
              <button class="btn ghost sm" disabled={busy} onclick={() => act(() => botIpc.setDefault(bot.id))}>{tr('bots.makeDefault')}</button>
            {/if}
            <button class="btn ghost sm" disabled={busy || editing !== null} onclick={() => (editing = { ...bot })}>{tr('bots.edit')}</button>
            <button class="btn ghost sm danger" disabled={busy} onclick={() => remove(bot)}>{tr('bots.delete')}</button>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .content-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-3);
    margin-bottom: var(--sp-4);
  }
  .content-head h2 {
    margin: 0;
    font-size: var(--fs-xl);
    font-weight: var(--fw-semi);
    letter-spacing: -0.01em;
  }
  .sub {
    margin: 4px 0 0;
    font-size: var(--fs-sm);
    color: var(--fg-tertiary);
  }
  .empty {
    color: var(--fg-tertiary);
    font-size: var(--fs-sm);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .item {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg-card);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
    transition: border-color var(--t-fast);
  }
  .item:hover {
    border-color: var(--bd-strong);
  }
  .item-body {
    flex: 1;
    min-width: 0;
  }
  .item-title {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .name {
    font-size: var(--fs-md);
    font-weight: var(--fw-med);
    color: var(--fg-primary);
  }
  .item-desc {
    display: -webkit-box;
    margin-top: 2px;
    font-size: var(--fs-sm);
    color: var(--fg-secondary);
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .item-cmd {
    display: block;
    margin-top: 2px;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tag {
    font-size: 10px;
    font-weight: var(--fw-med);
    letter-spacing: 0.02em;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--bg-chip);
    color: var(--fg-secondary);
  }
  .tag.ok {
    background: color-mix(in srgb, var(--st-ok) 18%, transparent);
    color: var(--st-ok);
  }
  .item-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-shrink: 0;
  }
  .form {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    margin-bottom: var(--sp-3);
  }
  .list .form {
    margin-bottom: 0;
  }
  .form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 0;
    font-size: var(--fs-sm);
    color: var(--fg-secondary);
  }
  .row {
    display: flex;
    gap: var(--sp-3);
  }
  .pick {
    display: flex;
    gap: var(--sp-2);
  }
  .pick input {
    flex: 1;
    font-family: var(--font-mono);
  }
  .form input,
  .form select,
  .form textarea {
    font-family: var(--font-ui);
    font-size: var(--fs-md);
    color: var(--fg-primary);
    background: var(--bg-input, var(--bg-card));
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    padding: 6px 8px;
  }
  .form textarea {
    resize: vertical;
    line-height: 1.5;
  }
  .form input:focus,
  .form select:focus,
  .form textarea:focus {
    outline: none;
    border-color: var(--acc);
  }
  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
  }
  .banner.err {
    margin-bottom: var(--sp-3);
    padding: 8px var(--sp-3);
    border-radius: var(--rad-md);
    background: color-mix(in srgb, var(--st-err) 12%, transparent);
    color: var(--st-err);
  }
  .banner.err pre {
    margin: 0;
    white-space: pre-wrap;
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-ui);
    font-size: var(--fs-md);
    font-weight: var(--fw-med);
    border-radius: var(--rad-md);
    padding: 7px 14px;
    border: 1px solid transparent;
    cursor: pointer;
  }
  .btn.sm {
    padding: 5px 11px;
    font-size: var(--fs-sm);
  }
  .btn.primary {
    background: var(--acc);
    color: var(--fg-on-accent);
  }
  .btn.primary:hover:not(:disabled) {
    background: var(--acc-hover);
  }
  .btn.ghost {
    background: transparent;
    border-color: var(--bd-default);
    color: var(--fg-secondary);
  }
  .btn.ghost:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--fg-primary);
  }
  .btn.ghost.danger:hover:not(:disabled) {
    color: var(--st-err);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
