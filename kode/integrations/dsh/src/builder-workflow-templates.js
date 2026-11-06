/** Unregistered, credential-free built-in methods. Owner configuration still supplies authority. */
const execution = (task_tag, tools, write = false, input_artifact) => ({ task_tag, repository_binding: 'code',
  capabilities: write ? ['read', 'workspace_write'] : ['read'], tools, network: false,
  ...(input_artifact ? { input_artifact } : {}) })
const source = (stage, output) => ({ stage, output })
export function builderWorkflowTemplates() {
  const make = (bugfix) => {
    const prior = bugfix ? 'diagnose' : 'request'
    const stages = [
      ...(bugfix ? [
        // Write scope provisions an isolated HEAD checkout; these tools cannot mutate it.
        { id: 'baseline', role: 'implementer', requires: ['request'], produces: ['baseline'], independent_from: [],
          execution: execution('inspection', ['kode_read_source','kode_capture_output','kode_publish_output'], true) },
        { id: 'diagnose', role: 'verifier', requires: ['baseline'], produces: ['reproduction'], independent_from: ['baseline'],
          waiver: { allow_delivery: true }, on_reject: { target: 'baseline', max_reworks: 0 },
          execution: execution('verification', ['kode_verify_output','kode_publish_output'], false, source('baseline','baseline')) },
      ] : []),
      { id: 'implement', role: 'implementer', requires: [prior], produces: ['artifact'], independent_from: [],
        execution: execution('implementation', ['kode_read_source','kode_write_source','kode_capture_output','kode_publish_output'], true,
          bugfix ? source('baseline','baseline') : undefined) },
      { id: 'review', role: 'reviewer', requires: ['implement'], produces: ['reviewed'], independent_from: ['implement'],
        on_reject: { target: 'implement', max_reworks: 2 },
        execution: execution('review', ['kode_read_source','kode_review_output','kode_publish_output'], false, bugfix ? source('implement','artifact') : undefined) },
      { id: 'verify', role: 'verifier', requires: ['review'], produces: ['checked'], independent_from: ['implement','review'],
        on_reject: { target: 'implement', max_reworks: 2 },
        execution: execution('verification', ['kode_verify_output','kode_publish_output'], false, bugfix ? source('implement','artifact') : undefined) },
    ]
    return { id: bugfix ? 'software-bugfix' : 'software-feature', version: '1', registered: false,
      procedure: bugfix
        ? 'Capture an immutable baseline in the isolated fixed-base task checkout. An owner-registered reproduction judge must confirm the expected defect and return exit 0 only for that confirmation. Preserve its exact scenarios and Home log. If reproduction is unavailable, pause; only an owner can waive diagnose against the exact baseline and attempt, with an explicit unreproduced reason. Waived means unreproduced with owner authorization, never passed. Implement, independently review and verify the fixed artifact; local delivery is archived and unintegrated.'
        : 'Implement in an isolated task checkout, independently review the frozen artifact, then execute configured verification. Local delivery is archived and unintegrated.',
      pending_checks: ['owner_confirmed_task_tags_and_current_capability_assessments','selected_registered_workspace','owner_registered_commands_and_expected_outcomes','real_command_references','resources','grant','budget','owner_package_confirmation','activation'],
      assessment_basis: 'Proposed task tags are configurable labels, not capability or scheduling claims. Resolve each tag against owner-selected current assessments before package confirmation and activation.',
      bindings: { repository: 'code', environment: 'local', verification_command: 'check', ...(bugfix ? { reproduction_command: 'reproduce',
        reproduction_semantics: 'exit_zero_means_expected_defect_confirmed; ordinary nonzero bug exit is not a passed check' } : {}) },
      workflow: { id: bugfix ? 'software-bugfix' : 'software-feature', version: '1', inputs: ['request'], stages,
        completion_stages: ['verify'], evidence_rules: {
          ...(bugfix ? { baseline: { kind: 'artifact', repository_binding: 'code' }, reproduction: { kind: 'verification', artifact_output: 'baseline',
            command_binding: 'reproduce', environment_binding: 'local', required_scenarios: ['reproduction-confirmed'] } } : {}),
          artifact: { kind: 'artifact', repository_binding: 'code' }, reviewed: { kind: 'review', artifact_output: 'artifact' },
          checked: { kind: 'verification', artifact_output: 'artifact', command_binding: 'check', environment_binding: 'local', required_scenarios: ['regression'] },
        } },
      delivery: { id: bugfix ? 'software-bugfix-local' : 'software-feature-local', version: '1', targets: [{ kind: 'local', repository_binding: 'code' }], required_outputs: ['artifact','reviewed','checked'] },
    }
  }
  return [make(false), make(true)].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
export function readBuilderWorkflowTemplates({ after_id, after_version, limit }) {
  const items = builderWorkflowTemplates().filter(row => !after_id || row.id > after_id || row.id === after_id && row.version > after_version)
  const page = items.slice(0,limit), last = page.at(-1)
  return { kind:'workflow_template', items:page, has_more:items.length > page.length,
    next_cursor:items.length > page.length ? { after_id:last.id, after_version:last.version } : null,
    registered:false, execution_authorized:false }
}
