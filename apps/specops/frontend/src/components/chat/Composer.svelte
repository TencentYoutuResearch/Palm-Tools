<script lang="ts">
  import Icon from '../shared/Icon.svelte';
  import { shouldSubmitOnEnter } from '../../lib/ime.ts';
  import Markdown from '../shared/Markdown.svelte';
  import { activeSessionId, activeSession, activeTranscript, refreshSession } from '../../lib/stores/sessions.ts';
  import { pendingDocSelection } from '../../lib/stores/documents.ts';
  import { api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n.ts';

  let text = $state('');
  let actionText = $state('');
  let actionBusy = $state(false);
  let actionError: string | null = $state(null);
  let sendError: string | null = $state(null);
  let textareaEl: HTMLTextAreaElement | null = $state(null);
  let imeComposing = $state(false);
  let compositionEndedAt = $state(0);
  let answerSelections = $state<Record<string, number[]>>({});
  let answerInputs = $state<Record<string, string>>({});
  let answerActionKey = $state('');
  let requiredActionKey = $state('');

  function canSend(): boolean {
    const session = $activeSession;
    if (!session) return false;
    if (text.trim().length === 0) return false;
    return session.state === 'active' || session.state === 'awaiting_user';
  }

  function autoGrow(): void {
    if (!textareaEl) return;
    // Reset height to recompute scrollHeight, then clamp to the cap.
    textareaEl.style.height = 'auto';
    const max = Math.round(window.innerHeight * 0.22);
    textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, max)}px`;
  }

  $effect(() => {
    // Re-grow when text changes (incl. after send clears it).
    text;
    autoGrow();
  });

  async function send(): Promise<void> {
    if (!canSend()) return;
    const id = $activeSessionId;
    if (!id) return;
    const message = text.trim();
    const sessionBeforeSend = $activeSession;
    const executionId = sessionBeforeSend?.current_execution?.execution_id ?? null;
    const previousAgentStatus = sessionBeforeSend?.agents?.find((agent) => agent.execution_id === executionId)?.status;
    const optimisticEntry = {
      role: 'user' as const,
      text: message,
      execution_id: executionId,
      kode_session_id: null,
    };
    const body = { text: message };
    text = '';
    if (textareaEl) textareaEl.style.height = 'auto';
    sendError = null;
    // Enter should have an immediate, visible result even before the HTTP
    // acknowledgement/SSE echo arrives: add the user's bubble and mark the
    // attached execution busy. The server snapshot reconciles both shortly.
    activeSession.update((session) => {
      if (session?.id !== id) return session;
      const transcript = [...(session.transcript ?? []), optimisticEntry];
      const agents = (session.agents ?? []).map((agent) => (
        agent.execution_id === executionId ? { ...agent, status: 'running' } : agent
      ));
      activeTranscript.set(transcript);
      return { ...session, transcript, agents };
    });
    try {
      await api.post(`/api/sessions/${id}/input`, body);
      await refreshSession(id);
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
      text = body.text;
      const refreshed = await refreshSession(id);
      activeSession.update((session) => {
        if (session?.id !== id) return session;
        const transcript = (session.transcript ?? []).filter((entry) => entry !== optimisticEntry);
        const agents = refreshed
          ? (session.agents ?? [])
          : (session.agents ?? []).map((agent) => (
              agent.execution_id === executionId && previousAgentStatus !== undefined
                ? { ...agent, status: previousAgentStatus }
                : agent
            ));
        activeTranscript.set(transcript);
        return { ...session, transcript, agents };
      });
      autoGrow();
    }
  }

  function selectAnswer(questionId: string, optionIndex: number, multiSelect: boolean): void {
    const current = answerSelections[questionId] ?? [];
    const next = multiSelect
      ? (current.includes(optionIndex) ? current.filter((index) => index !== optionIndex) : [...current, optionIndex])
      : [optionIndex];
    answerSelections = { ...answerSelections, [questionId]: next };
  }

  function setAnswerInput(questionId: string, value: string): void {
    answerInputs = { ...answerInputs, [questionId]: value };
  }

  async function submitAnswers(): Promise<void> {
    const id = $activeSessionId;
    const action = $activeSession?.required_action;
    if (!id || action?.kind !== 'answer' || actionBusy) return;
    const questions = action.questions ?? [{
      question_id: action.question_id ?? '', prompt: action.prompt ?? '',
      options: action.options ?? [],
    }];
    if (questions.some((question) => (answerSelections[question.question_id]?.length ?? 0) === 0)) return;
    actionBusy = true;
    actionError = null;
    try {
      await api.post(`/api/sessions/${id}/answer`, {
        answers: questions.map((question) => {
          const choiceIndices = answerSelections[question.question_id] ?? [];
          const freeText = answerInputs[question.question_id]?.trim() ?? '';
          return {
            question_id: question.question_id,
            choice_indices: choiceIndices,
            ...(freeText ? { free_text: freeText } : {}),
          };
        }),
      });
      answerSelections = {};
      answerInputs = {};
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      actionBusy = false;
    }
  }

  $effect(() => {
    const action = $activeSession?.required_action;
    const key = action?.kind === 'answer'
      ? (action.questions?.map((question) => question.question_id).join('|') ?? action.question_id ?? '')
      : '';
    if (key !== answerActionKey) {
      answerActionKey = key;
      answerSelections = {};
      answerInputs = {};
    }
  });

  $effect(() => {
    const action = $activeSession?.required_action;
    const key = action === undefined || action === null
      ? ''
      : `${action.kind}:${String(action.interaction_id ?? action.plan_id ?? action.question_id ?? '')}`;
    if (key !== requiredActionKey) {
      requiredActionKey = key;
      actionText = '';
      actionError = null;
    }
  });

  async function respondPlanReview(planId: string, accept: boolean, note?: string): Promise<void> {
    const id = $activeSessionId;
    if (!id || actionBusy) return;
    actionBusy = true;
    actionError = null;
    try {
      await api.post(`/api/sessions/${id}/plan_response`, {
        plan_id: planId,
        accept,
        ...(note ? { note } : {}),
      });
      actionText = '';
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      actionBusy = false;
    }
  }

  async function runSessionAction(kind: string, note?: string): Promise<void> {
    const id = $activeSessionId;
    if (!id || actionBusy) return;
    actionBusy = true;
    actionError = null;
    try {
      await api.post(`/api/sessions/${id}/action`, {
        kind,
        ...(note && note.trim().length > 0 ? { note: note.trim() } : {}),
      });
      actionText = '';
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      actionBusy = false;
    }
  }

  function viewDocument(docPath: string | undefined): void {
    if (docPath) pendingDocSelection.set(docPath);
  }

  function sessionDocumentPath(): string | undefined {
    const path = $activeSession?.document_path;
    return typeof path === 'string' && path.length > 0 ? path : undefined;
  }
</script>

<div class="composer">
  {#if $activeSession?.required_action}
    {@const action = $activeSession.required_action}
    <div class="action-banner">
      {#if action.kind === 'answer' && action.options}
        {@const questions = action.questions ?? [{ question_id: action.question_id ?? '', prompt: action.prompt ?? '', header: action.header, options: action.options, multi_select: action.multi_select }]}
        <div class="answer-questions">
          {#each questions as question, questionIndex (question.question_id)}
            <div class="answer-question">
              <p class="action-prompt">{questionIndex + 1}. {question.prompt}</p>
              <div class="action-options">
                {#each question.options as opt, i (opt.label)}
                  <button type="button" class="action-option" class:selected={answerSelections[question.question_id]?.includes(i) === true} onclick={() => selectAnswer(question.question_id, i, question.multi_select === true)}>
                    <span class="opt-label">{opt.label}</span>
                    {#if opt.description}<span class="opt-desc">{opt.description}</span>{/if}
                  </button>
                {/each}
              </div>
              <textarea
                class="answer-input"
                rows="2"
                value={answerInputs[question.question_id] ?? ''}
                oninput={(event) => setAnswerInput(question.question_id, event.currentTarget.value)}
                placeholder="Optional details or your own answer"
              ></textarea>
            </div>
          {/each}
        </div>
        <button type="button" class="plan-action primary" disabled={actionBusy || questions.some((question) => (answerSelections[question.question_id]?.length ?? 0) === 0)} onclick={submitAnswers}>
          <span>{actionBusy ? 'Submitting…' : 'Submit answers'}</span>
        </button>
      {:else if action.kind === 'permission'}
        <div class="run-action-head">
          <span>{action.title ?? t('Permission required')}</span>
        </div>
        <p class="action-prompt">{action.message ?? t('The agent requires permission to continue.')}</p>
        <div class="plan-review-actions">
          <div class="plan-decision">
            <button type="button" class="plan-action primary" disabled={actionBusy} onclick={() => runSessionAction('permission_allow')}>
              <span>{t('Allow')}</span>
            </button>
            <button type="button" class="plan-action danger" disabled={actionBusy} onclick={() => runSessionAction('permission_deny')}>
              <Icon name="x" size={13} />
              <span>{t('Deny')}</span>
            </button>
          </div>
        </div>
      {:else if action.kind === 'plan_review'}
        {#if action.markdown}
          <div class="plan-review-card">
            <p class="action-badge">{t('Plan Review')}</p>
            <div class="plan-review-markdown">
              <Markdown source={action.markdown} />
            </div>
          </div>
        {/if}
        <textarea class="action-note" bind:value={actionText} rows="2" placeholder={t('Feedback for the agent')}></textarea>
        {@const docPath = action.plan_id ? `.specops/changes/${action.plan_id}` : undefined}
        <div class="plan-review-actions">
          {#if docPath}
            <button type="button" class="plan-action secondary" onclick={() => viewDocument(docPath)}>
              <Icon name="sticky-note" size={13} />
              <span>{t('View document')}</span>
            </button>
          {/if}
          <div class="plan-decision">
            <button type="button" class="plan-action primary" disabled={actionBusy} onclick={() => respondPlanReview(action.plan_id ?? '', true)}>
              <span>{t('Approve plan')}</span>
            </button>
            <button type="button" class="plan-action danger" disabled={actionBusy || actionText.trim().length === 0} onclick={() => respondPlanReview(action.plan_id ?? '', false, actionText)}>
              <Icon name="x" size={13} />
              <span>{t('Revise')}</span>
            </button>
          </div>
        </div>
      {:else if action.kind === 'run_in_worktree'}
        <p class="action-prompt">{t('Launch the generated tasks from the interactive document.')}</p>
        <div class="plan-review-actions">
          <button type="button" class="plan-action secondary" onclick={() => viewDocument(sessionDocumentPath())}>
            <Icon name="file-text" size={13} />
            <span>{t('Open document')}</span>
          </button>
        </div>
      {:else if action.kind === 'promote_intake'}
        <div class="run-action-head">
          <span>{t('Clarification complete')}</span>
        </div>
        <p class="action-prompt">{action.prompt ?? t('Start intake with the approved plan and confirmed decisions.')}</p>
        <div class="plan-review-actions">
          <button type="button" class="plan-action primary" disabled={actionBusy} onclick={() => runSessionAction('promote_intake')}>
            <Icon name="play" size={13} />
            <span>{actionBusy ? t('Starting…') : t('Start intake')}</span>
          </button>
        </div>
      {:else if action.kind === 'resume'}
        <div class="run-action-head">
          <span>{t('Execution needs to resume')}</span>
        </div>
        <p class="action-prompt">{action.reason ?? t('The previous execution is no longer attached. Resume from the durable workflow state.')}</p>
        <div class="plan-review-actions">
          <button type="button" class="plan-action primary" disabled={actionBusy} onclick={() => runSessionAction('resume')}>
            <Icon name="refresh" size={13} />
            <span>{actionBusy ? t('Resuming…') : t('Resume execution')}</span>
          </button>
        </div>
      {:else if action.kind === 'verify'}
        <p class="action-prompt">{t('Verification is ready to run for this SpecOps run.')}</p>
        <div class="plan-review-actions">
          <button type="button" class="plan-action primary" disabled={actionBusy} onclick={() => runSessionAction('verify')}>
            <Icon name="play" size={13} />
            <span>{t('Run verify')}</span>
          </button>
        </div>
      {:else if action.kind === 'review'}
        <div class="run-action-head">
          <span>{t('Review patch')}</span>
          <strong>{action.patch_files?.length ?? 0} {t('file(s) changed')}</strong>
        </div>
        {#if action.review_note}
          <p class="review-note">{action.review_note}</p>
        {/if}
        {#if action.patch_files?.length}
          <ol class="changed-files">
            {#each action.patch_files as file (file)}
              <li>{file}</li>
            {/each}
          </ol>
        {/if}
        <textarea class="action-note" bind:value={actionText} rows="2" placeholder={t('Feedback for the agent')}></textarea>
        <div class="plan-review-actions">
          <div class="plan-decision">
            <button type="button" class="plan-action primary" disabled={actionBusy} onclick={() => runSessionAction('accept')}>
              <span>{t('Accept task')}</span>
            </button>
            <button type="button" class="plan-action secondary" disabled={actionBusy || actionText.trim().length === 0} onclick={() => runSessionAction('feedback', actionText)}>
              <span>{t('Request changes')}</span>
            </button>
            <button type="button" class="plan-action danger" disabled={actionBusy} onclick={() => runSessionAction('reject', actionText)}>
              <Icon name="x" size={13} />
              <span>{t('Reject run')}</span>
            </button>
          </div>
        </div>
      {:else if action.kind === 'apply_patch'}
        <p class="action-prompt">{t('The run is accepted and ready to apply back to the workspace.')}</p>
        <div class="plan-review-actions">
          <div class="plan-decision">
            <button type="button" class="plan-action primary" disabled={actionBusy} onclick={() => runSessionAction('apply_with_verify')}>
              <span>{t('Apply with verify')}</span>
            </button>
            <button type="button" class="plan-action secondary" disabled={actionBusy} onclick={() => runSessionAction('apply')}>
              <span>{t('Apply only')}</span>
            </button>
            <button type="button" class="plan-action danger" disabled={actionBusy} onclick={() => runSessionAction('rollback')}>
              <Icon name="rotate-ccw" size={13} />
              <span>{t('Rollback')}</span>
            </button>
          </div>
        </div>
      {:else}
        <p class="action-prompt">{t('Action required')}: {action.kind}</p>
      {/if}
      {#if actionError !== null}
        <p class="action-error">{actionError}</p>
      {/if}
    </div>
  {/if}

  <div class="input-wrap">
    <div class="input-card" class:active={canSend()}>
      <textarea
        bind:this={textareaEl}
        bind:value={text}
        rows="1"
        placeholder={t('Send a message…  (Enter to send · Shift+Enter for newline)')}
        oncompositionstart={() => (imeComposing = true)}
        oncompositionend={() => { imeComposing = false; compositionEndedAt = Date.now(); }}
        onkeydown={(e) => {
          if (shouldSubmitOnEnter(e, imeComposing, compositionEndedAt)) {
            e.preventDefault();
            send();
          }
        }}
      ></textarea>
      <button
        type="button"
        class="send-btn"
        disabled={!canSend()}
        onclick={send}
        aria-label={t('Send')}
        title={t('Send')}
      >
        <Icon name="send" size={15} />
      </button>
    </div>
    {#if sendError !== null}
      <p class="send-error">{sendError}</p>
    {/if}
  </div>
</div>

<style>
  .composer {
    flex-shrink: 0;
    /* Slack-style: composer floats at the bottom with breathing space on
       all sides, sitting on the base background (no top border). */
    padding: var(--sp-1) var(--sp-3) var(--sp-3);
    background: transparent;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .action-banner {
    padding: var(--sp-2) var(--sp-3);
    background: color-mix(in srgb, var(--st-info) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--st-info) 30%, transparent);
    border-radius: var(--rad-md);
    font-size: var(--fs-sm);
  }
  .action-prompt {
    margin: 0 0 var(--sp-2);
    color: var(--fg-primary);
  }
  .action-options {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .answer-questions {
    max-height: min(48vh, 520px);
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    padding-right: var(--sp-1);
    margin-right: calc(-1 * var(--sp-1));
  }
  .answer-question + .answer-question {
    margin-top: var(--sp-3);
    padding-top: var(--sp-3);
    border-top: 1px solid var(--bd-default);
  }
  .action-option {
    display: flex;
    flex-direction: column;
    text-align: left;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    background: var(--bg-elevated);
    color: var(--fg-primary);
    transition: background var(--t-fast), border-color var(--t-fast);
  }
  .action-option:hover {
    background: var(--bg-selected);
    border-color: var(--acc);
  }

  .action-option.selected {
    border-color: var(--acc);
    background: var(--acc-soft);
  }
  .opt-label {
    font-weight: var(--fw-med);
  }
  .opt-desc {
    font-size: var(--fs-xs);
    color: var(--fg-secondary);
    margin-top: 2px;
  }
  .answer-input {
    box-sizing: border-box;
    width: 100%;
    min-height: 54px;
    margin-top: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    resize: vertical;
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    background: var(--bg-input);
  }

  /* plan_review */
  .plan-review-card {
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg-elevated);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    margin-bottom: var(--sp-2);
    max-height: 360px;
    overflow-y: auto;
  }
  .action-badge {
    display: inline-block;
    font-size: var(--fs-xs);
    font-weight: var(--fw-semi);
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--acc);
    margin: 0 0 var(--sp-1);
    padding: 0;
  }
  .plan-review-markdown :global(p) {
    margin: var(--sp-1) 0;
    font-size: var(--fs-sm);
    line-height: 1.6;
    color: var(--fg-primary);
  }
  .plan-review-markdown :global(h1),
  .plan-review-markdown :global(h2),
  .plan-review-markdown :global(h3) {
    font-size: var(--fs-sm);
    font-weight: var(--fw-semi);
    margin: var(--sp-2) 0 var(--sp-1);
  }
  .plan-review-markdown :global(pre) {
    background: var(--bg-code);
    padding: var(--sp-2);
    border-radius: var(--rad-sm);
    font-size: var(--fs-xs);
    overflow-x: auto;
  }
  .plan-review-markdown :global(code) {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }
  .plan-review-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--sp-2);
  }
  .plan-decision {
    display: flex;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
  .run-action-head {
    display: flex;
    justify-content: space-between;
    gap: var(--sp-2);
    align-items: center;
    margin-bottom: var(--sp-2);
    color: var(--fg-secondary);
  }
  .run-action-head span {
    font-weight: var(--fw-semi);
    color: var(--fg-primary);
  }
  .run-action-head strong {
    font-size: var(--fs-xs);
    font-weight: var(--fw-med);
    color: var(--fg-tertiary);
  }
  .review-note {
    margin: 0 0 var(--sp-2);
    color: var(--fg-primary);
    line-height: 1.5;
  }
  .changed-files {
    margin: 0 0 var(--sp-2);
    padding-left: var(--sp-4);
    color: var(--fg-secondary);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.5;
  }
  .action-note {
    width: 100%;
    box-sizing: border-box;
    min-height: 56px;
    margin-bottom: var(--sp-2);
    padding: var(--sp-2);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    background: var(--bg-input);
  }
  .action-error {
    margin: var(--sp-2) 0 0;
    color: var(--st-err);
    font-size: var(--fs-xs);
  }
  .plan-action:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .plan-action {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    padding: var(--sp-1) var(--sp-3);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    font-size: var(--fs-sm);
    font-weight: var(--fw-med);
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast);
  }
  .plan-action.secondary {
    background: transparent;
    color: var(--fg-secondary);
    border-color: var(--bd-default);
  }
  .plan-action.secondary:hover {
    background: var(--bg-selected);
    color: var(--fg-primary);
  }
  .plan-action.primary {
    background: color-mix(in srgb, var(--st-ok) 15%, transparent);
    color: var(--st-ok);
    border-color: color-mix(in srgb, var(--st-ok) 30%, transparent);
  }
  .plan-action.primary:hover {
    background: color-mix(in srgb, var(--st-ok) 25%, transparent);
  }
  .plan-action.danger {
    background: color-mix(in srgb, var(--st-err) 10%, transparent);
    color: var(--st-err);
    border-color: color-mix(in srgb, var(--st-err) 25%, transparent);
  }
  .plan-action.danger:hover {
    background: color-mix(in srgb, var(--st-err) 20%, transparent);
  }

  /* Unified input card: textarea + send button live inside one rounded frame */
  .input-wrap {
    max-width: 880px;
    margin: 0 auto;
    width: 100%;
  }
  .input-card {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-3);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-lg);
    background: var(--bg-input);
    box-shadow: var(--sh-sm);
    transition: border-color var(--t-fast), box-shadow var(--t-fast);
  }
  .input-card:focus-within {
    border-color: var(--acc);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--acc) 14%, transparent);
  }
  .input-card.active {
    border-color: color-mix(in srgb, var(--acc) 55%, var(--bd-default));
  }
  textarea {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--fg-primary);
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    line-height: 1.55;
    padding: var(--sp-2) 0;
    min-height: 28px;
    max-height: 22vh;
    resize: none;
    outline: none;
    overflow-y: auto;
  }
  textarea::placeholder {
    color: var(--fg-tertiary);
  }
  .send-btn {
    width: 32px;
    height: 32px;
    margin-bottom: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    border: 1px solid transparent;
    background: var(--acc);
    color: var(--fg-on-accent);
    box-shadow: var(--sh-sm);
    transition: filter var(--t-fast), opacity var(--t-fast), transform var(--t-fast);
  }
  .send-btn:hover:not(:disabled) {
    filter: brightness(1.08);
    transform: translateY(-1px);
  }
  .send-btn:active:not(:disabled) {
    transform: translateY(0);
  }
  .send-btn:disabled {
    background: var(--bg-chip);
    color: var(--fg-tertiary);
    box-shadow: none;
    cursor: not-allowed;
  }
  .send-error {
    margin: var(--sp-1) var(--sp-1) 0;
    color: var(--st-err);
    font-size: var(--fs-xs);
  }
</style>
