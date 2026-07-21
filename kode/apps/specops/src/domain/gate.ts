import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

import type { CommandResult, Diagnostic } from '../core/result.js'
import { SPEC_ID_PATTERN } from './spec.js'
import { loadConfig, type VerifyConfig } from './config.js'
import { detectWildSpecFiles, scanWorkspace, extractSectionBullets } from './commands.js'
import { exists, pathInside, readText, resolveGitWorkspace } from '../store/workspace.js'

const execFile = promisify(execFileCallback)

interface CommitRecord {
  hash: string
  parents: string[]
  message: string
}

export interface VerifyResult {
  name: string
  ok: boolean
  exit_code: number | null
  duration_ms: number
  stdout: string
  stderr: string
  truncated: boolean
}

export interface GateState {
  base: string
  head: string
  commits: Array<{ hash: string; references: string[] }>
  verify_results: VerifyResult[]
}

function parseReferences(message: string): Array<{ kind: 'spec' | 'change' | 'bug' | 'refactor' | 'feature' | 'investigation'; id: string }> {
  const references: Array<{ kind: 'spec' | 'change' | 'bug' | 'refactor' | 'feature' | 'investigation'; id: string }> = []
  for (const line of message.split('\n')) {
    const match = /^\s*(Spec|Change|Bug|Refactor|Feature|Investigation):\s*(.+?)\s*$/i.exec(line)
    if (match === null) continue
    const kind = match[1]?.toLowerCase() as 'spec' | 'change' | 'bug' | 'refactor' | 'feature' | 'investigation'
    for (const id of (match[2] ?? '').split(/[\s,]+/).filter(Boolean)) references.push({ kind, id })
  }
  return references
}

async function commitsInRange(workspace: string, base: string, head: string): Promise<CommitRecord[]> {
  const separator = '%x1e'
  const fields = '%H%x1f%P%x1f%B'
  const { stdout } = await execFile('git', ['-C', workspace, 'log', '--format=' + fields + separator, `${base}..${head}`])
  return stdout.split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const [hash = '', parents = '', ...message] = record.split('\x1f')
    return { hash, parents: parents.split(' ').filter(Boolean), message: message.join('\x1f') }
  }).filter((commit) => commit.parents.length <= 1)
}

function capOutput(value: string, limit: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value)
  if (bytes.length <= limit) return { text: value, truncated: false }
  return { text: bytes.subarray(0, limit).toString('utf8'), truncated: true }
}

export async function runVerify(workspace: string, name: string, config: VerifyConfig): Promise<VerifyResult> {
  const started = Date.now()
  const [program, ...args] = config.command
  if (program === undefined) throw new Error(`verify ${name} has an empty command`)
  const cwd = pathInside(workspace, config.cwd ?? '.')
  try {
    const { stdout, stderr } = await execFile(program, args, {
      cwd,
      timeout: config.timeout_ms,
      maxBuffer: config.output_limit_bytes * 2,
      encoding: 'utf8',
    })
    const out = capOutput(stdout, config.output_limit_bytes)
    const err = capOutput(stderr, config.output_limit_bytes)
    return { name, ok: true, exit_code: 0, duration_ms: Date.now() - started, stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated }
  } catch (error) {
    const known = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number }
    const out = capOutput(known.stdout ?? '', config.output_limit_bytes)
    const err = capOutput(known.stderr ?? known.message, config.output_limit_bytes)
    return {
      name,
      ok: false,
      exit_code: typeof known.code === 'number' ? known.code : null,
      duration_ms: Date.now() - started,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated,
    }
  }
}

export async function gateWorkspace(input: string, base: string, head: string, verifyNames: string[] = []): Promise<CommandResult<GateState>> {
  const workspace = await resolveGitWorkspace(input)
  const config = await loadConfig(workspace)
  const scan = await scanWorkspace(workspace)
  const diagnostics: Diagnostic[] = [...scan.diagnostics]
  const registry = new Map(scan.data?.documents.map((document) => [document.id, document]) ?? [])
  const commits = await commitsInRange(workspace, base, head)
  const summaries: GateState['commits'] = []
  const suppressCodes = new Set(config.gate.suppress.suppress_codes)
  const suppressTypes = config.gate.suppress.suppress_commit_types.map((t) => t.toLowerCase())
  for (const commit of commits) {
    // Check if this commit should be skipped based on commit type prefix.
    // Strip trailing colon and optional (scope) from the first word,
    // so that "feat:", "feat(gui):", and "fix(core):" all match their base types.
    const raw = commit.message.split('\n')[0]?.split(/\s+/)[0]?.toLowerCase()
    const noColon = raw?.endsWith(':') ? raw.slice(0, -1) : raw
    const commitType = noColon?.replace(/\(.*\)$/, '')
    if (commitType && suppressTypes.includes(commitType)) continue

    const references = parseReferences(commit.message)
    summaries.push({ hash: commit.hash, references: references.map((item) => `${item.kind}:${item.id}`) })
    if (references.length === 0) {
      const severity: 'error' | 'warning' = suppressCodes.has('missing_reference') ? 'warning' : 'error'
      diagnostics.push({ code: 'missing_reference', message: `${commit.hash.slice(0, 12)} has no Spec, Change, Bug, Refactor, Feature, or Investigation reference`, severity })
    }
    for (const reference of references) {
      if (!SPEC_ID_PATTERN.test(reference.id)) {
        const severity: 'error' | 'warning' = suppressCodes.has('invalid_reference') ? 'warning' : 'error'
        diagnostics.push({ code: 'invalid_reference', message: `${commit.hash.slice(0, 12)} has invalid ${reference.kind} id: ${reference.id}`, severity })
      } else {
        const document = registry.get(reference.id)
        if (document === undefined || document.kind !== reference.kind) {
          const severity: 'error' | 'warning' = suppressCodes.has('unknown_reference') ? 'warning' : 'error'
          diagnostics.push({ code: 'unknown_reference', message: `${commit.hash.slice(0, 12)} references unknown ${reference.kind}: ${reference.id}`, severity })
        }
      }
    }
  }
  const verifyResults: VerifyResult[] = []
  for (const name of verifyNames) {
    const verify = config.verify[name]
    if (verify === undefined) {
      diagnostics.push({ code: 'unknown_verify', message: `verify is not configured: ${name}`, severity: 'error' })
      continue
    }
    const result = await runVerify(workspace, name, verify)
    verifyResults.push(result)
    if (!result.ok) diagnostics.push({ code: 'verify_failed', message: `${name} failed`, severity: 'error' })
  }
  return {
    ok: !diagnostics.some((item) => item.severity === 'error'),
    command: 'gate',
    data: { base, head, commits: summaries, verify_results: verifyResults },
    diagnostics,
  }
}

export interface DriftState {
  stale_paths: Array<{ id: string; path: string }>
  unknown_verifies: Array<{ id: string; verify: string }>
  wild_specs: string[]
  constitution_missing: boolean
}

export async function driftWorkspace(input: string): Promise<CommandResult<DriftState>> {
  const workspace = await resolveGitWorkspace(input)
  const config = await loadConfig(workspace)
  const scan = await scanWorkspace(workspace)
  const stalePaths: DriftState['stale_paths'] = []
  const unknownVerifies: DriftState['unknown_verifies'] = []
  const wildSpecs = await detectWildSpecFiles(workspace)
  const constitutionMissing = !await exists(pathInside(workspace, '.specops', 'constitution.md'))
  for (const document of scan.data?.documents ?? []) {
    if (document.status !== 'active') continue
    for (const candidate of document.paths) {
      if (!await exists(pathInside(workspace, candidate))) {
        stalePaths.push({ id: document.id, path: candidate })
      }
    }
    for (const verify of document.verifies) {
      if (config.verify[verify] === undefined) unknownVerifies.push({ id: document.id, verify })
    }
  }
  const diagnostics: Diagnostic[] = [
    ...scan.diagnostics,
    ...stalePaths.map((item) => ({ code: 'stale_path', message: `${item.id} references missing path ${item.path}`, severity: 'warning' as const })),
    ...unknownVerifies.map((item) => ({ code: 'unknown_verify', message: `${item.id} references unknown verify ${item.verify}`, severity: 'error' as const })),
    ...wildSpecs.map((file) => ({
      code: 'wild_spec',
      message: `spec-like file is outside .specops: ${file}`,
      severity: config.gate.strict_wild_specs ? 'error' as const : 'warning' as const,
    })),
    ...(constitutionMissing ? [{ code: 'missing_constitution', message: '.specops/constitution.md is missing — project has no declared invariants', severity: 'warning' as const }] : []),
  ]
  return {
    ok: !diagnostics.some((item) => item.severity === 'error'),
    command: 'drift',
    data: { stale_paths: stalePaths, unknown_verifies: unknownVerifies, wild_specs: wildSpecs, constitution_missing: constitutionMissing },
    diagnostics,
  }
}

// ── Analyze (cross-artifact consistency) ──

export interface CrossArtifactGap {
  id: string
  gap: string
  severity: 'error' | 'warning' | 'info'
}

export interface AnalyzeState {
  cross_artifact_gaps: CrossArtifactGap[]
  constitution_missing: boolean
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your',
  'have', 'will', 'should', 'must', 'shall', 'when', 'what', 'which',
  'their', 'they', 'are', 'was', 'were', 'been', 'being', 'have', 'has',
  'had', 'does', 'done', 'make', 'made', 'more', 'than', 'also',
  // Common scope-level gerunds / generic verbs that rarely appear in tasks
  'adding', 'changing', 'creating', 'modifying', 'removing', 'updating',
  'ensure', 'decide', 'implement', 'implementing', 'verify', 'include',
  'consider', 'support', 'provide', 'maintain', 'prevent',
  'recommend', 'existing', 'whether', 'clarify', 'full', 'blown',
])

/** Extract significant words (>=4 chars, not stopwords) from a bullet line.
 *  Returns all candidates; matching succeeds if ANY candidate appears in tasks. */
function significantWords(bullet: string): string[] {
  const words = bullet.replace(/^[-*]\s*/, '').split(/\s+/)
  const candidates: string[] = []
  for (const word of words) {
    const cleaned = word.replace(/[^A-Za-z0-9_-]/g, '')
    if (cleaned.length < 4) continue
    const lower = cleaned.toLowerCase()
    if (STOPWORDS.has(lower)) continue
    // Skip file-path-like tokens (all-caps or mixed-case without lowercase letters)
    // e.g. "CODEBUDDYmd", "READMEmd", "specopstoml"
    if (/^[A-Z0-9_-]+$/.test(cleaned) || /^[a-z]+[A-Z]+[a-z]*$/.test(cleaned)) continue
    candidates.push(cleaned)
  }
  return candidates
}

/** Extract level-N markdown headings (e.g. ## Foo → 'Foo'). */
function extractHeadings(body: string, level: number): string[] {
  const pattern = new RegExp(`^${'#'.repeat(level)}\\s+(.+)$`, 'm')
  const headings: string[] = []
  for (const line of body.split('\n')) {
    const match = pattern.exec(line)
    if (match !== null && match[1] !== undefined) headings.push(match[1].trim())
  }
  return headings
}

export async function analyzeWorkspace(input: string): Promise<CommandResult<AnalyzeState>> {
  const workspace = await resolveGitWorkspace(input)
  const scan = await scanWorkspace(workspace)
  const diagnostics: Diagnostic[] = [...scan.diagnostics]
  const gaps: CrossArtifactGap[] = []
  const config = await loadConfig(workspace)

  const changeEntries = (scan.data?.documents ?? []).filter((d) => d.kind !== 'spec' && d.status !== 'archived')

  for (const entry of changeEntries) {
    const folderPath = pathInside(workspace, entry.path)
    const proposalPath = path.join(folderPath, 'proposal.md')
    const tasksPath = path.join(folderPath, 'tasks.md')
    const designPath = path.join(folderPath, 'design.md')

    let proposalBody = '', tasksBody = '', designBody = ''
    try { proposalBody = (await readText(proposalPath)).replace(/^---[\s\S]*?---\n?/, '') } catch { /* missing */ }
    try { tasksBody = await readText(tasksPath) } catch { /* missing */ }
    try { designBody = await readText(designPath) } catch { /* optional */ }

    const tasksLower = tasksBody.toLowerCase()

    // Check 1: proposal ## Scope bullets — at least one significant word from each
    // bullet should appear in tasks.md. Uses all-word matching, not just first word.
    const scopeItems = extractSectionBullets(proposalBody, 'Scope')
    for (const item of scopeItems) {
      const candidates = significantWords(item)
      if (candidates.length === 0) continue
      const found = candidates.some((c) => tasksLower.includes(c.toLowerCase()))
      if (!found) {
        gaps.push({ id: entry.id, gap: `tasks.md does not reference scope item "${candidates[0]}" from proposal`, severity: 'warning' })
      }
    }

    // Check 2: design.md headings explicitly marked as "## Component: X" should appear
    // in tasks. Plain section headings (e.g. "## Problem diagnosis", "## Trade-offs")
    // are document structure, not implementation components — skip those.
    if (designBody) {
      const designHeadings = extractHeadings(designBody, 2)
      for (const heading of designHeadings) {
        const keyword = heading.replace(/^Component:\s*/i, '')
        // Only flag headings that were explicitly marked as components
        if (!/^Component:/i.test(heading)) continue
        if (keyword.length < 4) continue
        if (!tasksLower.includes(keyword.toLowerCase())) {
          gaps.push({ id: entry.id, gap: `design component "${keyword}" not referenced in tasks.md`, severity: 'warning' })
        }
      }
    }

    // Check 3: verifies references valid
    for (const verify of entry.verifies) {
      if (config.verify[verify] === undefined) {
        gaps.push({ id: entry.id, gap: `unknown verify: ${verify}`, severity: 'error' })
      }
    }
  }

  const constitutionMissing = !await exists(pathInside(workspace, '.specops', 'constitution.md'))

  for (const gap of gaps) {
    const severity: 'error' | 'warning' = gap.severity === 'error' ? 'error' : 'warning'
    diagnostics.push({ code: 'cross_artifact_gap', message: `${gap.id}: ${gap.gap}`, severity })
  }

  return {
    ok: !diagnostics.some((d) => d.severity === 'error'),
    command: 'analyze',
    data: { cross_artifact_gaps: gaps, constitution_missing: constitutionMissing },
    diagnostics,
  }
}
