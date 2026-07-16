import { createHash, randomUUID } from 'node:crypto'

import { buildAssuranceState } from './assurance.js'
import { scanWorkspace } from './commands.js'
import { driftWorkspace } from './gate.js'
import { atomicWrite, pathInside, readText } from '../store/workspace.js'

export interface DriftRepairTask {
  id: string
  title: string
  prompt: string
  severity: 'warning' | 'error'
  subject: string
  kind: 'mapping' | 'path' | 'verification' | 'evidence' | 'wild_spec' | 'constitution'
}

export interface DriftReport {
  schema_version: 1
  id: string
  trigger: 'startup' | 'git_change' | 'manual' | 'schedule'
  signature: string
  status: 'clean' | 'repair_required'
  findings: Array<{ code: string; message: string; severity: string }>
  invalidated_evidence: string[]
  repair_tasks: DriftRepairTask[]
  created_at: string
}

function signature(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function task(kind: DriftRepairTask['kind'], subject: string, title: string, prompt: string, severity: DriftRepairTask['severity']): DriftRepairTask {
  return { id: `drift-${createHash('sha1').update(`${kind}:${subject}`).digest('hex').slice(0, 12)}`, kind, subject, title, prompt, severity }
}

export async function readLatestDriftReport(workspace: string): Promise<DriftReport | null> {
  try { return JSON.parse(await readText(pathInside(workspace, '.specops', 'state', 'drift', 'latest.json'))) as DriftReport } catch { return null }
}

export async function runDriftLoop(workspace: string, trigger: DriftReport['trigger']): Promise<{ report: DriftReport; changed: boolean }> {
  const scan = await scanWorkspace(workspace)
  if (scan.data === undefined) throw new Error('cannot run Drift Loop without a valid registry')
  const [drift, assurance] = await Promise.all([driftWorkspace(workspace), buildAssuranceState(workspace, scan.data)])
  const repairs: DriftRepairTask[] = []
  for (const item of drift.data?.stale_paths ?? []) repairs.push(task('path', `${item.id}:${item.path}`, `Repair missing mapping path for ${item.id}`, `Update ${item.id} or restore its mapped product path: ${item.path}. Re-run mapping and verification.`, 'warning'))
  for (const item of drift.data?.unknown_verifies ?? []) repairs.push(task('verification', `${item.id}:${item.verify}`, `Restore verification ${item.verify}`, `Define verification ${item.verify} or update ${item.id} to a valid verifier.`, 'error'))
  for (const id of assurance.diff.unmapped_specs) repairs.push(task('mapping', id, `Map normative spec ${id}`, `Add explicit ProductGraph mappings and verification evidence for ${id}.`, 'warning'))
  for (const file of drift.data?.wild_specs ?? []) repairs.push(task('wild_spec', file, `Canonicalize wild spec ${file}`, `Move or link ${file} into the canonical .specops document graph.`, 'warning'))
  if (drift.data?.constitution_missing) repairs.push(task('constitution', 'constitution', 'Declare project constitution', 'Create .specops/constitution.md with project invariants and ownership policy.', 'warning'))
  const staleEvidence = assurance.evidence.filter((item) => item.stale)
  for (const evidence of staleEvidence) repairs.push(task('evidence', evidence.id, `Refresh evidence for ${evidence.subject}`, `Re-run ${evidence.claim}; evidence ${evidence.id} is stale because a dependency changed.`, 'error'))
  const findings = drift.diagnostics.map((item) => ({ code: item.code, message: item.message, severity: item.severity }))
  const contentSignature = signature({ findings, stale: staleEvidence.map((item) => item.id), repairs })
  const previous = await readLatestDriftReport(workspace)
  if (previous?.signature === contentSignature) return { report: previous, changed: false }
  const report: DriftReport = {
    schema_version: 1, id: randomUUID(), trigger, signature: contentSignature,
    status: repairs.some((item) => item.severity === 'error') || repairs.length > 0 ? 'repair_required' : 'clean',
    findings, invalidated_evidence: staleEvidence.map((item) => item.id), repair_tasks: repairs,
    created_at: new Date().toISOString(),
  }
  const directory = pathInside(workspace, '.specops', 'state', 'drift')
  await atomicWrite(pathInside(directory, `${report.id}.json`), `${JSON.stringify(report, null, 2)}\n`)
  await atomicWrite(pathInside(directory, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`)
  return { report, changed: true }
}
