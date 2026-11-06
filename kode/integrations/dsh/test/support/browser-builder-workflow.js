/** Controlled proposal content. Uses a real registered verifier; does not execute it. */
import { realpath } from 'node:fs/promises'
import { verificationExecutableHash } from '../../src/verification-runners.js'
export async function browserBuilderWorkflow(execution, workspace) {
  const executable = await realpath(process.execPath)
  const verification = execution.verificationRunners.register({ runner_id: 'browser-check', command_id: 'browser-readme', revision: '1', executable,
    executable_hash: await verificationExecutableHash(executable), args: ['-e', "if(!require('node:fs').readFileSync('README.md','utf8').includes('Selected fixture project'))process.exit(3)"],
    env: {}, timeout_ms: 5000, max_output_bytes: 65536, scenario_ids: ['readme'], capabilities: ['read'], network: false, tool_id: 'kode_verify_output' })
  const stage = (id, role, requires, produces, independent_from, tools, capabilities = ['read']) => ({ id, role, requires, produces, independent_from,
    execution: { task_tag: 'development', repository_binding: 'code', capabilities, tools, network: false } })
  return {
    workflow: { id: 'native-browser-flow', version: '1', inputs: ['request'], stages: [
      stage('implement', 'author', ['request'], ['artifact'], [], ['kode_write_source', 'kode_capture_output', 'kode_publish_output'], ['read', 'workspace_write']),
      stage('review', 'reviewer', ['implement'], ['reviewed'], ['implement'], ['kode_read_source', 'kode_review_output', 'kode_publish_output']),
      stage('verify', 'verifier', ['review'], ['checked'], ['implement', 'review'], ['kode_verify_output', 'kode_publish_output']),
    ], completion_stages: ['verify'], evidence_rules: { artifact: { kind: 'artifact', repository_binding: 'code' }, reviewed: { kind: 'review', artifact_output: 'artifact' }, checked: { kind: 'verification', artifact_output: 'artifact', command_binding: 'check', environment_binding: 'local', required_scenarios: ['readme'] } } },
    project: { id: 'native-browser-project', version: '1', spec: { kind: 'project_bindings', repositories: { code: { repository_id: 'browser-repo', workspace } },
      environments: { local: { host_id: workspace.host_id, adapter_id: 'local_process_v1', configuration_hash: verification.environment_hash } },
      commands: { check: { id: verification.id, revision: verification.revision, definition_hash: verification.definition_hash, repository_binding: 'code', environment_binding: 'local', runner_id: verification.runner_id, scenario_ids: verification.scenario_ids } }, connections: {} } },
    delivery: { id: 'native-browser-delivery', version: '1', targets: [{ kind: 'local', repository_binding: 'code' }], required_outputs: ['checked'] },
  }
}
