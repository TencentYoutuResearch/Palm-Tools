import { createHash, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

import type { RegistryState } from './commands.js'
import type { VerifyResult } from './gate.js'
import { atomicWrite, exists, pathInside, readText, resolveGitWorkspace } from '../store/workspace.js'
import { listHarnessStates, type HarnessControlState } from './harness-core.js'
import { productAdapterNodes, structuredSpecNodes } from './graph-adapters.js'

export type GraphNodeKind = 'capability' | 'requirement' | 'screen' | 'action' | 'state' | 'api' | 'contract' | 'verification' | 'architecture' | 'policy' | 'invariant' | 'work_item' | 'source' | 'test'

export interface GraphNode { id: string; kind: GraphNodeKind; label: string; status: string; path?: string; parent_id?: string; adapter?: string }
export interface GraphEdge { from: string; to: string; relation: 'targets' | 'maps_to' | 'verified_by' | 'depends_on' | 'contains' | 'calls' }
export interface MappingEntry { spec_id: string; paths: string[]; verifies: string[]; coverage: 'mapped' | 'partial' | 'missing'; source: 'frontmatter' | 'manifest' | 'inferred'; confidence: number; version: number }
export interface CompletionContract { subject: string; required_evidence: string[]; forbidden: string[]; pass_condition: { all_required_evidence: boolean; critical_drift: number; gate_status: 'pending' | 'passed' | 'failed' } }
export interface EvidenceRecord {
  schema_version: 1
  id: string
  subject: string
  claim: string
  producer: string
  environment: { commit: string; platform: string; runtime: string; lock_hash: string | null }
  artifacts: string[]
  result: 'passed' | 'failed'
  depends_on: string[]
  dependency_hashes?: Record<string, string>
  stale: boolean
  created_at: string
}
export type RuntimeEvidenceKind = 'screenshot' | 'action_trace' | 'network_trace' | 'api_contract' | 'coverage' | 'console_log'
export interface ImpactReport { subject: string; direct: string[]; transitive: string[]; affected_specs: string[]; required_tests: string[] }
export interface RiskReport { subject: string; score: number; level: 'low' | 'medium' | 'high' | 'critical'; dimensions: Record<string, number>; required_approval: 'automatic' | 'human_review' | 'design_and_human_review' | 'plan_only' }
export interface AssuranceState {
  spec_graph: { nodes: GraphNode[]; edges: GraphEdge[] }
  product_graph: { nodes: GraphNode[]; edges: GraphEdge[] }
  mappings: MappingEntry[]
  diff: { unmapped_specs: string[]; unmapped_product: string[]; missing_paths: string[]; missing_verification: string[] }
  completion_contracts: CompletionContract[]
  evidence: EvidenceRecord[]
  impact: ImpactReport[]
  risk: RiskReport[]
  policy: { harness_owned: string[]; agent_read_only: string[]; agent_editable: string[]; forbidden_changes: string[] }
  environment: { platform: string; runtime: string; lock_hash: string | null }
  health: { mapped_spec_rate: number; evidence_coverage_rate: number; stale_evidence: number; critical_risks: number }
  orchestration: { runs: HarnessControlState[]; active_tasks: number; blocked_tasks: number; failed_gates: number }
}

const POLICY = {
  harness_owned: ['.specops/gates/**', '.specops/contracts/**', 'tests/acceptance/generated/**'],
  agent_read_only: ['tests/acceptance/golden/**', 'security/policies/**'],
  agent_editable: ['src/**', 'apps/**', 'crates/**', 'tests/unit/**'],
  forbidden_changes: ['test_assertion_reduction', 'harness_owned_test_change', 'hardcoded_success', 'mock_only_implementation', 'unrelated_file_change'],
}

export function evaluatePatchPolicy(files: string[], patch: string): Array<{ code: string; path?: string; message: string; severity: 'error' | 'warning' }> {
  const findings: Array<{ code: string; path?: string; message: string; severity: 'error' | 'warning' }> = []
  for (const file of files) {
    if (/^(?:\.specops\/(?:gates|contracts)\/|tests\/acceptance\/(?:generated|golden)\/|security\/policies\/)/.test(file)) {
      findings.push({ code: 'protected_file_change', path: file, message: `${file} is Harness-owned or read-only`, severity: 'error' })
    }
  }
  const removedAssertions = patch.split('\n').filter((line) => /^-(?!-)/.test(line) && /\b(expect|assert|should|must)\b/.test(line)).length
  const addedAssertions = patch.split('\n').filter((line) => /^\+(?!\+)/.test(line) && /\b(expect|assert|should|must)\b/.test(line)).length
  if (removedAssertions > addedAssertions) findings.push({ code: 'test_assertion_reduction', message: 'Patch removes more assertions than it adds', severity: 'error' })
  if (/^\+.*(?:hardcoded.success|mock.only|TODO.*pass)/im.test(patch)) findings.push({ code: 'suspicious_implementation', message: 'Patch contains a hardcoded/mock-only completion marker', severity: 'warning' })
  return findings
}

function rate(part: number, total: number): number { return total === 0 ? 1 : Math.round((part / total) * 10_000) / 100 }
function unique(values: string[]): string[] { return [...new Set(values)].sort() }

async function scanProductFiles(workspace: string): Promise<string[]> {
  const ignored = new Set(['.git', '.specops', 'node_modules', 'target', 'dist', 'build', '.svelte-kit'])
  const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.rs', '.go', '.dart', '.py', '.java', '.kt', '.swift'])
  const files: string[] = []
  const walk = async (directory: string): Promise<void> => {
    if (files.length >= 10_000) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(candidate)
      else if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(path.relative(workspace, candidate))
    }
  }
  await walk(workspace)
  return files.sort()
}

async function sourceDependencies(workspace: string, files: string[]): Promise<Map<string, string[]>> {
  const fileSet = new Set(files)
  const result = new Map<string, string[]>()
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.rs', '.go', '.dart', '.py']
  for (const file of files) {
    let content: string
    try { content = await readText(pathInside(workspace, file)) } catch { continue }
    const dependencies: string[] = []
    const pattern = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier === undefined || !specifier.startsWith('.')) continue
      const base = path.normalize(path.join(path.dirname(file), specifier))
      const resolved = extensions.map((extension) => `${base}${extension}`).find((candidate) => fileSet.has(candidate))
        ?? extensions.map((extension) => path.join(base, `index${extension}`)).find((candidate) => fileSet.has(candidate))
      if (resolved !== undefined) dependencies.push(resolved)
    }
    result.set(file, unique(dependencies))
  }
  return result
}

async function lockHash(workspace: string): Promise<string | null> {
  const names = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock', 'pubspec.lock']
  const hash = createHash('sha256')
  let found = false
  for (const name of names) {
    const file = path.join(workspace, name)
    if (!await exists(file)) continue
    hash.update(name).update(await readText(file)); found = true
  }
  return found ? hash.digest('hex') : null
}

async function fileHash(workspace: string, relative: string): Promise<string> {
  try { return createHash('sha256').update(await readText(pathInside(workspace, relative))).digest('hex') } catch { return 'missing' }
}

async function dependencyHashes(workspace: string, paths: string[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(unique(paths).map(async (item) => [item, await fileHash(workspace, item)] as const)))
}

async function readMappingManifest(workspace: string): Promise<Map<string, { paths: string[]; verifies: string[]; confidence: number; version: number }>> {
  try {
    const raw = JSON.parse(await readText(pathInside(workspace, '.specops', 'mappings.json'))) as { version?: number; mappings?: Array<{ spec_id?: string; paths?: unknown; verifies?: unknown; confidence?: number }> }
    const result = new Map<string, { paths: string[]; verifies: string[]; confidence: number; version: number }>()
    for (const entry of raw.mappings ?? []) {
      if (typeof entry.spec_id !== 'string') continue
      result.set(entry.spec_id, {
        paths: Array.isArray(entry.paths) ? entry.paths.filter((item): item is string => typeof item === 'string') : [],
        verifies: Array.isArray(entry.verifies) ? entry.verifies.filter((item): item is string => typeof item === 'string') : [],
        confidence: typeof entry.confidence === 'number' ? Math.max(0, Math.min(1, entry.confidence)) : 1,
        version: typeof raw.version === 'number' ? raw.version : 1,
      })
    }
    return result
  } catch { return new Map() }
}

async function readEvidence(workspace: string): Promise<EvidenceRecord[]> {
  const directory = pathInside(workspace, '.specops', 'state', 'evidence')
  let names: string[]
  try { names = await readdir(directory) } catch { return [] }
  const records: EvidenceRecord[] = []
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    try {
      const record = JSON.parse(await readText(path.join(directory, name))) as EvidenceRecord
      if (record.dependency_hashes !== undefined) {
        const current = await dependencyHashes(workspace, record.depends_on)
        record.stale = record.depends_on.some((item) => current[item] !== record.dependency_hashes?.[item])
      }
      records.push(record)
    } catch { /* diagnostic is represented by absent evidence */ }
  }
  return records.sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export async function recordVerificationEvidence(workspaceInput: string, subject: string, commit: string, results: VerifyResult[], dependsOn: string[], observedRootInput?: string): Promise<EvidenceRecord[]> {
  const workspace = await resolveGitWorkspace(workspaceInput)
  const observedRoot = observedRootInput ?? workspace
  const environment = { platform: `${process.platform}-${process.arch}`, runtime: process.version, lock_hash: await lockHash(observedRoot) }
  const records: EvidenceRecord[] = []
  for (const result of results) {
    const record: EvidenceRecord = {
      schema_version: 1, id: randomUUID(), subject, claim: `verification:${result.name}`, producer: 'specops-command-verifier',
      environment: { commit, ...environment }, artifacts: [], result: result.ok ? 'passed' : 'failed', depends_on: unique(dependsOn), dependency_hashes: await dependencyHashes(observedRoot, dependsOn), stale: false, created_at: new Date().toISOString(),
    }
    await atomicWrite(pathInside(workspace, '.specops', 'state', 'evidence', `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`)
    records.push(record)
  }
  return records
}

export async function recordRuntimeEvidence(workspaceInput: string, input: { subject: string; commit: string; kind: RuntimeEvidenceKind; artifact: string; producer: string; passed: boolean; depends_on?: string[] }): Promise<EvidenceRecord> {
  const workspace = await resolveGitWorkspace(workspaceInput)
  if (!input.artifact.startsWith('.specops/') && !input.artifact.startsWith('artifact:')) throw new Error('runtime evidence artifact must be a canonical .specops path or artifact id')
  const dependencies = unique(input.depends_on ?? [])
  const record: EvidenceRecord = {
    schema_version: 1, id: randomUUID(), subject: input.subject, claim: `runtime:${input.kind}`, producer: input.producer,
    environment: { commit: input.commit, platform: `${process.platform}-${process.arch}`, runtime: process.version, lock_hash: await lockHash(workspace) },
    artifacts: [input.artifact], result: input.passed ? 'passed' : 'failed', depends_on: dependencies,
    dependency_hashes: await dependencyHashes(workspace, dependencies), stale: false, created_at: new Date().toISOString(),
  }
  await atomicWrite(pathInside(workspace, '.specops', 'state', 'evidence', `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

function riskFor(id: string, paths: string[], bodyHints: string): RiskReport {
  const text = `${paths.join(' ')} ${bodyHints}`.toLowerCase()
  const dimensions = {
    security: /security|auth|secret|permission/.test(text) ? 3 : 0,
    data_migration: /migration|schema|database|sqlite/.test(text) ? 3 : 0,
    public_api_breaking: /api|protocol|contract/.test(text) ? 2 : 0,
    cross_module: new Set(paths.map((item) => item.split('/')[0])).size > 1 ? 2 : 0,
    file_count: paths.length >= 10 ? 2 : paths.length >= 4 ? 1 : 0,
    test_coverage_gap: paths.some((item) => /test|spec/.test(item)) ? 0 : 2,
  }
  const score = Object.values(dimensions).reduce((sum, value) => sum + value, 0)
  const level = score >= 10 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low'
  const approvals = { low: 'automatic', medium: 'human_review', high: 'design_and_human_review', critical: 'plan_only' } as const
  return { subject: id, score, level, dimensions, required_approval: approvals[level] }
}

export async function buildAssuranceState(workspaceInput: string, registry: RegistryState): Promise<AssuranceState> {
  const workspace = await resolveGitWorkspace(workspaceInput)
  const scannedProductFiles = await scanProductFiles(workspace)
  const dependencies = await sourceDependencies(workspace, scannedProductFiles)
  const evidence = await readEvidence(workspace)
  const harnessRuns = await listHarnessStates(workspace)
  const mappingManifest = await readMappingManifest(workspace)
  const nodes: GraphNode[] = []
  const productNodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const productEdges: GraphEdge[] = []
  const mappings: MappingEntry[] = []
  const impacts: ImpactReport[] = []
  const risks: RiskReport[] = []
  const contracts: CompletionContract[] = []
  const missingPaths: string[] = []
  const missingVerification: string[] = []

  for (const doc of registry.documents) {
    const normative = (doc.document_class ?? (doc.kind === 'spec' ? 'normative' : 'work_item')) === 'normative'
    const nodeKind = normative ? (doc.spec_type ?? 'capability') as GraphNodeKind : 'work_item'
    nodes.push({ id: doc.id, kind: nodeKind, label: doc.title, status: doc.status, path: doc.path })
    for (const target of doc.targets ?? []) edges.push({ from: doc.id, to: target, relation: 'targets' })
    const explicitMapping = mappingManifest.get(doc.id)
    const mappedPaths = unique([...(explicitMapping?.paths ?? []), ...doc.paths])
    const mappedVerifies = unique([...(explicitMapping?.verifies ?? []), ...doc.verifies])
    const existingPaths: string[] = []
    for (const candidate of mappedPaths) {
      if (!await exists(pathInside(workspace, candidate))) { missingPaths.push(`${doc.id}:${candidate}`); continue }
      existingPaths.push(candidate)
      const kind: GraphNodeKind = /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\./.test(candidate) ? 'test' : 'source'
      productNodes.set(candidate, { id: `file:${candidate}`, kind, label: path.basename(candidate), status: 'present', path: candidate })
      productEdges.push({ from: doc.id, to: `file:${candidate}`, relation: kind === 'test' ? 'verified_by' : 'maps_to' })
    }
    if (normative && mappedVerifies.length === 0) missingVerification.push(doc.id)
    mappings.push({ spec_id: doc.id, paths: existingPaths, verifies: mappedVerifies, coverage: existingPaths.length === 0 && mappedVerifies.length === 0 ? 'missing' : existingPaths.length !== mappedPaths.length ? 'partial' : 'mapped', source: explicitMapping === undefined ? 'frontmatter' : 'manifest', confidence: explicitMapping?.confidence ?? 1, version: explicitMapping?.version ?? 1 })
    impacts.push({ subject: doc.id, direct: existingPaths, transitive: [], affected_specs: registry.documents.filter((other) => (other.targets ?? []).includes(doc.id)).map((other) => other.id), required_tests: mappedVerifies })
    risks.push(riskFor(doc.id, mappedPaths, `${doc.title} ${doc.work_type ?? ''}`))
    if (normative) contracts.push({
      subject: doc.id,
      required_evidence: unique([...mappedVerifies.map((name) => `verification:${name}`), ...(mappedPaths.length > 0 ? ['source_mapping'] : [])]),
      forbidden: [...POLICY.forbidden_changes],
      pass_condition: { all_required_evidence: existingPaths.length === mappedPaths.length && mappedVerifies.every((name) => evidence.some((item) => item.subject === doc.id && item.claim === `verification:${name}` && item.result === 'passed' && !item.stale)), critical_drift: 0, gate_status: 'pending' },
    })
  }
  for (const contract of contracts) contract.pass_condition.gate_status = contract.pass_condition.all_required_evidence ? 'passed' : 'failed'
  const mappedProductPaths = new Set(mappings.flatMap((item) => item.paths))
  for (const candidate of scannedProductFiles) {
    if (productNodes.has(candidate)) continue
    const kind: GraphNodeKind = /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\./.test(candidate) ? 'test' : 'source'
    productNodes.set(candidate, { id: `file:${candidate}`, kind, label: path.basename(candidate), status: mappedProductPaths.has(candidate) ? 'mapped' : 'unmapped', path: candidate })
  }
  for (const [source, targets] of dependencies) for (const target of targets) {
    productEdges.push({ from: `file:${source}`, to: `file:${target}`, relation: 'depends_on' })
  }
  const [structuredSpec, adaptedProduct] = await Promise.all([
    structuredSpecNodes(workspace, registry.documents), productAdapterNodes(workspace, scannedProductFiles),
  ])
  nodes.push(...structuredSpec.nodes); edges.push(...structuredSpec.edges)
  for (const node of adaptedProduct.nodes) productNodes.set(node.id, node)
  productEdges.push(...adaptedProduct.edges)
  for (const impact of impacts) {
    const seen = new Set(impact.direct); const queue = [...impact.direct]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const [consumer, deps] of dependencies) {
        if (!deps.includes(current) || seen.has(consumer)) continue
        seen.add(consumer); queue.push(consumer)
      }
    }
    impact.transitive = [...seen].filter((item) => !impact.direct.includes(item)).sort()
  }
  const normativeMappings = mappings.filter((item) => registry.documents.find((doc) => doc.id === item.spec_id)?.kind === 'spec')
  const mapped = normativeMappings.filter((item) => item.coverage === 'mapped').length
  const evidenceSubjects = new Set(evidence.filter((item) => item.result === 'passed' && !item.stale).map((item) => item.subject))
  const environment = { platform: `${process.platform}-${process.arch}`, runtime: process.version, lock_hash: await lockHash(workspace) }
  return {
    spec_graph: { nodes, edges }, product_graph: { nodes: [...productNodes.values()], edges: productEdges }, mappings,
    diff: { unmapped_specs: normativeMappings.filter((item) => item.coverage === 'missing').map((item) => item.spec_id), unmapped_product: scannedProductFiles.filter((item) => !mappedProductPaths.has(item)), missing_paths: missingPaths, missing_verification: missingVerification },
    completion_contracts: contracts, evidence, impact: impacts, risk: risks, policy: POLICY, environment,
    health: { mapped_spec_rate: rate(mapped, normativeMappings.length), evidence_coverage_rate: rate(evidenceSubjects.size, normativeMappings.length), stale_evidence: evidence.filter((item) => item.stale).length, critical_risks: risks.filter((item) => item.level === 'critical').length },
    orchestration: {
      runs: harnessRuns,
      active_tasks: harnessRuns.flatMap((run) => run.tasks).filter((task) => task.state === 'running' || task.state === 'verifying' || task.state === 'reviewing').length,
      blocked_tasks: harnessRuns.flatMap((run) => run.tasks).filter((task) => task.state === 'blocked').length,
      failed_gates: harnessRuns.flatMap((run) => run.gates).filter((gate) => gate.status === 'failed').length,
    },
  }
}
