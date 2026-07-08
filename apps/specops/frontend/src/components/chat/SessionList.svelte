<script lang="ts">
  import Icon from '../shared/Icon.svelte';
  import {
    sessions,
    sessionsLoading,
    sessionsError,
    activeSessionId,
    loadSessions,
    selectSession,
  } from '../../lib/stores/sessions.ts';
  import { t } from '../../lib/i18n.ts';

  const fmtTime = (iso?: string): string => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };
  const shortId = (id: string): string => id.slice(0, 8);
</script>

<div class="session-list">
  <header class="list-head">
    <div>
      <span class="eyebrow">{t('Sessions')}</span>
      <strong>{$sessions.length}</strong>
    </div>
    <button class="refresh" onclick={() => loadSessions()} aria-label="refresh">
      <Icon name="refresh" size={14} />
    </button>
  </header>

  {#if $sessionsLoading}
    <p class="empty">Loading…</p>
  {:else if $sessionsError}
    <p class="err">{$sessionsError}</p>
  {:else if $sessions.length === 0}
    <p class="empty">No sessions yet.</p>
  {:else}
    <ul class="sessions">
      {#each $sessions as s (s.id)}
        <li>
          <button
            type="button"
            class="session"
            class:active={$activeSessionId === s.id}
            onclick={() => selectSession(s.id)}
          >
            <span class="status-dot" data-state={s.state}></span>
            <span class="body">
              <span class="topline">
                <span class="title">{s.title ?? shortId(s.id)}</span>
                <span class="state" data-state={s.state}>{s.state ?? 'created'}</span>
              </span>
              <span class="meta">
                <span class="phase">{s.phase ?? '—'}</span>
                <span class="dot">·</span>
                <span class="sid">{shortId(s.id)}</span>
                {#if s.updated_at}
                  <span class="dot">·</span>
                  <time>{fmtTime(s.updated_at)}</time>
                {/if}
              </span>
              {#if s.document_path}
                <span class="doc">{s.document_path}</span>
              {/if}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .session-list {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--sp-2) var(--sp-3);
    border-bottom: 1px solid var(--bd-muted);
    background: color-mix(in srgb, var(--bg-sidebar) 88%, var(--bg-base));
    flex-shrink: 0;
  }
  .list-head > div {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
  }
  .eyebrow {
    font-size: var(--fs-xs);
    font-weight: var(--fw-semi);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-tertiary);
  }
  .list-head strong {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--st-info);
  }
  .refresh {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--rad-sm);
    border: 1px solid transparent;
    background: transparent;
    color: var(--fg-tertiary);
  }
  .refresh:hover {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
  .empty,
  .err {
    padding: var(--sp-3);
    color: var(--fg-tertiary);
    font-size: var(--fs-sm);
    margin: 0;
  }
  .err {
    color: var(--st-err);
  }
  .sessions {
    list-style: none;
    margin: 0;
    padding: var(--sp-2);
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .session {
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr);
    align-items: start;
    gap: var(--sp-2);
    width: 100%;
    padding: var(--sp-2);
    border-radius: var(--rad-lg);
    border: 1px solid transparent;
    background: transparent;
    text-align: left;
    transition: background var(--t-fast), border-color var(--t-fast), box-shadow var(--t-fast);
  }
  .session:hover {
    background: var(--bg-tab-hover);
    border-color: var(--bd-muted);
  }
  .session.active {
    background: var(--bg-selected);
    border-color: color-mix(in srgb, var(--acc) 42%, var(--bd-default));
    box-shadow: inset 2px 0 0 0 var(--acc), 0 8px 24px rgba(0, 0, 0, 0.1);
  }
  .status-dot {
    width: 8px;
    height: 8px;
    margin-top: 5px;
    border-radius: 999px;
    background: var(--fg-tertiary);
  }
  .status-dot[data-state='active'] {
    background: var(--st-idle);
    animation: pulse 1.4s ease-in-out infinite;
  }
  .status-dot[data-state='awaiting_user'] {
    background: var(--st-warn);
    animation: pulse 1.1s ease-in-out infinite;
  }
  .status-dot[data-state='failed'],
  .status-dot[data-state='cancelled'] {
    background: var(--st-err);
  }
  .status-dot[data-state='completed'] {
    background: var(--st-info);
  }
  .status-dot[data-state='closed'] {
    opacity: 0.5;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .topline {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }
  .title {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-sm);
    color: var(--fg-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .state {
    padding: 1px 6px;
    border-radius: 999px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--fg-tertiary);
    background: var(--bg-chip);
    flex-shrink: 0;
  }
  .state[data-state='active'] {
    color: var(--st-idle);
    background: color-mix(in srgb, var(--st-idle) 13%, transparent);
  }
  .state[data-state='awaiting_user'] {
    color: var(--st-warn);
    background: color-mix(in srgb, var(--st-warn) 13%, transparent);
  }
  .state[data-state='completed'] {
    color: var(--st-info);
    background: color-mix(in srgb, var(--st-info) 13%, transparent);
  }
  .state[data-state='failed'],
  .state[data-state='cancelled'] {
    color: var(--st-err);
    background: color-mix(in srgb, var(--st-err) 13%, transparent);
  }
  .meta,
  .doc {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .phase {
    color: var(--st-info);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  time {
    white-space: nowrap;
    flex-shrink: 0;
  }
  .sid {
    color: var(--fg-secondary);
    flex-shrink: 0;
  }
  .doc {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    opacity: 0.5;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
</style>
