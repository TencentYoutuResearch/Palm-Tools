<script lang="ts">
  import { onMount } from 'svelte';
  import type { HarnessControlState, ScheduledTask, SessionAgent, SpecOpsSession, WorkflowStep } from '../../lib/types.ts';
  import { api } from '../../lib/api.ts';
  import AvatarSprite from '../shared/AvatarSprite.svelte';
  import StatusBadge from '../shared/StatusBadge.svelte';

  interface Props { session: SpecOpsSession }
  let { session }: Props = $props();

  type Role = 'clarify' | 'implement' | 'review';
  type NodeState = 'pending' | 'active' | 'awaiting_user' | 'done' | 'failed';

  const roleOrder: Role[] = ['clarify', 'implement', 'review'];
  type ProfileRole = 'analysis' | 'implementation' | 'review';
  type AgentSettings = { resolved: Record<ProfileRole, { backend: string; avatar?: string }> };

  const roles: Record<Role, { label: string; purpose: string[]; phases: string[]; profile: ProfileRole }> = {
    clarify: {
      label: 'Clarify / Plan', purpose: ['clarify', 'plan', 'intake'], profile: 'analysis',
      phases: ['clarify', 'analyze_request', 'plan_discussion', 'solution_options', 'plan_approved'],
    },
    implement: {
      label: 'Implementation', purpose: ['implement', 'repair'], profile: 'implementation',
      phases: ['run_in_worktree', 'verify'],
    },
    review: { label: 'Review', purpose: ['review'], phases: ['review'], profile: 'review' },
  };
  const phaseLabels: Record<string, string> = {
    clarify: 'Clarify', analyze_request: 'Intake', plan_discussion: 'Plan', solution_options: 'Options',
    plan_approved: 'Approved', run_in_worktree: 'Build', verify: 'Verify', review: 'Review',
    apply_patch: 'Apply', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled',
  };
  const handoffLabels = ['task contract', 'evidence handoff'];

  let expandedRole = $state<Role | null>(null);
  let observedPhase = $state<string | undefined>(undefined);
  let agentSettings = $state<AgentSettings | null>(null);
  let harnessState = $state<HarnessControlState | null>(null);
  let activeRole = $derived(roleForPhase(session.phase));
  let currentPhase = $derived(phaseLabels[session.workflow?.current_phase ?? session.phase ?? ''] ?? session.phase ?? 'Waiting');
  let repairCount = $derived((session.agents ?? []).filter((agent) => agent.purpose === 'repair').length);
  let liveCount = $derived((session.agents ?? []).filter((agent) => agent.ended_at == null).length);
  let repairActive = $derived(activeRole === 'implement' && latestAgent('implement')?.purpose === 'repair');
  let returnActive = $derived(activeRole === 'review' || repairCount > 0);
  let returnMoving = $derived(activeRole === 'review' || repairActive);
  let completedTasks = $derived(harnessState?.tasks.filter((task) => task.state === 'completed').length ?? 0);

  onMount(() => {
    void api.get<AgentSettings>('/api/settings/agents').then((settings) => {
      agentSettings = settings;
    }).catch(() => undefined);
  });

  onMount(() => {
    let disposed = false;
    const refresh = async (): Promise<void> => {
      const runId = session.run_id;
      if (!runId) {
        harnessState = null;
        return;
      }
      try {
        const response = await api.get<{ state: HarnessControlState | null }>(`/api/runs/${runId}/harness`);
        if (!disposed && response.state?.run_id === session.run_id) harnessState = response.state;
      } catch {
        // Keep the last durable snapshot during a transient sidecar refresh.
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  });

  $effect(() => {
    if (session.phase === observedPhase) return;
    observedPhase = session.phase;
    expandedRole = roleForPhase(session.phase);
  });

  function roleForPhase(phase?: string): Role | null {
    if (phase === undefined) return null;
    return roleOrder.find((role) => roles[role].phases.includes(phase)) ?? null;
  }

  function workflowStep(phase: string): WorkflowStep | undefined {
    return session.workflow?.steps?.find((step) => step.id === phase);
  }

  function stepState(phase: string): NodeState {
    const state = workflowStep(phase)?.state;
    if (state === 'active' || state === 'awaiting_user' || state === 'done' || state === 'failed') return state;
    return 'pending';
  }

  function roleState(role: Role): NodeState {
    const states = roles[role].phases.map(stepState);
    if (states.includes('failed')) return 'failed';
    if (states.includes('awaiting_user')) return 'awaiting_user';
    if (states.includes('active')) return 'active';
    if (states.every((state) => state === 'done')) return 'done';
    return 'pending';
  }

  function tone(state: NodeState): 'draft' | 'busy' | 'proposed' | 'completed' | 'error' {
    if (state === 'active') return 'busy';
    if (state === 'awaiting_user') return 'proposed';
    if (state === 'done') return 'completed';
    if (state === 'failed') return 'error';
    return 'draft';
  }

  function avatarStatus(state: NodeState): 'running' | 'awaiting' | 'idle' | 'error' {
    if (state === 'active') return 'running';
    if (state === 'awaiting_user') return 'awaiting';
    if (state === 'failed') return 'error';
    return 'idle';
  }

  function agentsFor(role: Role): SessionAgent[] {
    return (session.agents ?? []).filter((agent) => roles[role].purpose.includes(agent.purpose));
  }

  function latestAgent(role: Role): SessionAgent | undefined {
    return agentsFor(role).at(-1);
  }

  function handoffMoving(from: Role, to: Role): boolean {
    const fromState = roleState(from);
    const toState = roleState(to);
    return fromState === 'done' && (toState === 'active' || toState === 'awaiting_user');
  }

  function toggle(role: Role): void {
    expandedRole = expandedRole === role ? null : role;
  }

  function deliveryState(phase: 'apply_patch' | 'completed'): NodeState {
    if (session.state === 'failed') return 'failed';
    return stepState(phase);
  }

  function taskTone(task: ScheduledTask): 'done' | 'running' | 'waiting' | 'failed' {
    if (task.state === 'completed') return 'done';
    if (task.state === 'running' || task.state === 'verifying' || task.state === 'reviewing') return 'running';
    if (task.state === 'failed' || task.state === 'cancelled') return 'failed';
    return 'waiting';
  }

  function taskMark(task: ScheduledTask): string {
    const state = taskTone(task);
    if (state === 'done') return '✓';
    if (state === 'running') return '●';
    if (state === 'failed') return '×';
    return '○';
  }
</script>

<section class="coordination" aria-label="Workflow and agent coordination">
  <header class="map-head">
    <div>
      <span class="eyebrow">Execution map</span>
      <strong>{session.workflow_applicable === false ? 'Document review' : currentPhase}</strong>
    </div>
    <StatusBadge label={session.state ?? 'created'} tone={session.state === 'failed' ? 'error' : session.state === 'completed' ? 'completed' : 'active'} />
  </header>

  {#if session.workflow_applicable === false}
    <div class="document-review">
      <span class="role-mark">D</span>
      <div><strong>Review only</strong><span>This document has no implementation workflow.</span></div>
    </div>
  {:else}
    <div class="run-facts" aria-label="Execution summary">
      <span><b>{liveCount}</b> live</span>
      <span><b>{repairCount}</b> repairs</span>
      <span class:has-failures={(session.workflow?.failure_count ?? 0) > 0}><b>{session.workflow?.failure_count ?? 0}</b> failures</span>
    </div>

    <div class="request-node" data-state={roleState('clarify') === 'pending' ? 'active' : 'done'}>
      <span class="request-icon" aria-hidden="true">→</span>
      <span><small>Request</small><strong>{session.title ?? 'Feature request'}</strong></span>
    </div>
    <div class="request-handoff" data-moving={roleState('clarify') === 'active' || roleState('clarify') === 'awaiting_user'} aria-hidden="true"><span></span></div>

    <div class="flow-stage">
      <div class="return-rail" class:active={returnActive} data-moving={returnMoving} aria-label="Review verdict returns to Clarify / Plan">
        <span class="return-track" aria-hidden="true"></span>
        <span class="return-label">review verdict</span>
      </div>
      <ol class="relay">
      {#each roleOrder as role, index (role)}
        {@const state = roleState(role)}
        {@const agent = latestAgent(role)}
        {@const showDetails = expandedRole === role}
        <li class="station" data-state={state}>
          <button
            type="button"
            class="station-card"
            aria-expanded={showDetails}
            aria-label={`${roles[role].label}: ${state}`}
            onclick={() => toggle(role)}
          >
            <span class="role-avatar" data-state={state}>
              <AvatarSprite
                avatarId={agentSettings?.resolved[roles[role].profile]?.avatar ?? null}
                backendKey={agent?.backend_key || agentSettings?.resolved[roles[role].profile]?.backend || 'codebuddy'}
                status={avatarStatus(state)}
                size={28}
                label={`${roles[role].label} avatar`}
              />
              <span class="avatar-state" aria-hidden="true"></span>
            </span>
            <span class="station-main">
              <span class="station-title"><strong>{roles[role].label}</strong><StatusBadge label={state.replace('_', ' ')} tone={tone(state)} /></span>
              <span class="phase-rail">
                {#each roles[role].phases as phase (phase)}
                  <span class="phase-chip" data-state={stepState(phase)}>{phaseLabels[phase]}</span>
                {/each}
              </span>
              {#if showDetails}
                <span class="agent-detail">
                  <span>{agent?.backend_key ?? 'Agent not started'}{agent?.model ? ` / ${agent.model}` : ''}</span>
                  <span>{agentsFor(role).length} session{agentsFor(role).length === 1 ? '' : 's'} · {agent?.status ?? 'waiting'}</span>
                </span>
                {#if role === 'implement' && harnessState?.tasks.length}
                  <span class="task-ledger" aria-label={`${completedTasks} of ${harnessState.tasks.length} tasks completed`}>
                    <span class="task-summary">
                      <strong>{completedTasks} / {harnessState.tasks.length} tasks</strong>
                      <span>{harnessState.tasks.find((task) => taskTone(task) === 'running')?.state ?? harnessState.run_state}</span>
                    </span>
                    <span class="task-progress" aria-hidden="true"><i style={`width: ${(completedTasks / harnessState.tasks.length) * 100}%`}></i></span>
                    <span class="task-list">
                      {#each harnessState.tasks as task (task.id)}
                        <span class="task-row" data-state={taskTone(task)} title={task.title}>
                          <b aria-hidden="true">{taskMark(task)}</b>
                          <span><small>{task.id}</small>{task.title}</span>
                          {#if task.attempt > 0}<em>{task.attempt}×</em>{/if}
                        </span>
                      {/each}
                    </span>
                  </span>
                {/if}
              {/if}
            </span>
            <span class="disclosure" aria-hidden="true">{showDetails ? '−' : '+'}</span>
          </button>
        </li>

        {#if index < roleOrder.length - 1}
          <li class="handoff" data-state={roleState(roleOrder[index + 1]!)} data-moving={handoffMoving(role, roleOrder[index + 1]!)}>
            <span class="handoff-line" aria-hidden="true"></span>
            <span>{handoffLabels[index]}</span>
          </li>
        {/if}
      {/each}
      </ol>
    </div>

    <div class="verdict-loop" class:active={returnActive}>
      <span><b>Review → Clarify</b></span>
      <span>{repairCount > 0 ? 'Changes requested · repair route active' : 'Approve completion or return with changes'}</span>
    </div>

    <div class="delivery" aria-label="Delivery gates">
      {#each ['apply_patch', 'completed'] as phase (phase)}
        {@const state = deliveryState(phase as 'apply_patch' | 'completed')}
        <div class="delivery-gate" data-state={state}>
          <span>{phase === 'apply_patch' ? 'A' : '✓'}</span>
          <div><strong>{phaseLabels[phase]}</strong><small>{state.replace('_', ' ')}</small></div>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .coordination { padding: var(--sp-3); }
  .map-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); margin-bottom: var(--sp-3); }
  .map-head > div { display: grid; gap: 2px; min-width: 0; }
  .map-head strong { overflow: hidden; color: var(--fg-primary); font-size: var(--fs-lg); text-overflow: ellipsis; white-space: nowrap; }
  .eyebrow { color: var(--fg-tertiary); font-family: var(--font-mono); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; }
  .run-facts { display: grid; grid-template-columns: repeat(3, 1fr); margin-bottom: var(--sp-3); border: 1px solid var(--bd-muted); border-radius: var(--rad-md); background: var(--bg-elevated); }
  .run-facts span { display: grid; gap: 1px; padding: 7px 8px; border-right: 1px solid var(--bd-muted); color: var(--fg-tertiary); font-size: 9px; text-transform: uppercase; }
  .run-facts span:last-child { border-right: 0; }
  .run-facts b { color: var(--fg-primary); font-family: var(--font-mono); font-size: var(--fs-sm); }
  .run-facts .has-failures b { color: var(--st-err); }
  .request-node { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: 9px; padding: 9px 10px; border: 1px solid var(--bd-default); border-radius: var(--rad-md); background: color-mix(in srgb, var(--bg-elevated) 88%, var(--st-info)); }
  .request-node > span:last-child { min-width: 0; display: grid; gap: 2px; }
  .request-node small { color: var(--st-info); font-family: var(--font-mono); font-size: 8px; letter-spacing: .08em; text-transform: uppercase; }
  .request-node strong { overflow: hidden; color: var(--fg-primary); font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; }
  .request-icon { display: grid; width: 26px; height: 26px; place-items: center; border-radius: 5px; background: color-mix(in srgb, var(--st-info) 14%, var(--bg-base)); color: var(--st-info); font-family: var(--font-mono); }
  .request-handoff { height: 30px; padding-left: 23px; }
  .request-handoff span { display: block; width: 2px; height: 100%; background: var(--bd-default); }
  .request-handoff[data-moving='true'] span { background: repeating-linear-gradient(to bottom, var(--st-info) 0 5px, transparent 5px 10px); background-size: 100% 20px; }
  .flow-stage { position: relative; padding-left: 18px; }
  .relay { position: relative; list-style: none; margin: 0; padding: 0; }
  .station { position: relative; }
  .station-card { width: 100%; display: grid; grid-template-columns: 28px minmax(0, 1fr) 14px; gap: 9px; padding: 10px; border: 1px solid var(--bd-default); border-radius: var(--rad-md); background: var(--bg-elevated); color: inherit; text-align: left; }
  .station-card:hover { border-color: var(--bd-focus); background: color-mix(in srgb, var(--bg-elevated) 88%, var(--acc)); }
  .station-card:focus-visible { outline: 2px solid var(--bd-focus); outline-offset: 2px; }
  .station[data-state='active'] .station-card, .station[data-state='awaiting_user'] .station-card { border-color: color-mix(in srgb, var(--st-busy) 48%, var(--bd-default)); box-shadow: inset 3px 0 0 var(--st-busy); }
  .station[data-state='awaiting_user'] .station-card { box-shadow: inset 3px 0 0 var(--st-warn); }
  .station[data-state='done'] .station-card { border-color: color-mix(in srgb, var(--st-ok) 32%, var(--bd-default)); }
  .station[data-state='failed'] .station-card { border-color: var(--st-err); box-shadow: inset 3px 0 0 var(--st-err); }
  .role-mark { display: grid; width: 26px; height: 26px; place-items: center; border: 1px solid var(--bd-default); border-radius: 5px; background: var(--bg-base); color: var(--fg-secondary); font-family: var(--font-mono); font-size: 10px; }
  .role-avatar { position: relative; display: grid; width: 30px; height: 30px; place-items: center; border: 1px solid var(--bd-default); border-radius: 7px; background: var(--bg-base); }
  .avatar-state { position: absolute; right: -2px; bottom: -2px; width: 7px; height: 7px; border: 2px solid var(--bg-elevated); border-radius: 50%; background: var(--fg-tertiary); }
  .role-avatar[data-state='active'] .avatar-state { background: var(--st-busy); }
  .role-avatar[data-state='awaiting_user'] .avatar-state { background: var(--st-warn); }
  .role-avatar[data-state='done'] .avatar-state { background: var(--st-ok); }
  .role-avatar[data-state='failed'] .avatar-state { background: var(--st-err); }
  .station-main { display: grid; gap: 7px; min-width: 0; }
  .station-title { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .station-title > strong { overflow: hidden; color: var(--fg-primary); font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }
  .phase-rail { display: flex; flex-wrap: wrap; gap: 4px; }
  .phase-chip { padding: 2px 5px; border: 1px solid var(--bd-muted); border-radius: 3px; color: var(--fg-tertiary); font-family: var(--font-mono); font-size: 8px; }
  .phase-chip[data-state='active'] { border-color: var(--st-busy); color: var(--st-busy); background: color-mix(in srgb, var(--st-busy) 10%, transparent); }
  .phase-chip[data-state='awaiting_user'] { border-color: var(--st-warn); color: var(--st-warn); background: color-mix(in srgb, var(--st-warn) 10%, transparent); }
  .phase-chip[data-state='done'] { border-color: color-mix(in srgb, var(--st-ok) 42%, var(--bd-muted)); color: var(--st-ok); }
  .phase-chip[data-state='failed'] { border-color: var(--st-err); color: var(--st-err); }
  .agent-detail { display: grid; gap: 2px; padding-top: 7px; border-top: 1px solid var(--bd-muted); color: var(--fg-tertiary); font-family: var(--font-mono); font-size: 9px; }
  .agent-detail span:first-child { overflow: hidden; color: var(--fg-secondary); text-overflow: ellipsis; white-space: nowrap; }
  .task-ledger { display: grid; gap: 7px; padding-top: 8px; border-top: 1px solid var(--bd-muted); }
  .task-summary { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .task-summary strong { color: var(--fg-primary); font-size: 10px; }
  .task-summary > span { color: var(--fg-tertiary); font-family: var(--font-mono); font-size: 8px; text-transform: uppercase; }
  .task-progress { overflow: hidden; height: 2px; border-radius: 1px; background: var(--bd-muted); }
  .task-progress i { display: block; height: 100%; background: var(--st-ok); transition: width 180ms ease-out; }
  .task-list { display: grid; max-height: 246px; overflow-y: auto; }
  .task-row { display: grid; grid-template-columns: 13px minmax(0, 1fr) auto; align-items: start; gap: 6px; padding: 6px 2px; border-top: 1px solid color-mix(in srgb, var(--bd-muted) 72%, transparent); color: var(--fg-secondary); font-size: 9px; }
  .task-row:first-child { border-top: 0; }
  .task-row > b { color: var(--fg-tertiary); font-family: var(--font-mono); font-weight: 500; }
  .task-row > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-row small { margin-right: 5px; color: var(--fg-tertiary); font-family: var(--font-mono); font-size: 8px; text-transform: uppercase; }
  .task-row em { color: var(--fg-tertiary); font-family: var(--font-mono); font-size: 8px; font-style: normal; }
  .task-row[data-state='done'] { color: var(--fg-tertiary); }
  .task-row[data-state='done'] > b { color: var(--st-ok); }
  .task-row[data-state='running'] { margin: 1px 0; padding-right: 5px; padding-left: 5px; border-radius: 4px; background: color-mix(in srgb, var(--st-busy) 9%, transparent); color: var(--fg-primary); }
  .task-row[data-state='running'] > b { color: var(--st-busy); }
  .task-row[data-state='failed'] > b { color: var(--st-err); }
  .disclosure { align-self: start; color: var(--fg-tertiary); font-family: var(--font-mono); font-size: var(--fs-sm); }
  .handoff { height: 38px; display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: 9px; padding-left: 10px; color: var(--fg-tertiary); font-family: var(--font-mono); font-size: 8px; letter-spacing: .04em; text-transform: uppercase; }
  .handoff-line { justify-self: center; width: 1px; height: 100%; background: var(--bd-default); }
  .handoff[data-state='active'] .handoff-line, .handoff[data-state='awaiting_user'] .handoff-line { background: var(--st-busy); }
  .handoff[data-state='done'] .handoff-line { background: var(--st-ok); }
  .handoff[data-moving='true'] .handoff-line { width: 2px; background: repeating-linear-gradient(to bottom, var(--st-busy) 0 5px, transparent 5px 10px); background-size: 100% 20px; }
  .return-rail { position: absolute; z-index: 1; inset: 15px auto 15px 0; width: 15px; color: var(--bd-default); pointer-events: none; }
  .return-track { position: absolute; inset: 0 0 0 7px; border-top: 1px solid currentColor; border-bottom: 1px solid currentColor; border-left: 2px solid currentColor; border-radius: 7px 0 0 7px; }
  .return-track::before { position: absolute; top: -4px; right: -1px; width: 0; height: 0; border-top: 4px solid transparent; border-bottom: 4px solid transparent; border-left: 6px solid currentColor; content: ''; }
  .return-rail.active { color: var(--st-warn); }
  .return-rail[data-moving='true'] .return-track { border-left-color: transparent; background: repeating-linear-gradient(to top, currentColor 0 6px, transparent 6px 12px) left / 2px 24px repeat-y; }
  .return-label { position: absolute; top: 50%; left: -3px; padding: 3px 1px; background: var(--bg-base); color: currentColor; font-family: var(--font-mono); font-size: 7px; letter-spacing: .05em; text-transform: uppercase; transform: translate(-50%, -50%) rotate(-90deg); white-space: nowrap; }
  .verdict-loop { display: grid; gap: 3px; margin: 9px 0 12px 18px; padding: 8px 10px; border-left: 2px solid var(--bd-default); color: var(--fg-tertiary); font-size: 9px; }
  .verdict-loop.active { color: var(--st-warn); }
  .verdict-loop b { color: var(--fg-secondary); }
  .delivery { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2); padding-top: var(--sp-3); border-top: 1px solid var(--bd-muted); }
  .delivery-gate { display: grid; grid-template-columns: 24px 1fr; align-items: center; gap: 7px; padding: 8px; border: 1px solid var(--bd-muted); border-radius: var(--rad-md); background: var(--bg-elevated); }
  .delivery-gate > span { display: grid; width: 22px; height: 22px; place-items: center; border-radius: 4px; background: var(--bg-chip); color: var(--fg-tertiary); font-family: var(--font-mono); font-size: 10px; }
  .delivery-gate div { display: grid; gap: 1px; }
  .delivery-gate strong { color: var(--fg-secondary); font-size: var(--fs-xs); }
  .delivery-gate small { color: var(--fg-tertiary); font-family: var(--font-mono); font-size: 8px; }
  .delivery-gate[data-state='active'], .delivery-gate[data-state='awaiting_user'] { border-color: var(--st-warn); }
  .delivery-gate[data-state='done'] { border-color: color-mix(in srgb, var(--st-ok) 42%, var(--bd-muted)); }
  .delivery-gate[data-state='done'] > span { color: var(--st-ok); }
  .delivery-gate[data-state='failed'] { border-color: var(--st-err); }
  .document-review { display: grid; grid-template-columns: 28px 1fr; gap: 10px; padding: 12px; border: 1px solid var(--bd-default); border-radius: var(--rad-md); background: var(--bg-elevated); }
  .document-review > div { display: grid; gap: 3px; }
  .document-review strong { color: var(--fg-primary); font-size: var(--fs-sm); }
  .document-review span:last-child { color: var(--fg-tertiary); font-size: var(--fs-xs); }
  @media (prefers-reduced-motion: no-preference) {
    .station-card { transition: border-color 120ms ease, background-color 120ms ease; }
    .request-handoff[data-moving='true'] span, .handoff[data-moving='true'] .handoff-line { animation: flow-down .7s linear infinite; }
    .return-rail[data-moving='true'] .return-track { animation: flow-up .7s linear infinite; }
  }
  @keyframes flow-down { to { background-position-y: 20px; } }
  @keyframes flow-up { to { background-position-y: -24px; } }
</style>
