<script lang="ts">
  import Icon from '../shared/Icon.svelte';
  import { selectedTextContext } from '../../lib/stores/documents.ts';
  import { activeModule } from '../../lib/stores/layout.ts';
  import { loadSessions } from '../../lib/stores/sessions.ts';
  import { trackIntake } from '../../lib/stores/workflows.ts';
  import { api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n.ts';

  type Mode = 'intake' | 'plan' | 'clarify' | 'doc';

  let open = $state(false);
  let mode = $state<Mode | null>(null);
  let text = $state('');
  let sending = $state(false);
  let error = $state<string | null>(null);
  let lastAnswer = $state<string | null>(null);

  const modeLabel: Record<Mode, string> = {
    intake: 'Intake',
    plan: 'Plan',
    clarify: 'Clarify',
    doc: 'Ask selected document',
  };

  function reset(): void {
    mode = null;
    text = '';
    error = null;
    lastAnswer = null;
  }

  function close(): void {
    open = false;
    reset();
  }

  function buildRequest(): string {
    const request = text.trim();
    if (mode !== 'doc' || $selectedTextContext === null) return request;
    const selection = $selectedTextContext;
    const line = selection.lineStart === null
      ? ''
      : selection.lineStart === selection.lineEnd
        ? `:${selection.lineStart}`
        : `:${selection.lineStart}-${selection.lineEnd}`;
    const context = [
      `Context file: ${selection.path}${line}`,
      `Selected text:\n${selection.text}`,
    ].join('\n\n');
    return `${context}\n\nQuestion:\n${request}`;
  }

  function canSubmit(): boolean {
    if (mode === null || sending) return false;
    if (text.trim().length === 0) return false;
    if (mode === 'doc' && $selectedTextContext === null) return false;
    return true;
  }

  async function submit(): Promise<void> {
    if (!canSubmit() || mode === null) return;
    sending = true;
    error = null;
    lastAnswer = null;
    const request = buildRequest();
    try {
      if (mode === 'intake' || mode === 'plan') {
        const res = await api.post<{ intake_id: number; specops_session?: { id: string } }>('/api/intakes', {
          request,
          backend_key: 'codebuddy',
          pre_plan: mode === 'plan',
        });
        trackIntake(res.intake_id);
        lastAnswer = `Created ${modeLabel[mode]} ${res.specops_session?.id?.slice(0, 8) ?? res.intake_id}`;
      } else {
        const res = await api.post<{ clarify_id: number; specops_session: { id: string }; reused?: boolean }>('/api/clarifies', {
          request,
          ...(mode === 'doc' && $selectedTextContext !== null ? { document_path: $selectedTextContext.path } : {}),
          backend_key: 'codebuddy',
        });
        lastAnswer = `${res.reused ? 'Reused' : 'Created'} Clarify ${res.specops_session.id.slice(0, 8)}`;
      }
      text = '';
      await loadSessions();
      activeModule.set('chat');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      sending = false;
    }
  }
</script>

<div class="ask-float" class:open>
  {#if !open}
    <button
      type="button"
      class="fab"
      onclick={() => (open = true)}
      aria-label={t('New conversation')}
      title={t('新建对话内容')}
    >
      <Icon name="plus" size={22} />
    </button>
  {:else}
    <div class="panel">
      <header class="panel-head">
        <span class="title">{mode ? modeLabel[mode] : t('New conversation')}</span>
        <button type="button" class="close" onclick={close} aria-label={t('Close')}>
          <Icon name="x" size={14} />
        </button>
      </header>

      {#if mode === null}
        <div class="mode-list">
          <button type="button" class="mode" onclick={() => (mode = 'intake')}>
            <span class="mode-title">Intake</span>
            <span class="mode-desc">分析请求并生成/更新 SpecOps 文档</span>
          </button>
          <button type="button" class="mode" onclick={() => (mode = 'plan')}>
            <span class="mode-title">Plan</span>
            <span class="mode-desc">先进入计划讨论，再决定是否落文档</span>
          </button>
          <button type="button" class="mode" onclick={() => (mode = 'clarify')}>
            <span class="mode-title">Clarify</span>
            <span class="mode-desc">只做澄清问答，可后续升级为 intake</span>
          </button>
          {#if $selectedTextContext !== null}
            <button type="button" class="mode accent" onclick={() => (mode = 'doc')}>
              <span class="mode-title">Ask selected document</span>
              <span class="mode-desc">关联 {$selectedTextContext.path}{#if $selectedTextContext.lineStart !== null}:L{$selectedTextContext.lineStart}{#if $selectedTextContext.lineEnd !== $selectedTextContext.lineStart}-L{$selectedTextContext.lineEnd}{/if}{/if}</span>
            </button>
          {/if}
        </div>
      {:else}
        {#if mode === 'doc' && $selectedTextContext !== null}
          <p class="doc-path">{$selectedTextContext.path}</p>
          <p class="selection-note">
            Selection: {$selectedTextContext.lineStart === null ? 'line unknown' : `L${$selectedTextContext.lineStart}${$selectedTextContext.lineEnd !== $selectedTextContext.lineStart ? `-L${$selectedTextContext.lineEnd}` : ''}`}
          </p>
        {/if}
        <textarea
          bind:value={text}
          placeholder={mode === 'doc' ? t('Ask about the selected file/lines…') : t('Describe the new conversation…')}
          onkeydown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        ></textarea>
        <div class="actions">
          <button type="button" class="ghost" onclick={() => (mode = null)}>{t('Back')}</button>
          <button type="button" class="send" disabled={!canSubmit()} onclick={submit}>
            {sending ? t('Sending…') : t('Create')}
          </button>
        </div>
        {#if error}
          <p class="err">{error}</p>
        {/if}
        {#if lastAnswer}
          <p class="ok">{lastAnswer}</p>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .ask-float {
    position: absolute;
    right: var(--sp-4);
    bottom: var(--sp-4);
    z-index: 10;
  }
  .fab {
    width: 48px;
    height: 48px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--acc) 38%, var(--bd-default));
    background: var(--acc);
    color: var(--fg-on-accent);
    box-shadow: var(--sh-md);
    display: flex;
    align-items: center;
    justify-content: center;
    transition:
      transform var(--t-base),
      box-shadow var(--t-base),
      filter var(--t-fast);
  }
  .fab:hover {
    transform: translateY(-2px) rotate(90deg);
    box-shadow: var(--sh-lg);
    filter: brightness(1.05);
  }
  .panel {
    width: 340px;
    background: var(--bg-elevated);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-lg);
    box-shadow: var(--sh-lg);
    padding: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    transform-origin: bottom right;
    animation: ask-panel-in var(--t-base) cubic-bezier(0.2, 0, 0, 1);
  }
  @keyframes ask-panel-in {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.96);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--sp-1);
  }
  .title {
    font-size: var(--fs-sm);
    font-weight: var(--fw-semi);
    color: var(--fg-primary);
  }
  .close,
  .ghost {
    border-radius: var(--rad-sm);
    border: 1px solid transparent;
    background: transparent;
    color: var(--fg-tertiary);
  }
  .close {
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .close:hover,
  .ghost:hover {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
  .mode-list {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .mode {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    background: var(--bg-base);
    text-align: left;
    transition: background var(--t-fast), border-color var(--t-fast), transform var(--t-fast);
  }
  .mode:hover {
    transform: translateY(-1px);
    background: var(--bg-selected);
    border-color: color-mix(in srgb, var(--acc) 35%, var(--bd-default));
  }
  .mode.accent {
    border-color: color-mix(in srgb, var(--acc) 35%, var(--bd-default));
  }
  .mode-title {
    color: var(--fg-primary);
    font-weight: var(--fw-med);
    font-size: var(--fs-sm);
  }
  .mode-desc,
  .doc-path,
  .selection-note {
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    margin: 0;
    word-break: break-all;
  }
  textarea {
    min-height: 96px;
    max-height: 220px;
    resize: vertical;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    background: var(--bg-input);
    color: var(--fg-primary);
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    line-height: 1.5;
    outline: none;
    transition: border-color var(--t-fast);
  }
  textarea:focus {
    border-color: var(--acc);
  }
  textarea::placeholder {
    color: var(--fg-tertiary);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
  }
  .ghost,
  .send {
    padding: var(--sp-2) var(--sp-3);
    font-size: var(--fs-sm);
  }
  .send {
    border-radius: var(--rad-md);
    border: 1px solid var(--acc);
    background: var(--acc);
    color: var(--fg-on-accent);
    font-weight: var(--fw-med);
    transition: filter var(--t-fast), opacity var(--t-fast);
  }
  .send:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .send:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .err,
  .ok {
    font-size: var(--fs-xs);
    margin: 0;
    font-family: var(--font-mono);
  }
  .err {
    color: var(--st-err);
  }
  .ok {
    color: var(--st-idle);
  }
</style>
