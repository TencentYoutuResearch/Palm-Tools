<script lang="ts">
  import Icon from '../shared/Icon.svelte';
  import StatusBadge from '../shared/StatusBadge.svelte';
  import { activeSession, activeSessionId, loadSessions, selectSession } from '../../lib/stores/sessions.ts';
  import { api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n.ts';
  import { onWindowDragMouseDown } from '../../lib/windowDrag.ts';

  const shortId = (id?: string): string => id ? id.slice(0, 8) : '—';
  const resumablePhases = new Set([
    'run_in_worktree',
    'analyze_request',
    'clarify',
    'plan_discussion',
    'solution_options',
    'plan_approved',
  ]);
  const stateTone = (state?: string | null): 'active' | 'busy' | 'error' | 'completed' | 'archived' =>
    state === 'awaiting_user'
      ? 'busy'
      : state === 'failed' || state === 'cancelled'
        ? 'error'
        : state === 'completed'
          ? 'completed'
          : state === 'closed'
            ? 'archived'
            : 'active';

  let resumeBusy = $state(false);
  let resumeError: string | null = $state(null);

  let canResume = $derived.by(() => {
    const session = $activeSession;
    if (!session?.phase) return false;
    if (session.state === 'completed' || session.state === 'closed' || session.state === 'failed' || session.state === 'cancelled') return false;
    return resumablePhases.has(session.phase);
  });

  async function resumeSession(): Promise<void> {
    const id = $activeSessionId;
    if (!id || resumeBusy) return;
    resumeBusy = true;
    resumeError = null;
    try {
      await api.post(`/api/sessions/${id}/action`, { kind: 'resume' });
      await selectSession(id);
      await loadSessions({ showLoading: false });
    } catch (err) {
      resumeError = err instanceof Error ? err.message : String(err);
    } finally {
      resumeBusy = false;
    }
  }
</script>

<header class="chat-head" role="presentation" data-tauri-drag-region onmousedown={onWindowDragMouseDown}>
  {#if $activeSession}
    <div class="title-wrap" data-tauri-drag-region>
      <h2>{$activeSession.title}</h2>
      <span class="meta">#{shortId($activeSession.id)} · {$activeSession.phase}</span>
    </div>
    <div class="head-right" data-tauri-drag-region>
      {#if resumeError !== null}
        <span class="resume-error">{resumeError}</span>
      {/if}
      {#if canResume}
        <button
          type="button"
          class="resume-btn"
          disabled={resumeBusy}
          onclick={resumeSession}
          aria-label={t('Resume session')}
          title={t('Resume session')}
        >
          <Icon name="rotate-cw" size={13} />
          <span>{resumeBusy ? t('Resuming') : t('Resume')}</span>
        </button>
      {/if}
      <StatusBadge label={$activeSession.state ?? 'created'} tone={stateTone($activeSession.state)} />
    </div>
  {:else}
    <div class="title-wrap" data-tauri-drag-region>
      <h2>No session selected</h2>
      <span class="meta">Choose a session on the left or create one with +</span>
    </div>
  {/if}
</header>

<style>
  .chat-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    /* Leave room on the right for the absolutely-positioned PanelToggle. */
    padding: 0 52px 0 var(--sp-4);
    border-bottom: 1px solid var(--bd-muted);
    background: color-mix(in srgb, var(--bg-base) 92%, var(--bg-sidebar));
    flex-shrink: 0;
    min-height: 44px;
    height: 44px;
    -webkit-app-region: drag;
    user-select: none;
    -webkit-user-select: none;
  }
  .title-wrap {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    pointer-events: none;
    -webkit-app-region: drag;
  }
  h2 {
    margin: 0;
    font-size: var(--fs-md);
    line-height: 1.2;
    font-weight: var(--fw-semi);
    color: var(--fg-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .head-right {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    -webkit-app-region: no-drag;
  }
  .resume-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 var(--sp-2);
    border-radius: var(--rad-sm);
    border: 1px solid color-mix(in srgb, var(--st-info) 35%, var(--bd-default));
    background: color-mix(in srgb, var(--st-info) 10%, transparent);
    color: var(--st-info);
    font-size: var(--fs-xs);
    font-weight: var(--fw-med);
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast), opacity var(--t-fast);
  }
  .resume-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--st-info) 18%, transparent);
    border-color: color-mix(in srgb, var(--st-info) 50%, var(--bd-default));
  }
  .resume-btn:disabled {
    opacity: 0.55;
    cursor: wait;
  }
  .resume-error {
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--st-err);
    font-size: var(--fs-xs);
  }
</style>
