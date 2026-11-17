import { isDeepStrictEqual } from 'node:util'
/** Ordinary session model changes, never workflow/managed routing. */
import { profileRoute } from './agent-profiles.js'
import { selectModelPlan } from './model-selection.js'

export async function switchSessionModel(ctx, sessionId, input, { signal, beforeSelect } = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('Session identity required')
  if (typeof input?.model !== 'string' || !input.model.trim() || input.model.length > 256) throw new Error('Explicit model required')
  const service = name => ctx.get?.(name) ?? ctx[name]
  const runtime = service('kodeAgents'), controller = service('sessionController')
  if (!runtime || !controller) throw new Error('Session runtime unavailable')
  const binding = runtime.profiles.binding(sessionId)
  if (!binding?.profile) throw new Error('Session Agent configuration unavailable')
  if (binding.managedOperation || binding.managedAssignment || binding.managedCoordinator || binding.managedBuilder) throw new Error('Managed sessions use their workflow model configuration')
  const { agent, error } = await controller.resolveAgent(sessionId)
  if (error) throw new Error(error.message)
  const assertIdle = () => {
    signal?.throwIfAborted()
    if (agent.disposed || agent.status !== 'idle' || agent.maintenance || agent.inbox?.nextTurn?.length || agent.inbox?.nextStep?.length) throw new Error('Session is busy or has queued input; retry after it becomes idle')
    if (!isDeepStrictEqual(runtime.profiles.binding(sessionId), binding)) throw new Error('Session configuration changed; retry')
  }
  assertIdle()
  const models = await runtime.adapter.listModels(profileRoute(binding.profile.id), binding.profile, input.model)
  const selection = selectModelPlan(binding.profile, models, input)
  await beforeSelect?.()
  assertIdle() // Discovery can take seconds; never race an in-flight turn.
  if (typeof agent.selectModel !== 'function') throw new Error('Session does not support model selection')
  agent.selectModel(selection)
  await agent.ctx.sessions.flush(agent.session)
  return { session_id: sessionId, selected: selection, effective: 'next_turn', verification: 'requested' }
}
