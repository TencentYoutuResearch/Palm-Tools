/** Choose one explicitly frozen cwd; never drop other ancestors from provenance. */
export function selectInputArtifact(stage, artifacts, referenced = new Set()) {
  const input = stage.execution?.input_artifact
  if (input == null) return null
  if (!input || Object.keys(input).sort().join(',') !== 'output,stage'
      || !['stage','output'].every(key => typeof input[key] === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(input[key]))) throw Error('Invalid explicit input artifact')
  const selected = artifacts.filter(row => row.source_stage === input.stage && row.output === input.output)
  if (selected.length !== 1 || selected[0].artifact.repository_binding !== stage.execution.repository_binding
      || [...referenced].some(output => output !== input.output)) throw Error('Explicit input artifact does not match frozen sources or judged evidence')
  return selected[0]
}
