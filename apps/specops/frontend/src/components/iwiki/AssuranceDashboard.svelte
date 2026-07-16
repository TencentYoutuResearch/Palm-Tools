<script lang="ts">
  import { refreshState, workspaceState } from '../../lib/stores/documents.ts';
  import { api } from '../../lib/api.ts';
  let assurance = $derived($workspaceState?.assurance);
  let harnessHealth = $derived($workspaceState?.harness_health);
  let driftReport = $derived($workspaceState?.drift_report);
  let approving = $state<string | null>(null);
  async function approve(runId: string, gateId: string): Promise<void> {
    approving = `${runId}:${gateId}`;
    try { await api.post(`/api/runs/${runId}/gates/${gateId}/approve`, { actor: 'console-user', reason: 'Approved in Assurance console' }); await refreshState(); }
    finally { approving = null; }
  }
</script>

<div class="dashboard">
  <header><p>Harness control plane</p><h1>Assurance</h1></header>
  {#if assurance === undefined}
    <p class="empty">Run a workspace scan to build assurance data.</p>
  {:else}
    <section class="metrics">
      <div><span>Mapped specs</span><strong>{assurance.health.mapped_spec_rate}%</strong></div>
      <div><span>Evidence coverage</span><strong>{assurance.health.evidence_coverage_rate}%</strong></div>
      <div><span>Stale evidence</span><strong>{assurance.health.stale_evidence}</strong></div>
      <div><span>Critical risks</span><strong>{assurance.health.critical_risks}</strong></div>
    </section>
    <section class="environment"><h2>Harness health</h2><code>{Math.round((harnessHealth?.first_pass_task_rate ?? 1) * 100)}% first pass · {harnessHealth?.average_task_attempts ?? 0} avg attempts · {Math.round((harnessHealth?.failed_gate_rate ?? 0) * 100)}% failed gates · {harnessHealth?.exhausted_budgets ?? 0} exhausted</code></section>
    <section class="environment"><h2>Drift loop</h2><code>{driftReport?.status ?? 'not run'} · {driftReport?.repair_tasks.length ?? 0} repair task(s) · {driftReport?.invalidated_evidence.length ?? 0} invalidated evidence</code></section>
    <div class="grid">
      <section><h2>Harness loops</h2><p>{assurance.orchestration?.active_tasks ?? 0} active · {assurance.orchestration?.blocked_tasks ?? 0} blocked</p><ul>{#each assurance.orchestration?.runs.slice(0, 6) ?? [] as run (run.run_id)}<li><span>{run.run_id.slice(0, 8)}</span><strong data-result={run.run_state}>{run.run_state}</strong><small>{run.tasks.map((task) => `${task.id}: ${task.state}`).join(' · ')}</small></li>{/each}</ul></section>
      <section><h2>Gates & artifacts</h2><p>{assurance.orchestration?.failed_gates ?? 0} failed gate(s)</p><ul>{#each assurance.orchestration?.runs.flatMap((run) => run.gates.map((gate) => ({ ...gate, run: run.run_id }))).slice(0, 8) ?? [] as gate (`${gate.run}:${gate.id}`)}<li><span>{gate.id}</span><strong data-result={gate.status}>{gate.status.replaceAll('_', ' ')}</strong><small>Run {gate.run.slice(0, 8)} · {gate.reason}</small>{#if gate.status === 'approval_required'}<button class="approve-gate" disabled={approving === `${gate.run}:${gate.id}`} onclick={() => approve(gate.run, gate.id)}>Approve</button>{/if}</li>{/each}</ul></section>
      <section><h2>Evidence</h2><p>{assurance.evidence.length} claim record(s)</p><ul>{#each assurance.evidence.slice(0, 8) as item (item.id)}<li><span>{item.subject}</span><strong data-result={item.stale ? 'stale' : item.result}>{item.stale ? 'stale' : item.result}</strong><small>{item.claim}</small></li>{/each}</ul></section>
      <section><h2>Impact</h2><p>{assurance.diff.unmapped_product.length} unmapped product file(s)</p><ul>{#each assurance.impact.filter((item) => item.direct.length + item.transitive.length > 0).slice(0, 8) as item (item.subject)}<li><span>{item.subject}</span><strong>{item.direct.length + item.transitive.length}</strong><small>{item.required_tests.length} verification(s)</small></li>{/each}</ul></section>
      <section><h2>Policy</h2><p>Agent and Harness ownership boundaries</p><ul>{#each assurance.policy.forbidden_changes as item}<li><span>{item}</span><strong>blocked</strong></li>{/each}</ul></section>
      <section><h2>Risk</h2><p>Approval policy calculated from scope</p><ul>{#each assurance.risk.slice().sort((a, b) => b.score - a.score).slice(0, 8) as item (item.subject)}<li><span>{item.subject}</span><strong data-result={item.level}>{item.level}</strong><small>{item.required_approval}</small></li>{/each}</ul></section>
    </div>
    <section class="environment"><h2>Reproducible environment</h2><code>{assurance.environment.platform} · {assurance.environment.runtime} · lock {assurance.environment.lock_hash?.slice(0, 12) ?? 'none'}</code></section>
  {/if}
</div>

<style>
  .dashboard { padding: var(--sp-5); max-width: 1180px; margin: 0 auto; color: var(--fg-primary); }
  header p { margin: 0; color: var(--fg-tertiary); font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; }
  h1 { margin: var(--sp-1) 0 var(--sp-4); font-size: 26px; }
  h2 { margin: 0; font-size: var(--fs-md); }
  .metrics, .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-3); }
  .metrics { margin-bottom: var(--sp-4); }
  .metrics div, .grid section, .environment { border: 1px solid var(--bd-default); border-radius: var(--rad-md); background: var(--bg-subtle); padding: var(--sp-3); }
  .metrics span { display: block; color: var(--fg-tertiary); font-size: var(--fs-xs); }
  .metrics strong { display: block; margin-top: var(--sp-1); font-size: 22px; }
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  section > p { color: var(--fg-tertiary); font-size: var(--fs-sm); }
  ul { list-style: none; padding: 0; margin: var(--sp-3) 0 0; display: flex; flex-direction: column; gap: var(--sp-2); }
  li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px var(--sp-2); font-size: var(--fs-sm); }
  li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  li strong { color: var(--fg-secondary); text-transform: capitalize; }
  li small { grid-column: 1 / -1; color: var(--fg-tertiary); }
  [data-result='failed'], [data-result='critical'], [data-result='stale'] { color: var(--st-err); }
  [data-result='passed'], [data-result='low'] { color: var(--st-ok); }
  .approve-gate { grid-column: 1 / -1; justify-self: start; border: 1px solid var(--bd-default); border-radius: var(--rad-sm); background: var(--acc); color: var(--fg-on-accent); padding: 6px 14px; cursor: pointer; }
  .approve-gate:disabled { cursor: default; opacity: .55; }
  .environment { margin-top: var(--sp-3); display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3); }
  code { color: var(--fg-tertiary); font-size: var(--fs-xs); }
  .empty { color: var(--fg-tertiary); }
  @media (max-width: 860px) { .metrics, .grid { grid-template-columns: 1fr 1fr; } }
</style>
