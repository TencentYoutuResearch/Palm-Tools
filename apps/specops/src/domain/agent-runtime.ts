import { createHash } from 'node:crypto'

import type { RunRecord } from './run.js'
import { exists, pathInside, readText } from '../store/workspace.js'

export type AgentRole = 'clarifier' | 'architect' | 'planner' | 'builder' | 'test_designer' | 'verifier' | 'reviewer' | 'repair' | 'drift'

export interface AgentRoleProfile {
  role: AgentRole
  input_artifacts: string[]
  output_artifacts: string[]
  capabilities: string[]
  write_scopes: string[]
  network: 'restricted' | 'disabled'
  secrets: 'isolated'
  independent_from?: AgentRole[]
}

export const AGENT_ROLES: Record<AgentRole, AgentRoleProfile> = {
  clarifier: { role: 'clarifier', input_artifacts: ['note', 'spec'], output_artifacts: ['decision', 'spec'], capabilities: ['conversation.ask'], write_scopes: ['.specops/changes/**'], network: 'disabled', secrets: 'isolated' },
  architect: { role: 'architect', input_artifacts: ['spec', 'impact'], output_artifacts: ['design'], capabilities: ['output.structured'], write_scopes: ['.specops/changes/**'], network: 'disabled', secrets: 'isolated' },
  planner: { role: 'planner', input_artifacts: ['spec', 'design'], output_artifacts: ['plan'], capabilities: ['conversation.plan'], write_scopes: ['.specops/changes/**'], network: 'disabled', secrets: 'isolated' },
  builder: { role: 'builder', input_artifacts: ['spec', 'plan', 'task'], output_artifacts: ['patch'], capabilities: ['session.create', 'sandbox.policy'], write_scopes: ['src/**', 'apps/**', 'crates/**', 'tests/unit/**'], network: 'restricted', secrets: 'isolated' },
  test_designer: { role: 'test_designer', input_artifacts: ['spec', 'completion_contract'], output_artifacts: ['test'], capabilities: ['output.structured'], write_scopes: ['tests/acceptance/generated/**'], network: 'disabled', secrets: 'isolated', independent_from: ['builder'] },
  verifier: { role: 'verifier', input_artifacts: ['patch', 'test'], output_artifacts: ['verification', 'evidence'], capabilities: ['sandbox.policy'], write_scopes: [], network: 'disabled', secrets: 'isolated', independent_from: ['builder'] },
  reviewer: { role: 'reviewer', input_artifacts: ['spec', 'patch', 'verification'], output_artifacts: ['review'], capabilities: ['output.structured'], write_scopes: [], network: 'disabled', secrets: 'isolated', independent_from: ['builder'] },
  repair: { role: 'repair', input_artifacts: ['patch', 'verification', 'review'], output_artifacts: ['patch'], capabilities: ['session.resume', 'sandbox.policy'], write_scopes: ['src/**', 'apps/**', 'crates/**', 'tests/unit/**'], network: 'restricted', secrets: 'isolated' },
  drift: { role: 'drift', input_artifacts: ['spec_graph', 'product_graph', 'evidence'], output_artifacts: ['drift_report', 'repair_task'], capabilities: ['output.structured'], write_scopes: ['.specops/state/drift/**'], network: 'disabled', secrets: 'isolated' },
}

export interface CompiledAgentContext {
  role: AgentRole
  task_id: string
  content: string
  hash: string
  included_paths: string[]
  excluded: string[]
}

async function optionalFile(root: string, relative: string): Promise<string | null> {
  const file = pathInside(root, relative)
  return await exists(file) ? readText(file) : null
}

export async function compileAgentContext(run: RunRecord, role: AgentRole): Promise<CompiledAgentContext> {
  const task = run.tasks[run.current_task]
  if (task === undefined) throw new Error(`Run ${run.run_id} has no current task`)
  const profile = AGENT_ROLES[role]
  const includedPaths: string[] = []
  const sections: string[] = []
  if (run.change_id !== null) {
    for (const name of ['proposal.md', 'design.md', 'tasks.md']) {
      const relative = `.specops/changes/${run.change_id}/${name}`
      const content = await optionalFile(run.worktree_path, relative)
      if (content === null) continue
      includedPaths.push(relative)
      sections.push(`## ${name}\n\n${content.slice(0, 16_000)}`)
    }
  }
  const constitution = await optionalFile(run.worktree_path, '.specops/constitution.md')
  if (constitution !== null) { includedPaths.push('.specops/constitution.md'); sections.push(`## Project constitution\n\n${constitution.slice(0, 12_000)}`) }
  const content = [
    `# Agent assignment`, `Role: ${role}`, `Task: ${task.id} — ${task.title}`,
    `Allowed write scopes: ${profile.write_scopes.join(', ') || 'none (read-only)'}`,
    `Network: ${profile.network}`, `Secrets: ${profile.secrets}`,
    `Iteration budget: ${run.iteration}/${run.max_iterations}`,
    '', '## Task instructions', '', task.prompt, '', ...sections,
    '## Output contract', '', `Produce only: ${profile.output_artifacts.join(', ')}.`,
    'Do not modify Harness-owned contracts, policies, golden tests, or generated acceptance tests.',
  ].join('\n')
  return {
    role, task_id: task.id, content, hash: createHash('sha256').update(content).digest('hex'), included_paths: includedPaths,
    excluded: ['unrelated SpecOps documents', 'unrelated transcripts', 'secrets', 'Harness-owned writable context'],
  }
}
