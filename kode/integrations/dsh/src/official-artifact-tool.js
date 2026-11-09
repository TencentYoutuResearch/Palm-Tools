/** Scoped capture tool. Host fixes repository/root; model can only name immutable evidence. */
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
export const OFFICIAL_ARTIFACT_TOOL = 'kode_artifact_capture'
export function mountOfficialArtifactTool(agentCtx, agent, execution, policy) {
  const fixed = structuredClone(policy), operation = structuredClone(execution.profiles.binding(agent.id)?.managedOperation)
  if (!fixed || !isAbsolute(fixed.workspaceRoot ?? '') || !/^[A-Za-z0-9_.:-]{1,160}$/.test(fixed.repositoryId ?? '')
      || !operation) throw new Error('Explicit artifact scope required')
  const view = agentCtx.get('tools'), tools = view?.forScope ? view.forScope(agentCtx) : view
  const policies = agentCtx.get('kodeOfficialToolPolicies')
  if (!tools || !policies) throw new Error('Controlled artifact tool services unavailable')
  const argsValid = args => args && typeof args === 'object' && !Array.isArray(args)
    && Object.keys(args).length === 1 && /^[A-Za-z0-9_.:-]{1,160}$/.test(args.evidence_id ?? '')
  const scopeValid = async root => root === fixed.workspaceRoot && await realpath(fixed.workspaceRoot) === fixed.workspaceRoot
  const definition = {
    name: OFFICIAL_ARTIFACT_TOOL,
    description: 'Capture the authorized repository into immutable artifact evidence. A repeated evidence ID returns its original snapshot; use a fresh ID after edits. Does not complete work.',
    parameters: { type: 'object', properties: { evidence_id: { type: 'string', minLength: 1, maxLength: 160 } }, required: ['evidence_id'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, request) => {
      if (request.agent !== agent || !argsValid(args) || !execution.authorizesLease(agent, operation)) throw new Error('Artifact capture ownership changed')
      const grant = operation.home_node
        ? await execution.client.call(`/api/v1/messaging/operation-accounting-relay/${encodeURIComponent(operation.home_node)}`, {
          operation_id: operation.id, worker_session: agent.id, command: null,
          accounting: { attempt: operation.attempt, action: { kind: 'grant_context' } },
        }, request.signal)
        : await execution.client.call(`/api/v1/messaging/operations/${encodeURIComponent(operation.id)}/grant`, undefined, request.signal)
      if (!grant.grant_required || !grant.available || !await scopeValid(grant.binding?.scope?.target?.root)) throw new Error('Artifact capture requires its exact granted workspace')
      const row = await execution.artifacts.capture(agent.id, operation, args.evidence_id, { ...fixed, signal: request.signal })
      // Pending delivery is a recorded observation, not a failed/replayable tool effect.
      return { evidence_id: args.evidence_id, operation_id: operation.id, snapshot: row.evidence.payload.snapshot,
        home_reconciled: row.home_reconciled, home_sequence: row.home_sequence ?? null, snapshot_hash: row.snapshot_hash ?? null, completion_authorized: false }
    },
  }
  const removeTool = tools.register(definition)
  let removePolicy
  try {
    removePolicy = policies.register(OFFICIAL_ARTIFACT_TOOL, { capabilities: ['read'], network: false, workspaceLock: true,
      implementation: tools.get(OFFICIAL_ARTIFACT_TOOL, agent),
      authorize: async (request, { root }) => request.agent === agent && argsValid(request.arguments) && await scopeValid(root),
    }, agent)
  } catch (error) { removeTool(); throw error }
  return () => { removePolicy(); removeTool() }
}
