/** Small literal edits; all filesystem, ownership and final CAS checks remain in the existing source tools. */
import { createHash } from 'node:crypto'
import { validSourceRequest, inspectAssignmentSource, executeAssignmentSourceTool } from './assignment-source-tools.js'
import { writeAssignmentSource, executeAssignmentWriteTool } from './assignment-write-tool.js'
const fragmentLimit = 16 * 1024, requestLimit = 64 * 1024, outputLimit = 256 * 1024
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const utf8 = text => typeof text === 'string' && !text.includes('\0') && Buffer.from(text, 'utf8').toString('utf8') === text
export function validPatchRequest(request) {
  return Boolean(request && Object.keys(request).sort().join(',') === 'expected_sha256,path,replacements'
    && validSourceRequest({ path: request.path }) && request.path !== '.'
    && typeof request.expected_sha256 === 'string' && /^[a-f0-9]{64}$/.test(request.expected_sha256)
    && Array.isArray(request.replacements) && request.replacements.length >= 1 && request.replacements.length <= 16
    && request.replacements.every(row => row && Object.keys(row).sort().join(',') === 'new_text,old_text'
      && utf8(row.old_text) && row.old_text.length > 0 && utf8(row.new_text)
      && Buffer.byteLength(row.old_text, 'utf8') <= fragmentLimit && Buffer.byteLength(row.new_text, 'utf8') <= fragmentLimit)
    && new Set(request.replacements.map(row => row.old_text)).size === request.replacements.length
    && Buffer.byteLength(JSON.stringify(request), 'utf8') <= requestLimit)
}
function patchedWriteRequest(source, request) {
  if (source.sha256 !== request.expected_sha256) throw new Error('Source patch conflict: expected hash does not match current content')
  let content = source.text
  // TextDecoder strips a leading UTF-8 BOM. Recover it from the verified byte hash rather than dropping unrelated bytes.
  if (hash(Buffer.from(content, 'utf8')) !== source.sha256) {
    content = '\uFEFF' + content
    if (hash(Buffer.from(content, 'utf8')) !== source.sha256) throw new Error('Source patch byte identity could not be preserved')
  }
  for (const { old_text, new_text } of request.replacements) {
    const index = content.indexOf(old_text)
    if (index < 0) throw new Error('Source patch text was not found')
    if (content.indexOf(old_text, index + 1) >= 0) throw new Error('Source patch text is ambiguous')
    content = content.slice(0, index) + new_text + content.slice(index + old_text.length)
  }
  if (Buffer.byteLength(content, 'utf8') > outputLimit) throw new Error('Source patch output exceeds limit')
  return { path: request.path, expected_sha256: request.expected_sha256, content }
}
export async function patchAssignmentSource(root, request, signal, authorize) {
  if (!validPatchRequest(request)) throw new Error('Invalid source patch request')
  request = structuredClone(request)
  const source = await inspectAssignmentSource(root, 'kode_read_source', { path: request.path }, signal, authorize)
  const write = patchedWriteRequest(source, request)
  return writeAssignmentSource(root, write, signal, authorize)
}
export async function executeAssignmentPatchTool(runtime, agent, binding, lock, request, signal, authorize) {
  if (!validPatchRequest(request)) throw new Error('Invalid source patch request')
  request = structuredClone(request)
  const source = await executeAssignmentSourceTool(runtime, agent, binding, lock, 'kode_read_source', { path: request.path }, signal, authorize)
  const write = patchedWriteRequest(source, request)
  // Reuse held Assignment, frozen workspace_write, TaskWorkspace, abort, authorization and atomic CAS checks unchanged.
  return executeAssignmentWriteTool(runtime, agent, binding, lock, write, signal, authorize)
}
