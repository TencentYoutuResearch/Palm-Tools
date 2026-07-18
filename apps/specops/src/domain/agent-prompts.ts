import clarifyPrompt from '../prompts/agents/clarify.md' with { type: 'text' }
import implementationPrompt from '../prompts/agents/implementation.md' with { type: 'text' }
import reviewPrompt from '../prompts/agents/review.md' with { type: 'text' }

import type { SpecOpsConfig } from './config.js'
import { exists, pathInside, readText } from '../store/workspace.js'
import { SpecOpsError } from '../core/errors.js'

export type OperationalAgentRole = 'analysis' | 'implementation' | 'review'

export interface ResolvedAgentPrompt {
  content: string
  source: string
  builtin: boolean
}

export const BUILTIN_AGENT_PROMPTS: Record<OperationalAgentRole, string> = {
  analysis: clarifyPrompt.trim(),
  implementation: implementationPrompt.trim(),
  review: reviewPrompt.trim(),
}

export const DEFAULT_AGENT_PROMPT_FILES: Record<OperationalAgentRole, string> = {
  analysis: '.specops/agents/clarify.md',
  implementation: '.specops/agents/implementation.md',
  review: '.specops/agents/review.md',
}

export async function resolveAgentPrompt(
  workspace: string,
  config: SpecOpsConfig,
  role: OperationalAgentRole,
): Promise<ResolvedAgentPrompt> {
  const promptFile = config.agents[role].prompt_file ?? config.agents.default.prompt_file
  if (promptFile === undefined) {
    return { content: BUILTIN_AGENT_PROMPTS[role], source: `builtin:${role}`, builtin: true }
  }
  const file = pathInside(workspace, promptFile)
  if (!await exists(file)) {
    throw new SpecOpsError('agent_prompt_missing', `agent prompt file not found: ${promptFile}`)
  }
  const content = (await readText(file)).trim()
  if (content === '') throw new SpecOpsError('agent_prompt_empty', `agent prompt file is empty: ${promptFile}`)
  return { content, source: promptFile, builtin: false }
}

export function composeRolePrompt(rolePrompt: string, assignment: string): string {
  return `${rolePrompt.trim()}\n\n---\n\n# Current assignment\n\n${assignment.trim()}`
}
