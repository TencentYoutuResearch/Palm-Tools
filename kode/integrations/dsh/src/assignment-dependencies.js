/** Validate Home-frozen instruction artifacts before they enter any Worker input. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
const sha256 = text => createHash('sha256').update(text).digest('hex')
const fail = () => { throw Error('Assignment workflow dependency binding mismatch') }
export function assignmentDependencies(mandate) {
  const references = mandate.stage?.execution?.dependencies ?? [], rows = mandate.dependencies ?? []
  if (!Array.isArray(references) || !Array.isArray(rows) || references.length > 8 || references.length !== rows.length
    || references.some(row => !row || typeof row.id !== 'string') || rows.some(row => !row || typeof row !== 'object')
    || new Set(references.map(row => row.id)).size !== references.length) fail()
  if (Buffer.byteLength(JSON.stringify(rows)) > 32768) fail()
  const scope = mandate.stage?.execution, grant = mandate.grant_scope, manifest = []
  for (const reference of references) {
    const row = rows.find(row => row.id === reference.id && row.version === reference.version), config = row?.config
    const artifact = config?.spec?.artifact
    if (!artifact || config.spec.kind !== 'workflow_dependency' || config.id !== reference.id || config.version !== reference.version
      || row.hash !== reference.hash || !['skill', 'plugin'].includes(artifact.kind)
      || typeof artifact.instructions !== 'string' || !artifact.instructions.trim() || Buffer.byteLength(artifact.instructions) > 16384
      || artifact.instructions.includes('\0') || sha256(artifact.instructions) !== artifact.content_hash
      || !Array.isArray(artifact.hosts) || !artifact.hosts.includes(mandate.worker?.node_id)
      || !Array.isArray(artifact.tools) || !Array.isArray(artifact.capabilities)
      || artifact.tools.some(tool => !scope.tools?.includes(tool) || !grant?.tools?.includes(tool))
      || artifact.capabilities.some(capability => !scope.capabilities?.includes(capability) || !grant?.capabilities?.includes(capability))
      || (artifact.network && (!scope.network || !grant?.network))) fail()
    // Match Rust's typed canonical serialization, independently of JSON object key order.
    const canonical = { id: config.id, version: config.version, spec: { kind: 'workflow_dependency', artifact: {
      kind: artifact.kind, source: artifact.source, source_version: artifact.source_version, content_hash: artifact.content_hash,
      instructions: artifact.instructions, hosts: artifact.hosts, tools: artifact.tools, capabilities: artifact.capabilities, network: artifact.network,
    } } }
    if (!isDeepStrictEqual(config, canonical) || sha256('kode.project.config.v1\n' + JSON.stringify(canonical)) !== reference.hash) fail()
    manifest.push({ id: config.id, version: config.version, hash: row.hash, kind: artifact.kind,
      source: artifact.source, source_version: artifact.source_version, content_hash: artifact.content_hash })
  }
  return manifest
}
