/** Proposal fixtures only; registration happens through the owner UI. */
export function workflowProposal(workspace) {
  const workflow = { id: 'browser-flow', version: '1', inputs: ['request'], stages: [{ id: 'inspect', role: 'coordinator', requires: ['request'], produces: ['artifact'], independent_from: [], execution: { task_tag: 'inspection', repository_binding: 'code', capabilities: ['read'], tools: ['kode_capture_output'], network: false } }], completion_stages: ['inspect'], evidence_rules: { artifact: { kind: 'artifact', repository_binding: 'code' } } }
  const project = { id: 'browser-project', version: '1', spec: { kind: 'project_bindings', repositories: { code: { repository_id: 'repo', workspace } }, environments: {}, commands: {}, connections: {} } }
  const delivery = { id: 'browser-delivery', version: '1', targets: [{ kind: 'local', repository_binding: 'code' }], required_outputs: ['artifact'] }
  return { workflow, project, delivery }
}
export function activationProposal(base, workspace, receipt) {
  return { ...base, name: 'Reviewed team', workspace_refs: [workspace], workflow_pack_refs: [receipt.workflow], delivery_bindings: [{ id: 'local', workflow: receipt.workflow, project: receipt.project, delivery_policy: receipt.delivery_policy }], grant_id: 'browser-grant', budget_policy_id: 'browser-budget-policy', scheduling_policy_id: 'browser-schedule' }
}
