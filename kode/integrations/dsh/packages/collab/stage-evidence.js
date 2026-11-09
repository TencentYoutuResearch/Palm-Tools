/** Project Hub-selected evidence references, never infer delivery from an output or stage. */
export function stageEvidence(run, stage) {
  const selection = stage.evidence
  if (selection == null) return { state: 'absent', outputs: [] }
  if (selection.assignment_id !== stage.assignment_id || selection.stage_attempt !== stage.attempt
    || selection.context_hash !== run.context_hash || !selection.outputs || Array.isArray(selection.outputs)
    || typeof selection.outputs !== 'object') return { state: 'invalid', outputs: [] }
  const rules = run.context?.binding?.workflow?.pack?.evidence_rules ?? {}
  const outputs = Object.entries(selection.outputs).map(([name, seq]) => ({ name, seq, kind: rules[name]?.kind ?? 'unknown' }))
  if (!outputs.length || outputs.some(row => !Number.isSafeInteger(row.seq) || row.seq < 1)) return { state: 'invalid', outputs: [] }
  const completion = stage.completion
  const finalized = completion?.run_id === run.id && completion?.stage_id === stage.stage_id
    && completion?.assignment_id === stage.assignment_id && typeof completion.stage_passed === 'boolean'
  return { state: finalized ? (completion.stage_passed ? 'passed' : 'rejected') : 'selected', outputs }
}
