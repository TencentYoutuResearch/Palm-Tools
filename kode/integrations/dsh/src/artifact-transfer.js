/** Owner transport of immutable content; no materialization or execution authority. */
import { createHash } from 'node:crypto'
import { validateArtifactBundle } from './artifact-archive.js'
const CHUNK = 256 * 1024, MAX = 192 * 1024 * 1024
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const pathFor = sequence => {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid artifact sequence')
  return `/api/v1/messaging/artifact-archives/${sequence}`
}
export async function deliverArtifactArchive(client, sequence, archive, reference, signal, remote) {
  const bundle = await archive.read(reference.snapshot_hash, reference)
  const data = Buffer.from(JSON.stringify(bundle)), path = pathFor(sequence)
  if (data.length !== reference.bytes || digest(data) !== reference.archive_hash) throw new Error('Artifact archive serialized identity changed')
  const identity = { archive_hash: reference.archive_hash, bytes: reference.bytes }
  if (remote && (![remote.home, remote.operation?.id, remote.worker].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value))
      || !Number.isSafeInteger(remote.operation.attempt) || remote.operation.attempt < 1)) throw new Error('Invalid remote archive scope')
  const relay = action => client.call(`/api/v1/messaging/operation-accounting-relay/${encodeURIComponent(remote.home)}`, {
    operation_id: remote.operation.id, worker_session: remote.worker, command: null,
    accounting: { attempt: remote.operation.attempt, action },
  }, signal)
  for (let offset = 0, index = 0; offset < data.length; offset += CHUNK, index++) {
    signal?.throwIfAborted()
    if (!remote) await client.call(`${path}/chunks/${index}`, { ...identity, data: data.subarray(offset, offset + CHUNK).toString('base64') }, signal)
    else for (let part = 0; part < Math.min(CHUNK, data.length - offset); part += 32768) {
      signal?.throwIfAborted()
      const bytes = data.subarray(offset + part, Math.min(offset + part + 32768, offset + CHUNK, data.length))
      const receipt = await relay({ kind: 'artifact_archive_segment', sequence, index, offset: part, chunk: { ...identity, data: bytes.toString('base64') } })
      if (receipt.sequence !== sequence || receipt.index !== index || receipt.offset !== part || receipt.segment_bytes !== bytes.length
          || receipt.archive_hash !== identity.archive_hash || receipt.bytes !== identity.bytes || receipt.completion_authorized !== false) throw new Error('Remote archive segment receipt mismatch')
    }
  }
  const receipt = remote ? await relay({ kind: 'artifact_archive_complete', sequence, identity }) : await client.call(`${path}/complete`, identity, signal)
  if (receipt.sequence !== sequence || receipt.archive_hash !== reference.archive_hash || receipt.snapshot_hash !== reference.snapshot_hash
      || receipt.bytes !== reference.bytes || receipt.complete !== true || receipt.completion_authorized !== false) throw new Error('Artifact archive receipt mismatch')
  return receipt
}
async function artifactReader(client, sequence, snapshotHash, signal, remote) {
  const path = pathFor(sequence)
  const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
  if (remote && (![remote.home, remote.assignment_id, remote.worker, remote.operation?.id].every(valid)
      || remote.operation.home_node !== remote.home || !Number.isSafeInteger(remote.operation.attempt) || remote.operation.attempt < 1)) throw new Error('Invalid remote Assignment archive scope')
  const relay = offset => client.call(`/api/v1/messaging/operation-accounting-relay/${encodeURIComponent(remote.home)}`, {
    operation_id: remote.operation.id, worker_session: remote.worker, command: null,
    accounting: { attempt: remote.operation.attempt, action: { kind: 'assignment_archive_read', assignment_id: remote.assignment_id, sequence, offset } },
  }, signal)
  const receipt = remote ? await relay(null) : await client.call(path, undefined, signal)
  if (!hash(snapshotHash) || receipt.sequence !== sequence || receipt.snapshot_hash !== snapshotHash || !hash(receipt.archive_hash)
      || receipt.complete !== true || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || receipt.bytes > MAX || receipt.chunk_bytes !== CHUNK) throw new Error('Artifact archive unavailable or mismatched')
  return { path, receipt, relay }
}
export async function readArtifactArchiveReceipt(client, sequence, snapshotHash, signal, remote) {
  return (await artifactReader(client, sequence, snapshotHash, signal, remote)).receipt
}
export async function fetchArtifactArchive(client, sequence, snapshotHash, signal, remote) {
  const { path, receipt, relay } = await artifactReader(client, sequence, snapshotHash, signal, remote)
  const chunks = []
  const size = remote ? 32768 : CHUNK
  for (let offset = 0; offset < receipt.bytes; offset += size) {
    signal?.throwIfAborted()
    const index = offset / CHUNK
    const row = remote ? await relay(offset) : await client.call(`${path}/chunks/${index}`, undefined, signal)
    if (row.sequence !== sequence || (remote ? row.offset !== offset : row.index !== index) || row.archive_hash !== receipt.archive_hash || typeof row.data !== 'string'
        || row.data.length > Math.ceil(size / 3) * 4) throw new Error('Artifact archive chunk mismatch')
    const data = Buffer.from(row.data, 'base64'), expected = Math.min(size, receipt.bytes - offset)
    if (data.length !== expected || data.toString('base64') !== row.data) throw new Error('Artifact archive chunk encoding mismatch')
    chunks.push(data)
  }
  const data = Buffer.concat(chunks)
  if (digest(data) !== receipt.archive_hash) throw new Error('Artifact archive transport hash mismatch')
  const bundle = JSON.parse(data.toString('utf8'))
  if (validateArtifactBundle(bundle) !== snapshotHash) throw new Error('Artifact archive snapshot mismatch')
  return { receipt, bundle }
}
