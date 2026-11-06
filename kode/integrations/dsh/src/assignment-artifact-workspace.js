import { assignmentHomeCall } from './assignment-home.js'
import { readArtifactArchiveReceipt } from './artifact-transfer.js'
/** Resolve source material through a home-owned Assignment; never authorize execution. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export async function prepareAssignmentArtifact(runtime, request, { signal, homeScope } = {}) {
  if (!request || Object.keys(request).sort().join(',') !== 'assignment_id,output,source_stage'
      || !Object.values(request).every(validId)) throw new Error('Invalid Assignment artifact request')
  if (runtime.closed || !runtime.artifactWorkspaces) throw new Error('Assignment artifact Host unavailable')
  const fixed = structuredClone(request), prefix = '/api/v1/messaging'
  const path = `${prefix}/work-assignments/${encodeURIComponent(fixed.assignment_id)}`
  const scope = homeScope ? { id: fixed.assignment_id, host: runtime.host, worker: homeScope.worker_session, operation: homeScope.operation } : null
  const read = () => scope ? assignmentHomeCall(runtime.client, scope, 'context', undefined, signal) : runtime.client.call(path, undefined, signal)
  const assignment = await read()
  if (scope && !isDeepStrictEqual(assignment.dispatch.command.operation, scope.operation)) throw new Error('Assignment materialization home scope mismatch')
  const inputs = assignment.inputs, binding = inputs?.binding
  if (assignment.id !== fixed.assignment_id || assignment.state !== 'prepared' || assignment.worker?.node_id !== runtime.host
      || inputs?.execution_authorized !== false || !validHash(inputs?.hash) || binding?.format !== 'kode.assignment.inputs.v1'
      || binding.run_id !== assignment.run_id || binding.stage_id !== assignment.stage_id
      || binding.context_hash !== assignment.context_hash || binding.authorization_hash !== assignment.authorization_hash) {
    throw new Error('Assignment input binding unavailable')
  }
  const source = binding.sources?.[fixed.source_stage], output = source?.outputs?.[fixed.output], artifact = output?.artifact
  if (!source || !artifact || !Number.isSafeInteger(output.sequence) || output.sequence < 1
      || !validHash(artifact.snapshot_hash) || !validHash(artifact.archive_hash)
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1) throw new Error('Assignment artifact input unavailable')
  const remote = scope ? { home: scope.operation.home_node, assignment_id: assignment.id, worker: scope.worker, operation: scope.operation } : undefined
  const metadata = remote ? await readArtifactArchiveReceipt(runtime.client, output.sequence, artifact.snapshot_hash, signal, remote)
    : await runtime.client.call(`${prefix}/artifact-archives/${output.sequence}`, undefined, signal)
  if (metadata.complete !== true || metadata.sequence !== output.sequence || metadata.snapshot_hash !== artifact.snapshot_hash
      || metadata.archive_hash !== artifact.archive_hash || metadata.bytes !== artifact.bytes) throw new Error('Assignment artifact archive identity mismatch')
  const requestId = createHash('sha256').update(JSON.stringify([fixed.assignment_id, inputs.hash, fixed.source_stage, fixed.output])).digest('hex')
  const workspace = await runtime.artifactWorkspaces.prepare({ request_id: `assignment-${requestId}`, sequence: output.sequence, snapshot_hash: artifact.snapshot_hash }, { signal, remote })
  if (workspace.archive_hash !== artifact.archive_hash || workspace.execution_authorized !== false) throw new Error('Assignment artifact materialization mismatch')
  const current = await read()
  if (runtime.closed || !isDeepStrictEqual(current, assignment)) throw new Error('Assignment changed during artifact preparation')
  signal?.throwIfAborted()
  return { assignment_id: assignment.id, assignment_revision: assignment.revision, input_hash: inputs.hash,
    source_stage: fixed.source_stage, output: fixed.output, source_assignment_id: source.assignment_id,
    sequence: output.sequence, snapshot_hash: artifact.snapshot_hash, archive_hash: artifact.archive_hash,
    workspace, execution_authorized: false }
}

/** Publish the trusted Host observation; the Hub keeps execution authority separate. */
export async function bindAssignmentArtifact(runtime, request, options = {}) {
  const prepared = await prepareAssignmentArtifact(runtime, request, options)
  const path = `/api/v1/messaging/work-assignments/${encodeURIComponent(prepared.assignment_id)}`
  const scope = options.homeScope ? { id: prepared.assignment_id, host: runtime.host, worker: options.homeScope.worker_session, operation: options.homeScope.operation } : null
  const current = scope ? await assignmentHomeCall(runtime.client, scope, 'context', undefined, options.signal) : await runtime.client.call(path, undefined, options.signal)
  if (current.revision !== prepared.assignment_revision) throw new Error('Assignment changed before workspace receipt')
  const input = { request_id: `materialize-${prepared.input_hash}`,
    expected_revision: current.input_workspace?.request.expected_revision ?? prepared.assignment_revision,
    input_hash: prepared.input_hash, source_stage: prepared.source_stage, output: prepared.output,
    sequence: prepared.sequence, snapshot_hash: prepared.snapshot_hash, archive_hash: prepared.archive_hash,
    root: prepared.workspace.source }
  const receipt = scope ? await assignmentHomeCall(runtime.client, scope, 'workspace_receipt', input, options.signal) : await runtime.client.call(`${path}/workspace-receipt`, input, options.signal)
  if (receipt.assignment_id !== prepared.assignment_id || receipt.assignment_revision !== input.expected_revision + 1
      || receipt.input_hash !== input.input_hash || receipt.source_stage !== input.source_stage || receipt.output !== input.output
      || receipt.sequence !== input.sequence || receipt.snapshot_hash !== input.snapshot_hash || receipt.archive_hash !== input.archive_hash
      || receipt.root !== input.root || receipt.host !== runtime.host || receipt.execution_authorized !== false) throw new Error('Assignment workspace receipt mismatch')
  return receipt
}
