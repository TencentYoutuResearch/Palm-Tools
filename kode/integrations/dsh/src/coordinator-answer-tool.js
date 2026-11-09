/** Forward a consumed human response within the fixed Coordinator authority. */
import { isDeepStrictEqual } from 'node:util'
import { createDeliveryTracker } from './delivery-tracker.js'

export const COORDINATOR_ANSWER_TOOL = 'kode_coordinator_answer_clarification'
export function mountCoordinatorAnswerTool(agentCtx, agent, runtime, scope) {
  const name = COORDINATOR_ANSWER_TOOL
  const operation = structuredClone(runtime.profiles.binding(agent.id)?.managedOperation)
  const tools = agentCtx.get('tools').forScope(agentCtx)
  const policies = agentCtx.get('kodeOfficialToolPolicies')
  const fields = ['request_id', 'assignment_id', 'question_request_id', 'source_message_id']
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
  const valid = args => args && !Array.isArray(args) && Object.keys(args).length === fields.length
    && Object.keys(args).every(key => fields.includes(key)) && fields.every(key => validId(args[key]))
  const dispose = tools.register({
    name,
    description: 'Forward a new consumed human conversation response to its exact pending Worker clarification. Supply the Assignment, question request and human Hub message references. The Hub forwards original human text unchanged. This does not change the workflow, grant or budget and cannot answer secret/login questions. Reuse identical request_id and arguments after uncertainty.',
    parameters: { type: 'object', additionalProperties: false,
      properties: Object.fromEntries(fields.map(key => [key, { type: 'string' }])), required: fields },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async args => {
      runtime.entry.assertToolBody(agent, name, args)
      if (!valid(args)) throw Error('Invalid Coordinator clarification answer arguments')
      const binding = runtime.profiles.binding(agent.id)
      if (binding?.operationClosed || binding?.managedBuilder || binding?.managedAssignment
          || !isDeepStrictEqual(binding?.managedOperation, operation)
          || !isDeepStrictEqual(binding?.managedCoordinator, scope)) throw Error('Coordinator answer binding changed')
      const { assignment_id, ...references } = args
      const body = { ...references, conversation_id: scope.conversation_id, operation_id: operation.id,
        control_revision: scope.control_revision, attempt: operation.attempt, epoch: operation.epoch }
      const path = `/api/v1/messaging/work-assignments/${encodeURIComponent(assignment_id)}/clarification-answers`
      const recover = async () => {
        const { answer } = await runtime.client.call(`${path}/${encodeURIComponent(args.question_request_id)}`)
        if (!answer) return null
        if (answer.snapshot !== 'assignment_answer_receipt.v1' || answer.assignment_id !== assignment_id
            || answer.team_id !== scope.team_id || answer.home_hub !== runtime.host
            || !isDeepStrictEqual(answer.request, body)) throw Error('Coordinator answer receipt conflict')
        return answer
      }
      const prior = await recover()
      if (prior) return prior
      const { input } = await runtime.client.call(`/api/v1/messaging/conversations/${encodeURIComponent(scope.conversation_id)}/messages/${encodeURIComponent(args.source_message_id)}/coordinator-input`)
      if (input?.request?.operation_id !== operation.id || input.request.control_revision !== scope.control_revision
          || input.request.attempt !== operation.attempt || input.request.epoch !== operation.epoch
          || input.receipt?.worker?.session_id !== agent.id) throw Error('Coordinator answer input mismatch')
      await createDeliveryTracker(agent, runtime.client).confirm({ id: input.receipt.message_id })
      try { return await runtime.client.call(path, body) }
      catch (error) {
        const saved = await recover()
        if (saved) return saved
        throw error
      }
    },
  })
  try {
    const policy = policies.register(name, { capabilities: ['read', 'delegate'], network: false, workspaceLock: false,
      implementation: tools.get(name, agent), validateArguments: valid, authorize: request => request.agent === agent && valid(request.arguments) }, agent)
    return () => { policy(); dispose() }
  } catch (error) { dispose(); throw error }
}
