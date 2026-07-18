import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import type { CommandResult, Diagnostic } from '../core/result.js'
import { parseDocument, serializeDocument, type ChangeFile, type SpecDocument } from './spec.js'
import { trustWorktreeRoot } from './trust.js'
import { BUILTIN_AGENT_PROMPTS, DEFAULT_AGENT_PROMPT_FILES } from './agent-prompts.js'
import {
  atomicWrite,
  exists,
  listDirectories,
  listMarkdownFiles,
  pathInside,
  readText,
  resolveGitWorkspace,
} from '../store/workspace.js'

import workflowSkill from '../skills/specops.workflow.md' with { type: 'text' }
import createDocumentSkill from '../skills/specops.create-document.md' with { type: 'text' }
import createRunSkill from '../skills/specops.create-run.md' with { type: 'text' }
import getRunSkill from '../skills/specops.get-run.md' with { type: 'text' }
import verifyRunSkill from '../skills/specops.verify-run.md' with { type: 'text' }
import decideRunSkill from '../skills/specops.decide-run.md' with { type: 'text' }
import applyRunSkill from '../skills/specops.apply-run.md' with { type: 'text' }
import listDocumentsSkill from '../skills/specops.list-documents.md' with { type: 'text' }
import intakeSkill from '../skills/specops.intake.md' with { type: 'text' }
import archiveChangeSkill from '../skills/specops.archive-change.md' with { type: 'text' }
import constitutionSkill from '../skills/specops.constitution.md' with { type: 'text' }
import checklistSkill from '../skills/specops.checklist.md' with { type: 'text' }
import clarifySkill from '../skills/specops.clarify.md' with { type: 'text' }
import analyzeSkill from '../skills/specops.analyze.md' with { type: 'text' }

const BUILTIN_SKILLS: Record<string, string> = {
  'specops.workflow.md': workflowSkill,
  'specops.create-document.md': createDocumentSkill,
  'specops.create-run.md': createRunSkill,
  'specops.get-run.md': getRunSkill,
  'specops.verify-run.md': verifyRunSkill,
  'specops.decide-run.md': decideRunSkill,
  'specops.apply-run.md': applyRunSkill,
  'specops.list-documents.md': listDocumentsSkill,
  'specops.intake.md': intakeSkill,
  'specops.archive-change.md': archiveChangeSkill,
  'specops.constitution.md': constitutionSkill,
  'specops.checklist.md': checklistSkill,
  'specops.clarify.md': clarifySkill,
  'specops.analyze.md': analyzeSkill,
}

const SPECOPS_DIRS = ['specs', 'changes', 'state', 'runs', 'agents'] as const

const CONSTITUTION_SEED = `# Project Constitution

> Edit this file to declare project-level invariants. SpecOps skills read it first.

## Principles
- (placeholder) State the project's core values here.

## Invariants
- (placeholder) Must-not / must-always rules.

## Guardrails
- (placeholder) Process constraints.
`

export interface ConstitutionState {
  path: string
  body: string
  principles: string[]
  invariants: string[]
  guardrails: string[]
}

/** Extract bullet items (- text) under a ## heading, stopping at the next ## heading. */
export function extractSectionBullets(body: string, heading: string): string[] {
  const lines = body.split('\n')
  const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i')
  const bullets: string[] = []
  let inSection = false
  for (const line of lines) {
    // Stop at any heading (## or ###) — this prevents "Out of scope" sub-sections
    // from leaking into the "Scope" bullet extraction.
    if (/^(##|###)\s/.test(line)) {
      inSection = pattern.test(line)
      continue
    }
    if (inSection) {
      const match = /^\s*-\s+(.+)$/.exec(line)
      if (match !== null && match[1] !== undefined) bullets.push(match[1].trim())
    }
  }
  return bullets
}

async function topLevelModules(workspace: string): Promise<string[]> {
  const ignored = new Set(['.git', '.specops', '.pnpm-store', 'node_modules', 'target', 'dist', 'build'])
  const entries = await readdir(workspace, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !ignored.has(entry.name))
    .map((entry) => entry.name)
    .sort()
}

export async function initWorkspace(input: string): Promise<CommandResult<{ workspace: string; created: string[] }>> {
  const workspace = await resolveGitWorkspace(input)
  const root = pathInside(workspace, '.specops')
  const created: string[] = []
  for (const directory of SPECOPS_DIRS) await mkdir(path.join(root, directory), { recursive: true })
  // Also create the archive directory under changes
  await mkdir(path.join(root, 'changes', 'archive'), { recursive: true })

  // Pre-trust the worktree cache root so codebuddy won't show "trust this directory?"
  await trustWorktreeRoot()

  const configPath = pathInside(workspace, 'specops.toml')
  if (!await exists(configPath)) {
    const seedConfig = [
      'schema_version = 1',
      '',
      '[project]',
      `name = ${JSON.stringify(path.basename(workspace))}`,
      '# Optional composable project profiles used to build immutable Run manifests.',
      '# profiles = ["web", "react", "node"]',
      '',
      '# Workspace-level agent selection. Role settings inherit from default;',
      '# omit model to use the selected Kode backend\'s own default model.',
      '[agents.default]',
      'backend = "codebuddy"',
      '# model = ""',
      '',
      '[agents.analysis]       # Clarify / Plan primary agent',
      'prompt_file = ".specops/agents/clarify.md"',
      '# backend = "claude"',
      '# model = "claude-sonnet"',
      '',
      '[agents.implementation] # implement, repair, resume',
      'prompt_file = ".specops/agents/implementation.md"',
      '# backend = "codex"',
      '# model = "gpt-5-codex"',
      '',
      '[agents.review]',
      'prompt_file = ".specops/agents/review.md"',
      '# backend = "claude"',
      '# model = "claude-opus"',
      '',
      '# Backend capability declarations are snapshots, not executable plugins.',
      '# Missing backends use the conservative builtin.kode capability profile.',
      '# [agent_backends.codebuddy]',
      '# plugin = "builtin.kode"',
      '# capabilities = ["session.create", "session.resume", "conversation.ask", "conversation.plan"]',
      '',
      '# Override workflow stages per work kind. Defaults exist for feature, bug,',
      '# refactor, investigation, and docs.',
      '# [workflow.feature]',
      '# stages = ["clarify", "impact", "plan", "build", "verify", "review", "apply", "drift"]',
      '',
      '[gate]',
      'strict_wild_specs = false',
      '',
      '# Define verify checks that SpecOps runs after a task or after applying a patch.',
      '# A task may only reference verify names defined here. Uncomment and adjust:',
      '#',
      '# [verify.lint]',
      '# command = ["npm", "run", "lint"]',
      '#',
      '# [verify.test]',
      '# command = ["npm", "test"]',
      '',
      '# Automated review agent: runs after verify, before human review. Enabled by',
      '# default. On critical findings it feeds them back to the implementing agent',
      '# and re-runs (up to max_iterations). Set enabled = false to skip it.',
      '# [review]',
      '# enabled = true',
      '# model = ""  # deprecated: use [agents.review] model instead',
      '',
    ].join('\n')
    await atomicWrite(configPath, seedConfig)
    created.push('specops.toml')
  }
  for (const role of ['analysis', 'implementation', 'review'] as const) {
    const promptPath = pathInside(workspace, DEFAULT_AGENT_PROMPT_FILES[role])
    if (await exists(promptPath)) continue
    await atomicWrite(promptPath, `${BUILTIN_AGENT_PROMPTS[role]}\n`)
    created.push(DEFAULT_AGENT_PROMPT_FILES[role])
  }
  const ignorePath = path.join(root, '.gitignore')
  if (!await exists(ignorePath)) {
    await atomicWrite(ignorePath, 'state/\nruns/\n')
    created.push('.specops/.gitignore')
  }
  const overviewPath = path.join(root, 'specs', 'project-overview.md')
  if (!await exists(overviewPath)) {
    const modules = await topLevelModules(workspace)
    const body = modules.length === 0
      ? '# Project overview\n\nNo top-level modules were detected. Replace this draft with project invariants.'
      : `# Project overview\n\nDetected top-level modules:\n\n${modules.map((item) => `- \`${item}/\``).join('\n')}\n\nReview this generated draft before activation.`
    await atomicWrite(overviewPath, serializeDocument({
      frontmatter: {
        schema_version: 1,
        id: 'project-overview',
        kind: 'spec',
        title: 'Project overview',
        status: 'draft',
      },
      body,
    }))
    created.push('.specops/specs/project-overview.md')
  }

  // Seed constitution.md if absent
  const constitutionPath = path.join(root, 'constitution.md')
  if (!await exists(constitutionPath)) {
    await atomicWrite(constitutionPath, CONSTITUTION_SEED)
    created.push('.specops/constitution.md')
  }

  // Migrate legacy archive/ directory if it exists.
  // NOTE: this is a raw `rename` — it does NOT update proposal.md frontmatter
  // `status` to `archived`. Two legacy folders migrated here retain their
  // original `proposed` status as a result. We intentionally don't fix them
  // up here: the migration has already run on every workspace, and re-running
  // would no-op (legacy archive/ is gone). Use `archiveChange` going forward —
  // it writes `status: archived` after the move.
  const legacyArchive = path.join(root, 'archive')
  if (await exists(legacyArchive)) {
    const legacyFiles = await listMarkdownFiles(legacyArchive)
    if (legacyFiles.length > 0) {
      const targetDir = path.join(root, 'changes', 'archive', '_legacy-investigations')
      await mkdir(targetDir, { recursive: true })
      for (const file of legacyFiles) {
        const relative = path.relative(legacyArchive, file)
        const target = path.join(targetDir, relative)
        await mkdir(path.dirname(target), { recursive: true })
        const { rename } = await import('node:fs/promises')
        await rename(file, target)
        created.push(path.relative(workspace, target))
      }
    }
    // Remove the now-empty legacy archive directory
    try { const { rmdir } = await import('node:fs/promises'); await rmdir(legacyArchive) } catch { /* ignore */ }
    created.push('migrated .specops/archive/ → .specops/changes/archive/_legacy-investigations/')
  }

  // Generate skill files into .codebuddy/skills/
  const skillsDir = path.join(workspace, '.codebuddy', 'skills')
  await mkdir(skillsDir, { recursive: true })
  for (const [name, content] of Object.entries(BUILTIN_SKILLS)) {
    const targetPath = path.join(skillsDir, name)
    if (await exists(targetPath) && await readText(targetPath) === content) continue
    await atomicWrite(targetPath, content)
    created.push(`.codebuddy/skills/${name}`)
  }

  return { ok: true, command: 'init', data: { workspace, created }, diagnostics: [] }
}

export interface RegistryEntry {
  id: string
  kind: string
  document_class?: import('./spec.js').DocumentClass
  spec_type?: import('./spec.js').NormativeSpecType
  work_type?: import('./spec.js').WorkType
  title: string
  status: string
  path: string
  verifies: string[]
  paths: string[]
  targets?: string[]
  workflow_profile?: import('./spec.js').WorkType
  files?: Array<{ name: string; path: string }>
}

export interface RegistryState {
  schema_version: 1
  generated_at: string
  documents: RegistryEntry[]
  constitution?: ConstitutionState
}

export async function detectWildSpecFiles(workspace: string): Promise<string[]> {
  const ignored = new Set(['.git', '.specops', '.pnpm-store', 'node_modules', 'target', 'dist', 'build'])
  const names = new Set(['spec.md', 'specification.md', 'requirements.md'])
  const found: string[] = []
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(candidate)
      else if (entry.isFile() && names.has(entry.name.toLowerCase())) found.push(path.relative(workspace, candidate))
    }
  }
  await walk(workspace)
  return found.sort()
}

/** Scan a single change folder and return its metadata + file listing. */
async function scanChangeFolder(folderPath: string, workspace: string): Promise<{ entry: RegistryEntry; files: ChangeFile[] } | null> {
  const proposalPath = path.join(folderPath, 'proposal.md')
  if (!await exists(proposalPath)) return null

  let document: SpecDocument
  try {
    document = parseDocument(await readText(proposalPath), path.relative(workspace, proposalPath))
  } catch {
    return null
  }

  const { frontmatter } = document
  const relativeDir = path.relative(workspace, folderPath)

  // Collect all files in the change folder
  const files: ChangeFile[] = []
  const allMdFiles = await listMarkdownFiles(folderPath)
  for (const file of allMdFiles) {
    files.push({
      name: path.relative(folderPath, file),
      path: path.relative(workspace, file),
    })
  }

  return {
    entry: {
      id: frontmatter.id,
      kind: frontmatter.kind,
      title: frontmatter.title,
      status: frontmatter.status,
      path: relativeDir,
      verifies: frontmatter.verifies ?? [],
      paths: frontmatter.paths ?? [],
    },
    files,
  }
}

export async function scanWorkspace(input: string): Promise<CommandResult<RegistryState>> {
  const workspace = await resolveGitWorkspace(input)
  const root = pathInside(workspace, '.specops')
  const documents: SpecDocument[] = []
  const diagnostics: Diagnostic[] = []

  // Scan specs/ — flat markdown files
  const specsDir = path.join(root, 'specs')
  for (const file of await listMarkdownFiles(specsDir)) {
    const relativePath = path.relative(workspace, file)
    try {
      documents.push(parseDocument(await readText(file), relativePath))
    } catch (error) {
      diagnostics.push({
        code: 'invalid_document',
        message: error instanceof Error ? error.message : String(error),
        path: relativePath,
        severity: 'error',
      })
    }
  }

  // Scan changes/ — folder-based, skip archive/
  const changesDir = path.join(root, 'changes')
  const changeFolders = await listDirectories(changesDir)
  const changeFiles = new Map<string, Array<{ name: string; path: string }>>()
  for (const folderPath of changeFolders) {
    const folderName = path.basename(folderPath)
    if (folderName === 'archive') continue

    const result = await scanChangeFolder(folderPath, workspace)
    if (result === null) {
      diagnostics.push({
        code: 'invalid_change_folder',
        message: `change folder missing proposal.md: ${path.relative(workspace, folderPath)}`,
        path: path.relative(workspace, folderPath),
        severity: 'error',
      })
      continue
    }

    // Also scan for spec delta files within the change folder's specs/ subdirectory
    const changeSpecsDir = path.join(folderPath, 'specs')
    for (const file of await listMarkdownFiles(changeSpecsDir)) {
      const relativePath = path.relative(workspace, file)
      try {
        documents.push(parseDocument(await readText(file), relativePath))
      } catch (error) {
        diagnostics.push({
          code: 'invalid_document',
          message: error instanceof Error ? error.message : String(error),
          path: relativePath,
          severity: 'error',
        })
      }
    }

    // Store files for the frontend
    changeFiles.set(result.entry.path, result.files)

    // Add the change as a synthetic document entry
    documents.push({
      frontmatter: {
        schema_version: 1,
        id: result.entry.id,
        kind: result.entry.kind as import('./spec.js').DocumentKind,
        title: result.entry.title,
        status: result.entry.status as import('./spec.js').DocumentStatus,
        verifies: result.entry.verifies,
        paths: result.entry.paths,
      },
      body: `Change folder: ${result.entry.path}`,
      relativePath: result.entry.path,
    })
  }

  // Parse constitution.md
  const constitutionPath = path.join(root, 'constitution.md')
  let constitution: ConstitutionState | undefined
  if (await exists(constitutionPath)) {
    const body = await readText(constitutionPath)
    constitution = {
      path: '.specops/constitution.md',
      body,
      principles: extractSectionBullets(body, 'Principles'),
      invariants: extractSectionBullets(body, 'Invariants'),
      guardrails: extractSectionBullets(body, 'Guardrails'),
    }
  }

  // Deduplicate by id
  const seen = new Map<string, string>()
  for (const document of documents) {
    const existing = seen.get(document.frontmatter.id)
    if (existing !== undefined) {
      diagnostics.push({
        code: 'duplicate_id',
        message: `duplicate id ${document.frontmatter.id}: ${existing} and ${document.relativePath}`,
        path: document.relativePath,
        severity: 'error',
      })
    } else {
      seen.set(document.frontmatter.id, document.relativePath)
    }
  }

  const state: RegistryState = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    documents: documents.map((document) => ({
      id: document.frontmatter.id,
      kind: document.frontmatter.kind,
      ...(document.frontmatter.document_class === undefined ? {} : { document_class: document.frontmatter.document_class }),
      ...(document.frontmatter.spec_type === undefined ? {} : { spec_type: document.frontmatter.spec_type }),
      ...(document.frontmatter.work_type === undefined ? {} : { work_type: document.frontmatter.work_type }),
      title: document.frontmatter.title,
      status: document.frontmatter.status,
      path: document.relativePath,
      verifies: document.frontmatter.verifies ?? [],
      paths: document.frontmatter.paths ?? [],
      targets: document.frontmatter.targets ?? [],
      ...(document.frontmatter.workflow_profile === undefined ? {} : { workflow_profile: document.frontmatter.workflow_profile }),
      ...(changeFiles.has(document.relativePath) ? { files: changeFiles.get(document.relativePath)! } : {}),
    })),
    ...(constitution !== undefined ? { constitution } : {}),
  }

  // Sort by mtime (most recent first), fall back to alphabetical by id
  const mtimes = new Map<string, number>()
  for (const doc of state.documents) {
    const filePath = pathInside(workspace, doc.path)
    try {
      const info = await stat(filePath)
      mtimes.set(doc.id, info.mtimeMs)
    } catch {
      mtimes.set(doc.id, 0)
    }
  }
  state.documents.sort((a, b) => {
    const aTime = mtimes.get(a.id) ?? 0
    const bTime = mtimes.get(b.id) ?? 0
    if (aTime !== bTime) return bTime - aTime
    return a.id.localeCompare(b.id)
  })

  if (!diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    await atomicWrite(path.join(root, 'state', 'registry.json'), `${JSON.stringify(state, null, 2)}\n`)
    const wild = await detectWildSpecFiles(workspace)
    const links = [
      '# SPEC-LINKS',
      '',
      'Canonical documents:',
      ...state.documents.map((document) => `- [${document.id}](${document.path})`),
      '',
      'Spec-like files outside `.specops/`:',
      ...(wild.length === 0 ? ['- None detected.'] : wild.map((file) => `- \`${file}\``)),
      '',
    ].join('\n')
    await atomicWrite(path.join(root, 'state', 'SPEC-LINKS.md'), links)
  }
  return { ok: diagnostics.length === 0, command: 'scan', data: state, diagnostics }
}

/** Archive a completed change: move its folder to changes/archive/{date}-{id}/ */
/**
 * Mark the change proposal with the given id as `completed`. Scans
 * `.specops/changes/` (non-archived) for a folder whose `proposal.md`
 * frontmatter `id` matches, sets `status: completed`, and atomically writes
 * the file back. Silent no-op when no matching folder is found — callers
 * (apply paths) treat this as best-effort and must not throw on a missing
 * proposal (e.g. quick-runs, or the user already archived it).
 *
 * Note: this intentionally does NOT scan `changes/archive/` — once a change
 * is archived its status is already `archived` and should not regress.
 */
export async function markChangeCompleted(workspaceInput: string, changeId: string): Promise<void> {
  const workspace = await resolveGitWorkspace(workspaceInput)
  const changesDir = pathInside(workspace, '.specops', 'changes')
  const folders = await listDirectories(changesDir)
  for (const folderPath of folders) {
    if (path.basename(folderPath) === 'archive') continue
    const proposalPath = path.join(folderPath, 'proposal.md')
    if (!await exists(proposalPath)) continue
    let doc: SpecDocument
    try {
      doc = parseDocument(await readText(proposalPath), path.relative(workspace, proposalPath))
    } catch {
      continue
    }
    if (doc.frontmatter.id !== changeId) continue
    // Already completed — don't touch (avoids a redundant write / mtime bump).
    if (doc.frontmatter.status === 'completed') return
    doc.frontmatter.status = 'completed'
    await atomicWrite(proposalPath, serializeDocument(doc))
    return
  }
  // No matching folder found — silent no-op (best-effort).
}

export async function archiveChange(input: string, changeId: string): Promise<CommandResult<{ from: string; to: string }>> {
  const workspace = await resolveGitWorkspace(input)
  const root = pathInside(workspace, '.specops')
  const changesDir = path.join(root, 'changes')

  // Find the change folder by scanning
  const folders = await listDirectories(changesDir)
  let sourceFolder: string | null = null
  let sourceStatus: string | null = null
  for (const folderPath of folders) {
    const folderName = path.basename(folderPath)
    if (folderName === 'archive') continue
    const proposalPath = path.join(folderPath, 'proposal.md')
    if (!await exists(proposalPath)) continue
    try {
      const doc = parseDocument(await readText(proposalPath), path.relative(workspace, proposalPath))
      if (doc.frontmatter.id === changeId) {
        sourceFolder = folderPath
        sourceStatus = doc.frontmatter.status
        break
      }
    } catch { continue }
  }

  if (sourceFolder === null) {
    return { ok: false, command: 'archive', diagnostics: [{ code: 'change_not_found', message: `change not found: ${changeId}`, severity: 'error' }] }
  }

  const diagnostics: Diagnostic[] = []
  // Pre-condition: the skill doc says "should be in `completed` status before
  // archiving". We deliberately do NOT hard-block `proposed` — 17 historical
  // proposals never went through the auto `proposed → completed` transition
  // (the flow being fixed by this change) and blocking them would strand
  // already-merged work. Emit a warning instead so the user knows.
  if (sourceStatus !== null && sourceStatus !== 'completed' && sourceStatus !== 'archived') {
    diagnostics.push({
      code: 'archive_not_completed',
      message: `change ${changeId} is in '${sourceStatus}' status, expected 'completed'. Archiving anyway — the proposal may not have been auto-marked completed by a Run apply.`,
      severity: 'warning',
    })
  }

  const date = new Date().toISOString().slice(0, 10)
  const folderName = path.basename(sourceFolder)
  const targetDir = path.join(root, 'changes', 'archive', `${date}-${folderName}`)
  if (await exists(targetDir)) {
    return { ok: false, command: 'archive', diagnostics: [{ code: 'archive_exists', message: `archive target already exists: ${path.relative(workspace, targetDir)}`, severity: 'error' }] }
  }

  await mkdir(path.dirname(targetDir), { recursive: true })
  const { rename } = await import('node:fs/promises')
  await rename(sourceFolder, targetDir)

  // Update proposal.md status to 'archived'
  const archivedProposal = path.join(targetDir, 'proposal.md')
  const doc = parseDocument(await readText(archivedProposal), path.relative(workspace, archivedProposal))
  doc.frontmatter.status = 'archived'
  await atomicWrite(archivedProposal, serializeDocument(doc))

  return {
    ok: true,
    command: 'archive',
    data: {
      from: path.relative(workspace, sourceFolder),
      to: path.relative(workspace, targetDir),
    },
    diagnostics,
  }
}
