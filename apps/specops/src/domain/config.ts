import { parse as parseToml } from 'smol-toml'

import { SpecOpsError } from '../core/errors.js'
import { exists, pathInside, readText } from '../store/workspace.js'
import {
  builtinBackendProfile,
  DEFAULT_WORKFLOWS,
  parseWorkflowStages,
  type AgentBackendProfile,
  type WorkflowKind,
  type WorkflowProfile,
} from './harness.js'

export interface VerifyConfig {
  command: string[]
  cwd?: string
  timeout_ms: number
  output_limit_bytes: number
}

export interface GateSuppressConfig {
  suppress_codes: string[]
  suppress_commit_types: string[]
}

export interface ReviewConfig {
  /** When true, an automated review agent runs after verify, before human review. */
  enabled: boolean
  /** Optional model override for the review agent; defaults to the run's backend default. */
  model?: string
}

export interface SpecOpsConfig {
  schema_version: 1
  project: { name: string; profiles: string[] }
  gate: { strict_wild_specs: boolean; suppress: GateSuppressConfig }
  verify: Record<string, VerifyConfig>
  review: ReviewConfig
  workflows: Record<WorkflowKind, WorkflowProfile>
  agent_backends: Record<string, AgentBackendProfile>
}

const WORKFLOW_KINDS: WorkflowKind[] = ['feature', 'bug', 'refactor', 'investigation', 'docs']

function integer(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new SpecOpsError('invalid_config', `${field} must be a positive integer`)
  }
  return Number(value)
}

export async function loadConfig(workspace: string): Promise<SpecOpsConfig> {
  const configPath = pathInside(workspace, 'specops.toml')
  if (!await exists(configPath)) {
    throw new SpecOpsError('config_missing', `specops.toml not found in ${workspace}`)
  }
  let raw: Record<string, unknown>
  try {
    raw = parseToml(await readText(configPath)) as Record<string, unknown>
  } catch (error) {
    throw new SpecOpsError('invalid_config', error instanceof Error ? error.message : String(error))
  }
  if (raw.schema_version !== 1) throw new SpecOpsError('invalid_config', 'schema_version must be 1')
  const project = raw.project as Record<string, unknown> | undefined
  if (typeof project?.name !== 'string' || project.name.trim() === '') {
    throw new SpecOpsError('invalid_config', 'project.name must be a non-empty string')
  }
  const gate = raw.gate as Record<string, unknown> | undefined
  const profiles = project.profiles === undefined ? [] : stringArray(project.profiles, 'project.profiles')
  const verifyRaw = (raw.verify ?? {}) as Record<string, unknown>
  const verify: Record<string, VerifyConfig> = {}
  for (const [name, value] of Object.entries(verifyRaw)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new SpecOpsError('invalid_config', `verify.${name} must be a table`)
    }
    const entry = value as Record<string, unknown>
    if (!Array.isArray(entry.command) || entry.command.length === 0 || entry.command.some((part) => typeof part !== 'string')) {
      throw new SpecOpsError('invalid_config', `verify.${name}.command must be a non-empty string array`)
    }
    if (entry.cwd !== undefined && typeof entry.cwd !== 'string') {
      throw new SpecOpsError('invalid_config', `verify.${name}.cwd must be a string`)
    }
    verify[name] = {
      command: entry.command as string[],
      ...(entry.cwd === undefined ? {} : { cwd: entry.cwd as string }),
      timeout_ms: integer(entry.timeout_ms, 120_000, `verify.${name}.timeout_ms`),
      output_limit_bytes: integer(entry.output_limit_bytes, 1_048_576, `verify.${name}.output_limit_bytes`),
    }
  }
  const gateSuppress = (gate?.suppress ?? {}) as Record<string, unknown>
  const reviewRaw = (raw.review ?? {}) as Record<string, unknown>
  if (reviewRaw.model !== undefined && typeof reviewRaw.model !== 'string') {
    throw new SpecOpsError('invalid_config', 'review.model must be a string')
  }
  if (reviewRaw.enabled !== undefined && typeof reviewRaw.enabled !== 'boolean') {
    throw new SpecOpsError('invalid_config', 'review.enabled must be a boolean')
  }
  const review: ReviewConfig = {
    // Auto-review defaults ON so runs get spec-compliance/code-quality checks
    // without per-project opt-in; set `[review] enabled = false` to disable.
    enabled: reviewRaw.enabled === undefined ? true : reviewRaw.enabled === true,
    ...(typeof reviewRaw.model === 'string' && reviewRaw.model.trim() !== '' ? { model: reviewRaw.model.trim() } : {}),
  }
  const workflows = structuredClone(DEFAULT_WORKFLOWS)
  const workflowRaw = (raw.workflow ?? {}) as Record<string, unknown>
  for (const kind of WORKFLOW_KINDS) {
    const value = workflowRaw[kind]
    if (value === undefined) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new SpecOpsError('invalid_config', `workflow.${kind} must be a table`)
    }
    const stages = (value as Record<string, unknown>).stages
    workflows[kind] = { stages: parseWorkflowStages(stages, `workflow.${kind}.stages`) }
  }
  const backendRaw = (raw.agent_backends ?? {}) as Record<string, unknown>
  const agentBackends: Record<string, AgentBackendProfile> = {}
  for (const [key, value] of Object.entries(backendRaw)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new SpecOpsError('invalid_config', `agent_backends.${key} must be a table`)
    }
    const entry = value as Record<string, unknown>
    const fallback = builtinBackendProfile(key)
    if (entry.plugin !== undefined && (typeof entry.plugin !== 'string' || entry.plugin.trim() === '')) {
      throw new SpecOpsError('invalid_config', `agent_backends.${key}.plugin must be a non-empty string`)
    }
    agentBackends[key] = {
      plugin: typeof entry.plugin === 'string' ? entry.plugin.trim() : fallback.plugin,
      capabilities: entry.capabilities === undefined
        ? fallback.capabilities
        : stringArray(entry.capabilities, `agent_backends.${key}.capabilities`),
    }
  }
  return {
    schema_version: 1,
    project: { name: project.name.trim(), profiles },
    gate: {
      strict_wild_specs: gate?.strict_wild_specs === true,
      suppress: {
        suppress_codes: Array.isArray(gateSuppress.suppress_codes) ? gateSuppress.suppress_codes.filter((c) => typeof c === 'string') : [],
        suppress_commit_types: Array.isArray(gateSuppress.suppress_commit_types) ? gateSuppress.suppress_commit_types.filter((c) => typeof c === 'string') : [],
      },
    },
    verify,
    review,
    workflows,
    agent_backends: agentBackends,
  }
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new SpecOpsError('invalid_config', `${field} must be an array of non-empty strings`)
  }
  return value.map((item) => (item as string).trim())
}
