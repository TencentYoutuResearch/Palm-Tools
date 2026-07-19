import {
  readRun,
  writeRun,
} from '../domain/run.js'
import type {
  AgentPurpose,
  ExecutionIdentity,
  ExecutionTransport,
} from '../domain/session.js'
import {
  ExecutionProjector,
  type ExecutionProjectionBinding,
  type ExecutionProjectorOptions,
} from './projector.js'
import type {
  ExecutionCancelInput,
  ExecutionEventListener,
  ExecutionId,
  ExecutionPromptInput,
  ExecutionRequestOutcome,
  ExecutionResponse,
  ExecutionTurnResult,
  ManagedExecution,
} from './types.js'
import type {
  ExecutionManagerLoadInput,
  ExecutionManagerStartInput,
} from './manager.js'

export interface ExecutionRuntimeManager {
  events(listener: ExecutionEventListener): () => void
  get(executionId: ExecutionId): ManagedExecution | undefined
  start(input: ExecutionManagerStartInput): Promise<ManagedExecution>
  load(input: ExecutionManagerLoadInput): Promise<ManagedExecution>
  prompt(executionId: ExecutionId, input: ExecutionPromptInput): Promise<ExecutionRequestOutcome<ExecutionTurnResult>>
  respond(executionId: ExecutionId, input: ExecutionResponse): Promise<ExecutionRequestOutcome<void>>
  cancel(executionId: ExecutionId, input: ExecutionCancelInput): Promise<ExecutionRequestOutcome<void>>
  close(executionId: ExecutionId): Promise<void>
  shutdown(): Promise<void>
}

export interface ExecutionRuntimeBindingInput {
  workspace: string
  sessionId: string
  purpose: AgentPurpose
  runId?: string | null
}

export interface ExecutionRuntimeStartInput extends ExecutionRuntimeBindingInput {
  requestId?: string
  backendKey: string
  cwd: string
  model?: string
  mode?: string
  metadata?: Readonly<Record<string, unknown>>
}

export interface ExecutionRuntimeLoadInput extends ExecutionRuntimeStartInput {
  executionId: ExecutionId
  nativeSessionId: string
}

export interface ExecutionRuntimeOptions {
  projector?: ExecutionProjector
  projectorOptions?: ExecutionProjectorOptions
}

/** Narrow domain API used by server/workflow code without exposing transports. */
export class ExecutionRuntime {
  private readonly manager: ExecutionRuntimeManager
  private readonly projector: ExecutionProjector
  private readonly sessionExecutions = new Map<string, ExecutionId>()
  private shutdownPromise: Promise<void> | undefined

  constructor(manager: ExecutionRuntimeManager, options: ExecutionRuntimeOptions = {}) {
    this.manager = manager
    this.projector = options.projector ?? new ExecutionProjector(manager, {
      ...options.projectorOptions,
      persistRunExecution: options.projectorOptions?.persistRunExecution ?? persistBoundRunExecution,
    })
  }

  async start(input: ExecutionRuntimeStartInput): Promise<ExecutionIdentity> {
    const managed = await this.manager.start(managerStartInput(input))
    return this.attach(input, managed)
  }

  async load(input: ExecutionRuntimeLoadInput): Promise<ExecutionIdentity> {
    const managed = await this.manager.load({
      ...managerStartInput(input),
      executionId: input.executionId,
      nativeSessionId: input.nativeSessionId,
    })
    return this.attach(input, managed)
  }

  prompt(
    executionOrSessionId: ExecutionId,
    input: ExecutionPromptInput,
  ): Promise<ExecutionRequestOutcome<ExecutionTurnResult>> {
    const executionId = this.resolveExecutionId(executionOrSessionId)
    const operation = this.manager.prompt(executionId, input)
    return operation.then(async (outcome) => {
      await this.projector.flush(executionId)
      return outcome
    })
  }

  async respond(
    executionOrSessionId: ExecutionId,
    input: ExecutionResponse,
  ): Promise<ExecutionRequestOutcome<void>> {
    return this.manager.respond(this.resolveExecutionId(executionOrSessionId), input)
  }

  cancel(
    executionOrSessionId: ExecutionId,
    input: ExecutionCancelInput,
  ): Promise<ExecutionRequestOutcome<void>> {
    return this.manager.cancel(this.resolveExecutionId(executionOrSessionId), input)
  }

  async close(executionOrSessionId: ExecutionId): Promise<void> {
    const executionId = this.resolveExecutionId(executionOrSessionId)
    await this.manager.close(executionId)
    await this.projector.closeBinding(executionId)
    this.removeBinding(executionId)
  }

  get(executionOrSessionId: ExecutionId): ExecutionIdentity | undefined {
    const managed = this.manager.get(this.resolveExecutionId(executionOrSessionId))
    return managed === undefined ? undefined : executionIdentity(managed)
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise
    this.shutdownPromise = (async () => {
      await this.manager.shutdown()
      await this.projector.shutdown()
      this.sessionExecutions.clear()
    })()
    return this.shutdownPromise
  }

  private async attach(
    input: ExecutionRuntimeBindingInput & { model?: string },
    managed: ManagedExecution,
  ): Promise<ExecutionIdentity> {
    const identity = executionIdentity(managed)
    const binding: ExecutionProjectionBinding = {
      workspace: input.workspace,
      sessionId: input.sessionId,
      identity,
      purpose: input.purpose,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
    }
    const previousExecutionId = this.sessionExecutions.get(input.sessionId)
    try {
      if (previousExecutionId !== undefined && previousExecutionId !== identity.execution_id) {
        await this.manager.close(previousExecutionId)
        await this.projector.closeBinding(previousExecutionId, 'replaced')
        this.sessionExecutions.delete(input.sessionId)
      }
      await this.projector.bind(binding)
    } catch (error) {
      await this.manager.close(identity.execution_id).catch(() => undefined)
      throw error
    }
    for (const [sessionId, executionId] of this.sessionExecutions) {
      if (executionId === identity.execution_id || sessionId === input.sessionId) this.sessionExecutions.delete(sessionId)
    }
    this.sessionExecutions.set(input.sessionId, identity.execution_id)
    return identity
  }

  private resolveExecutionId(executionOrSessionId: string): ExecutionId {
    return this.sessionExecutions.get(executionOrSessionId) ?? executionOrSessionId
  }

  private removeBinding(executionId: ExecutionId): void {
    for (const [sessionId, current] of this.sessionExecutions) {
      if (current === executionId) this.sessionExecutions.delete(sessionId)
    }
  }
}

function managerStartInput(input: ExecutionRuntimeStartInput): ExecutionManagerStartInput {
  return {
    backendKey: input.backendKey,
    cwd: input.cwd,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  }
}

export function executionIdentity(execution: ManagedExecution): ExecutionIdentity {
  return {
    execution_id: execution.executionId,
    transport: domainTransport(execution.transport),
    backend_key: execution.backendKey,
    native_session_id: execution.nativeSessionId,
    process_generation: execution.processGeneration,
  }
}

function domainTransport(transport: string): ExecutionTransport {
  switch (transport) {
    case 'codebuddy-acp': return 'codebuddy_acp'
    case 'codex-app-server': return 'codex_app_server'
    case 'claude-stream-json': return 'claude_stream_json'
    case 'legacy-kode-pty': return 'legacy_kode_pty'
    default: throw new Error(`Unsupported domain execution transport: ${transport}`)
  }
}

/** Default Run attachment persistence; callers can replace it through projectorOptions. */
export async function persistBoundRunExecution(
  binding: ExecutionProjectionBinding,
  identity: ExecutionIdentity | null,
): Promise<void> {
  if (binding.runId == null) return
  const run = await readRun(binding.workspace, binding.runId)
  if (identity === null) {
    if (run.execution?.execution_id !== binding.identity.execution_id
      || run.execution.process_generation !== binding.identity.process_generation) return
  }
  run.execution = identity
  await writeRun(run)
}
