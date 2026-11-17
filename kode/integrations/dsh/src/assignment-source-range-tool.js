import { inspectAssignmentSource, resolveAssignmentSource, validSourceRequest } from './assignment-source-tools.js'

// A separate, opt-in capability: the caller cannot choose a workspace root.
export const sourceRangeMaxLines = 120
export const sourceRangeMaxBytes = 16 * 1024
export function validSourceRangeRequest(request) {
  return Boolean(request && Object.keys(request).sort().join(',') === 'expected_sha256,line_count,path,start_line'
    && validSourceRequest({ path: request.path }) && request.path !== '.'
    && Number.isSafeInteger(request.start_line) && request.start_line >= 1
    && Number.isSafeInteger(request.line_count) && request.line_count >= 1 && request.line_count <= sourceRangeMaxLines
    && (typeof request.expected_sha256 === 'string' && /^[a-f0-9]{64}$/.test(request.expected_sha256)
      || request.expected_sha256 === null && request.start_line === 1))
}
export async function inspectAssignmentSourceRange(root, request, signal, authorize) {
  if (!validSourceRangeRequest(request)) throw new Error('Invalid source range request')
  // Reuse the complete bounded reader: UTF-8, size, path, no symlinks/hardlinks,
  // inode stability, abort and both authorization checks are identical to read_source.
  const source = await inspectAssignmentSource(root, 'kode_read_source', { path: request.path }, signal, authorize)
  if (request.expected_sha256 !== null && request.expected_sha256 !== source.sha256) throw new Error('Source hash conflict; restart from line 1')
  // Preserve exact LF/CRLF bytes. A terminal LF does not create a phantom line.
  const lines = source.text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  if (request.start_line > Math.max(1, lines.length)) throw new Error('Source start_line is past end of file')
  const selected = lines.slice(request.start_line - 1, request.start_line - 1 + request.line_count)
  const text = selected.join(''), rangeBytes = Buffer.byteLength(text, 'utf8')
  if (rangeBytes > sourceRangeMaxBytes) throw new Error('Source range exceeds 16 KiB; request fewer lines (a single oversized line cannot be read with this tool)')
  const endLine = request.start_line + selected.length - 1
  return { path: source.path, sha256: source.sha256, file_bytes: source.bytes, total_lines: lines.length,
    start_line: request.start_line, end_line: endLine, requested_line_count: request.line_count,
    returned_line_count: selected.length, range_bytes: rangeBytes,
    next_start_line: endLine < lines.length ? endLine + 1 : null, text }
}
export async function executeAssignmentSourceRangeTool(runtime, agent, binding, lock, request, signal, authorize) {
  if (!validSourceRangeRequest(request)) throw new Error('Invalid source range request')
  await resolveAssignmentSource(runtime, agent, binding, lock, { path: request.path }, signal)
  return inspectAssignmentSourceRange(lock.root, request, signal, authorize)
}
