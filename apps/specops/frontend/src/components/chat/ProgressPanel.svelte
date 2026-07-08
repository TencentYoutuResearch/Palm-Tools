<script lang="ts">
  import StatusBadge from '../shared/StatusBadge.svelte';
  import { activeSession } from '../../lib/stores/sessions.ts';
  import { t } from '../../lib/i18n.ts';

  const STEP_LABELS: Record<string, string> = {
    analyze_request: 'Intake',
    clarify: 'Clarify',
    plan_discussion: 'Plan',
    solution_options: 'Options',
    plan_approved: 'Approved',
    run_in_worktree: 'Implement',
    verify: 'Verify',
    review: 'Review',
    apply_patch: 'Apply',
    completed: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
</script>

<div class="progress-panel">
  <div class="col-title">{t('Progress')}</div>

  {#if $activeSession}
    {@const wf = $activeSession.workflow}
    <section class="workflow">
      <header class="workflow-head">
        <span class="current-phase">{STEP_LABELS[wf?.current_phase ?? ''] ?? wf?.current_phase ?? ''}</span>
        {#if wf?.failure_count}
          <span class="failures">{wf.failure_count} failures</span>
        {/if}
      </header>
      <ol class="steps">
        {#each wf?.steps ?? [] as step (step.id)}
          <li class="step step-{step.state}">
            <span class="step-dot" data-state={step.state}></span>
            <span class="step-label">{STEP_LABELS[step.id] ?? step.id}</span>
          </li>
        {/each}
      </ol>
    </section>

    <section class="agents">
      <header class="agents-head">Agents</header>
      <ul class="agent-list">
        {#each $activeSession.agents ?? [] as agent (agent.kode_session_id)}
          <li class="agent">
            <span class="status-dot" data-status={agent.status}></span>
            <div class="agent-body">
              <span class="agent-purpose">{agent.purpose}</span>
              <span class="agent-meta">
                <span class="backend">{agent.backend_key}</span>
                {#if agent.model}
                  <span class="dot">·</span>
                  <span class="model">{agent.model}</span>
                {/if}
              </span>
            </div>
            <StatusBadge label={agent.status} tone={agent.status === 'exited' ? 'archived' : 'active'} />
          </li>
        {/each}
      </ul>
    </section>
  {:else}
    <p class="empty">{t('No active session.')}</p>
  {/if}
</div>

<style>
  .progress-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
  }
  .workflow {
    padding: var(--sp-2) var(--sp-3);
    border-bottom: 1px solid var(--bd-muted);
  }
  .workflow-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--sp-2);
  }
  .current-phase {
    font-size: var(--fs-md);
    font-weight: var(--fw-semi);
    color: var(--fg-primary);
  }
  .failures {
    font-size: var(--fs-xs);
    color: var(--st-err);
    font-family: var(--font-mono);
  }
  .steps {
    position: relative;
    list-style: none;
    margin: 0;
    padding: var(--sp-1) 0 var(--sp-1) var(--sp-4);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .steps::before {
    content: '';
    position: absolute;
    left: 7px;
    top: 10px;
    bottom: 10px;
    width: 1px;
    background: linear-gradient(to bottom, var(--bd-default), color-mix(in srgb, var(--bd-default) 35%, transparent));
  }
  .step {
    position: relative;
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr);
    align-items: center;
    gap: var(--sp-2);
    min-height: 28px;
    font-size: var(--fs-sm);
    color: var(--fg-secondary);
    animation: step-in var(--t-base) cubic-bezier(0.2, 0, 0, 1) both;
  }
  @keyframes step-in {
    from {
      opacity: 0;
      transform: translateX(-4px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }
  .step-dot {
    position: relative;
    z-index: 1;
    width: 12px;
    height: 12px;
    border-radius: 999px;
    border: 2px solid var(--bd-default);
    background: var(--bg-elevated);
    box-shadow: 0 0 0 3px var(--bg-elevated);
    flex-shrink: 0;
  }
  .step-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .step-pending .step-dot {
    background: transparent;
  }
  .step-active .step-dot {
    background: var(--st-busy);
    border-color: var(--st-busy);
    animation: pulse 1.4s ease-in-out infinite;
  }
  .step-awaiting_user .step-dot {
    background: var(--st-warn);
    border-color: var(--st-warn);
    animation: pulse 1.1s ease-in-out infinite;
  }
  .step-done .step-dot {
    background: var(--st-idle);
    border-color: var(--st-idle);
  }
  .step-done {
    color: var(--fg-primary);
  }
  .step-failed .step-dot {
    background: var(--st-err);
    border-color: var(--st-err);
  }
  .step-failed {
    color: var(--st-err);
  }
  .step-skipped .step-dot {
    background: transparent;
    border-style: dashed;
  }
  .step-skipped {
    color: var(--fg-tertiary);
  }
  .agents {
    padding: var(--sp-2) var(--sp-3);
  }
  .agents-head {
    font-size: var(--fs-xs);
    font-weight: var(--fw-semi);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-tertiary);
    margin-bottom: var(--sp-2);
  }
  .agent-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .agent {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2);
    border-radius: var(--rad-md);
    background: var(--bg-elevated);
    border: 1px solid var(--bd-muted);
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--fg-tertiary);
    flex-shrink: 0;
  }
  .status-dot[data-status='active'],
  .status-dot[data-status='running'] {
    background: var(--st-idle);
    animation: pulse 1.4s ease-in-out infinite;
  }
  .status-dot[data-status='awaiting_user'] {
    background: var(--st-warn);
    animation: pulse 1.1s ease-in-out infinite;
  }
  .status-dot[data-status='exited'],
  .status-dot[data-status='failed'] {
    opacity: 0.5;
  }
  .agent-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .agent-purpose {
    font-size: var(--fs-sm);
    color: var(--fg-primary);
    text-transform: capitalize;
  }
  .agent-meta {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
  }
  .backend {
    color: var(--st-info);
  }
  .dot {
    opacity: 0.5;
  }
  .model {
    color: var(--fg-secondary);
  }
  .empty {
    padding: var(--sp-3);
    color: var(--fg-tertiary);
    font-size: var(--fs-sm);
    margin: 0;
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
