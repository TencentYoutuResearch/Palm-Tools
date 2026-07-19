import {
  ExecutionOperationError,
  type ExecutionCapability,
  type ExecutionProbeResult,
  type ExecutionResponse,
} from './types.js'

export type ExecutionOperation = 'start' | 'load' | 'prompt' | 'cancel' | 'setMode'
export type StructuredWorkflow = 'clarify' | 'pre_plan'

export const WORKFLOW_REQUIRED_CAPABILITIES: Record<StructuredWorkflow, readonly ExecutionCapability[]> = {
  // Plan review is a SpecOps-owned durable interaction. A backend only needs
  // structured questions; it may submit the plan through a native plan event
  // or the transport-independent specops:plan envelope.
  clarify: ['conversation.ask'],
  pre_plan: ['conversation.ask'],
}

const REQUIRED_CAPABILITY: Record<ExecutionOperation, ExecutionCapability> = {
  start: 'session.create',
  load: 'session.resume',
  prompt: 'session.prompt',
  cancel: 'session.interrupt',
  setMode: 'session.mode',
}

const RESPONSE_CAPABILITY: Record<ExecutionResponse['kind'], ExecutionCapability> = {
  permission: 'conversation.permission',
  questions: 'conversation.ask',
  plan: 'conversation.plan',
}

export function supportsCapability(
  probe: Pick<ExecutionProbeResult, 'capabilities'>,
  capability: ExecutionCapability,
): boolean {
  return probe.capabilities.includes(capability)
}

export function capabilityForOperation(operation: ExecutionOperation): ExecutionCapability {
  return REQUIRED_CAPABILITY[operation]
}

export function effectiveBackendCapabilities(
  declaredCapabilities: readonly string[],
  transportCapabilities: readonly ExecutionCapability[],
): ExecutionCapability[] {
  const supported = new Set<ExecutionCapability>(transportCapabilities)
  return [...new Set(declaredCapabilities)]
    .filter((capability): capability is ExecutionCapability => supported.has(capability as ExecutionCapability))
}

export function missingWorkflowCapabilities(
  workflow: StructuredWorkflow,
  declaredCapabilities: readonly string[],
  transportCapabilities: readonly ExecutionCapability[],
): ExecutionCapability[] {
  const effective = new Set(effectiveBackendCapabilities(declaredCapabilities, transportCapabilities))
  return WORKFLOW_REQUIRED_CAPABILITIES[workflow].filter((capability) => !effective.has(capability))
}

export function capabilityForResponse(response: Pick<ExecutionResponse, 'kind'>): ExecutionCapability {
  return RESPONSE_CAPABILITY[response.kind]
}

export function requireCapability(
  probe: Pick<ExecutionProbeResult, 'transport' | 'capabilities'>,
  capability: ExecutionCapability,
): void {
  if (supportsCapability(probe, capability)) return
  throw new ExecutionOperationError(
    'capability_not_supported',
    `${probe.transport} does not support required execution capability: ${capability}`,
  )
}

export function requireOperationCapability(
  probe: Pick<ExecutionProbeResult, 'transport' | 'capabilities'>,
  operation: ExecutionOperation,
): void {
  requireCapability(probe, capabilityForOperation(operation))
}
