import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'

import { buildAssuranceState } from './assurance.js'
import { scanWorkspace } from './commands.js'
import { listHarnessStates, readHarnessEvents } from './harness-core.js'
import { atomicWrite, pathInside, readText } from '../store/workspace.js'

export type HarnessRuleMode = 'shadow' | 'canary' | 'enforced' | 'disabled'
export interface HarnessRule { id: string; version: string; mode: HarnessRuleMode; rollout_percent: number; description: string }
export interface HarnessRules { schema_version: 1; version: string; rules: HarnessRule[] }

export interface HarnessHealth {
  total_runs: number
  completed_runs: number
  failed_runs: number
  first_pass_task_rate: number
  average_task_attempts: number
  average_spec_to_green_ms: number | null
  failed_gate_rate: number
  exhausted_budgets: number
}

export interface BenchmarkCase { id: string; title: string; expect: { min_mapping_rate?: number; max_failed_gates?: number; max_blocked_tasks?: number; max_stale_evidence?: number } }
export interface BenchmarkResult { id: string; case_id: string; passed: boolean; assertions: Array<{ name: string; passed: boolean; actual: number; expected: number }>; rules_version: string; created_at: string }

const DEFAULT_RULES: HarnessRules = {
  schema_version: 1, version: '1.0.0', rules: [
    { id: 'patch-policy', version: '1.0.0', mode: 'enforced', rollout_percent: 100, description: 'Protect Harness-owned files and assertions.' },
    { id: 'risk-approval', version: '1.0.0', mode: 'enforced', rollout_percent: 100, description: 'Require approval based on calculated risk.' },
    { id: 'runtime-trace', version: '0.1.0', mode: 'shadow', rollout_percent: 0, description: 'Collect browser and action traces without blocking.' },
  ],
}

export async function loadHarnessRules(workspace: string): Promise<HarnessRules> {
  try {
    const rules = JSON.parse(await readText(pathInside(workspace, '.specops', 'harness', 'rules.json'))) as HarnessRules
    if (rules.schema_version !== 1 || !Array.isArray(rules.rules)) throw new Error('invalid rules')
    return rules
  } catch { return DEFAULT_RULES }
}

export async function saveHarnessRules(workspace: string, rules: HarnessRules): Promise<void> {
  if (rules.schema_version !== 1 || !/^\d+\.\d+\.\d+/.test(rules.version)) throw new Error('invalid Harness rules version')
  for (const rule of rules.rules) {
    if (!['shadow', 'canary', 'enforced', 'disabled'].includes(rule.mode) || rule.rollout_percent < 0 || rule.rollout_percent > 100) throw new Error(`invalid rule: ${rule.id}`)
  }
  await atomicWrite(pathInside(workspace, '.specops', 'harness', 'rules.json'), `${JSON.stringify(rules, null, 2)}\n`)
}

export async function buildHarnessHealth(workspace: string): Promise<HarnessHealth> {
  const runs = await listHarnessStates(workspace)
  const tasks = runs.flatMap((run) => run.tasks)
  const gates = runs.flatMap((run) => run.gates)
  const greenDurations: number[] = []
  for (const run of runs) {
    const events = await readHarnessEvents(workspace, run.run_id)
    const start = events[0]?.at; const green = [...events].reverse().find((event) => event.type === 'run.transitioned' && event.data.state === 'completed')?.at
    if (start !== undefined && green !== undefined) greenDurations.push(new Date(green).getTime() - new Date(start).getTime())
  }
  const average = (values: number[]): number => values.length === 0 ? 0 : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
  return {
    total_runs: runs.length, completed_runs: runs.filter((run) => run.run_state === 'completed').length,
    failed_runs: runs.filter((run) => run.run_state === 'failed' || run.run_state === 'applied_failed').length,
    first_pass_task_rate: tasks.length === 0 ? 1 : tasks.filter((task) => task.attempt <= 1).length / tasks.length,
    average_task_attempts: average(tasks.map((task) => task.attempt)),
    average_spec_to_green_ms: greenDurations.length === 0 ? null : average(greenDurations),
    failed_gate_rate: gates.length === 0 ? 0 : gates.filter((gate) => gate.status === 'failed').length / gates.length,
    exhausted_budgets: runs.filter((run) => run.budget.exhausted).length,
  }
}

export async function runBenchmarks(workspace: string): Promise<BenchmarkResult[]> {
  const directory = pathInside(workspace, '.specops', 'benchmarks')
  let names: string[]
  try { names = await readdir(directory) } catch { return [] }
  const cases: BenchmarkCase[] = []
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    try { cases.push(JSON.parse(await readText(pathInside(directory, name))) as BenchmarkCase) } catch { /* isolate invalid corpus item */ }
  }
  const scan = await scanWorkspace(workspace)
  if (scan.data === undefined) return []
  const assurance = await buildAssuranceState(workspace, scan.data)
  const rules = await loadHarnessRules(workspace)
  const results: BenchmarkResult[] = []
  for (const item of cases) {
    const checks: BenchmarkResult['assertions'] = []
    const check = (name: string, actual: number, expected: number, passed: boolean): void => { checks.push({ name, actual, expected, passed }) }
    if (item.expect.min_mapping_rate !== undefined) check('mapping_rate', assurance.health.mapped_spec_rate, item.expect.min_mapping_rate, assurance.health.mapped_spec_rate >= item.expect.min_mapping_rate)
    if (item.expect.max_failed_gates !== undefined) check('failed_gates', assurance.orchestration.failed_gates, item.expect.max_failed_gates, assurance.orchestration.failed_gates <= item.expect.max_failed_gates)
    if (item.expect.max_blocked_tasks !== undefined) check('blocked_tasks', assurance.orchestration.blocked_tasks, item.expect.max_blocked_tasks, assurance.orchestration.blocked_tasks <= item.expect.max_blocked_tasks)
    if (item.expect.max_stale_evidence !== undefined) check('stale_evidence', assurance.health.stale_evidence, item.expect.max_stale_evidence, assurance.health.stale_evidence <= item.expect.max_stale_evidence)
    const result: BenchmarkResult = { id: randomUUID(), case_id: item.id, passed: checks.every((entry) => entry.passed), assertions: checks, rules_version: rules.version, created_at: new Date().toISOString() }
    await atomicWrite(pathInside(workspace, '.specops', 'state', 'benchmarks', `${result.id}.json`), `${JSON.stringify(result, null, 2)}\n`)
    results.push(result)
  }
  return results
}
