import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { SpecOpsError } from '../core/errors.js'
import { pathInside } from '../store/workspace.js'
import type { ReproducibleEnvironment } from './environment.js'

export const KNOWN_CAPABILITIES = [
  'session.create',
  'session.resume',
  'session.interrupt',
  'conversation.ask',
  'conversation.plan',
  'events.tools',
  'output.structured',
  'sandbox.policy',
  'model.select',
  'usage.metrics',
] as const

export type KnownCapability = typeof KNOWN_CAPABILITIES[number]
export type PluginKind = 'backend' | 'source' | 'verifier' | 'workflow' | 'policy'
export type WorkflowKind = 'feature' | 'bug' | 'refactor' | 'investigation' | 'docs'
export type WorkflowStage =
  | 'clarify'
  | 'reproduce'
  | 'impact'
  | 'plan'
  | 'build'
  | 'verify'
  | 'review'
  | 'apply'
  | 'decision'
  | 'drift'

export interface PluginManifest {
  schema_version: 1
  id: string
  version: string
  kind: PluginKind
  capabilities: string[]
}

export interface AgentBackendProfile {
  plugin: string
  capabilities: string[]
}

export interface WorkflowProfile {
  stages: WorkflowStage[]
}

export interface RunManifest {
  schema_version: 1
  run_id: string
  created_at: string
  workflow: { kind: WorkflowKind; stages: WorkflowStage[] }
  project_profiles: string[]
  backend: { key: string; plugin: string; capabilities: string[] }
  scope: { base_commit: string; change_id: string | null; task_ids: string[] }
  verification: { required: string[] }
  limits: { max_iterations: number }
  environment: ReproducibleEnvironment
}

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/
const PLUGIN_KINDS = new Set<PluginKind>(['backend', 'source', 'verifier', 'workflow', 'policy'])
const WORKFLOW_STAGES = new Set<WorkflowStage>([
  'clarify', 'reproduce', 'impact', 'plan', 'build', 'verify', 'review', 'apply', 'decision', 'drift',
])

export const DEFAULT_WORKFLOWS: Record<WorkflowKind, WorkflowProfile> = {
  feature: { stages: ['clarify', 'impact', 'plan', 'build', 'verify', 'review', 'apply', 'drift'] },
  bug: { stages: ['reproduce', 'impact', 'plan', 'build', 'verify', 'review', 'apply', 'drift'] },
  refactor: { stages: ['impact', 'plan', 'build', 'verify', 'review', 'apply', 'drift'] },
  investigation: { stages: ['clarify', 'impact', 'plan', 'decision'] },
  docs: { stages: ['impact', 'plan', 'build', 'verify', 'review', 'apply'] },
}

export function validatePluginManifest(value: unknown): PluginManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpecOpsError('invalid_plugin_manifest', 'plugin manifest must be an object')
  }
  const raw = value as Record<string, unknown>
  if (raw.schema_version !== 1) throw new SpecOpsError('invalid_plugin_manifest', 'plugin schema_version must be 1')
  if (typeof raw.id !== 'string' || !PLUGIN_ID_PATTERN.test(raw.id)) {
    throw new SpecOpsError('invalid_plugin_manifest', 'plugin id has an invalid format')
  }
  if (typeof raw.version !== 'string' || !VERSION_PATTERN.test(raw.version)) {
    throw new SpecOpsError('invalid_plugin_manifest', 'plugin version must use semantic versioning')
  }
  if (typeof raw.kind !== 'string' || !PLUGIN_KINDS.has(raw.kind as PluginKind)) {
    throw new SpecOpsError('invalid_plugin_manifest', 'plugin kind is invalid')
  }
  const capabilities = stringList(raw.capabilities, 'plugin capabilities')
  return {
    schema_version: 1,
    id: raw.id,
    version: raw.version,
    kind: raw.kind as PluginKind,
    capabilities,
  }
}

export function parseWorkflowStages(value: unknown, field: string): WorkflowStage[] {
  const stages = stringList(value, field)
  for (const stage of stages) {
    if (!WORKFLOW_STAGES.has(stage as WorkflowStage)) {
      throw new SpecOpsError('invalid_config', `${field} contains unknown stage: ${stage}`)
    }
  }
  if (new Set(stages).size !== stages.length) {
    throw new SpecOpsError('invalid_config', `${field} contains duplicate stages`)
  }
  return stages as WorkflowStage[]
}

export function builtinBackendProfile(backendKey: string): AgentBackendProfile {
  const base = ['session.create', 'session.interrupt', 'sandbox.policy', 'model.select']
  if (backendKey === 'codebuddy' || backendKey === 'claude' || backendKey === 'claude-internal') {
    return {
      plugin: 'builtin.kode',
      capabilities: [...base, 'session.resume', 'conversation.ask', 'conversation.plan', 'events.tools'],
    }
  }
  if (backendKey === 'codex') {
    return {
      plugin: 'builtin.kode',
      capabilities: [...base, 'session.resume', 'conversation.ask', 'events.tools'],
    }
  }
  return { plugin: 'builtin.kode', capabilities: base }
}

export async function loadPluginManifests(workspace: string): Promise<PluginManifest[]> {
  const directory = pathInside(workspace, '.specops', 'plugins')
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const manifests: PluginManifest[] = []
  const ids = new Set<string>()
  for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
    const file = path.join(directory, name)
    if ((await lstat(file)).isSymbolicLink()) {
      throw new SpecOpsError('invalid_plugin_manifest', `plugin manifest cannot be a symlink: ${name}`)
    }
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      throw new SpecOpsError('invalid_plugin_manifest', `${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const manifest = validatePluginManifest(raw)
    if (ids.has(manifest.id)) {
      throw new SpecOpsError('duplicate_plugin', `duplicate plugin id: ${manifest.id}`)
    }
    ids.add(manifest.id)
    manifests.push(manifest)
  }
  return manifests
}

export async function resolveAgentBackendProfile(
  workspace: string,
  backendKey: string,
  configured?: AgentBackendProfile,
): Promise<AgentBackendProfile> {
  const profile = configured ?? builtinBackendProfile(backendKey)
  if (profile.plugin === 'builtin.kode') return profile
  const manifest = (await loadPluginManifests(workspace)).find((item) => item.id === profile.plugin)
  if (manifest === undefined) {
    throw new SpecOpsError('plugin_not_found', `backend ${backendKey} references missing plugin: ${profile.plugin}`)
  }
  if (manifest.kind !== 'backend') {
    throw new SpecOpsError('plugin_kind_mismatch', `plugin ${manifest.id} is ${manifest.kind}, expected backend`)
  }
  const unsupported = profile.capabilities.filter((capability) => !manifest.capabilities.includes(capability))
  if (unsupported.length > 0) {
    throw new SpecOpsError(
      'plugin_capability_mismatch',
      `backend ${backendKey} declares capabilities not provided by ${manifest.id}: ${unsupported.join(', ')}`,
    )
  }
  return profile
}

export function workflowKindForDocumentKind(kind: string | undefined): WorkflowKind {
  if (kind === 'bug') return 'bug'
  if (kind === 'refactor') return 'refactor'
  if (kind === 'investigation') return 'investigation'
  if (kind === 'spec') throw new SpecOpsError('workflow_not_applicable', 'normative specs do not have an implementation workflow')
  return 'feature'
}

export function workflowKindForWorkType(workType: string | undefined): WorkflowKind {
  if (workType === 'bugfix') return 'bug'
  if (workType === 'refactor' || workType === 'investigation' || workType === 'docs' || workType === 'feature') return workType
  return 'feature'
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new SpecOpsError('invalid_config', `${field} must be an array of non-empty strings`)
  }
  return value.map((item) => (item as string).trim())
}
