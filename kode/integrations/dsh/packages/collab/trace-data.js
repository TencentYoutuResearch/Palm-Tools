/** Read-only trace pagination and resumable export parts. Never invokes tools. */
export const TRACE_VIEWS = ['work_events', 'assignments', 'operations', 'operation_events', 'model_calls', 'model_events', 'messages', 'communication_events', 'conversation', 'archives', 'verification_archives', 'team_history']
const integer = value => Number.isSafeInteger(value) && value >= 0
const scopes = ['work_run', 'worker_assignment', 'shared_coordinator_operation', 'shared_human_request', 'home_archive_reference', 'shared_team_history']
function base(value, run, view) {
  if (value?.schema_version !== 1 || value.home_hub !== run.home_hub || value.team_id !== run.team_id || value.run_id !== run.id || value.run_revision !== run.revision || value.view !== view || value.read_only !== true
      || value.consistency !== 'anchored_membership_current_records' || value.redaction_policy !== 'credential_fields_environments_arguments_v1' || value.archive_payloads_included !== false
      || value.cost_attribution !== 'operation_scoped_shared_coordinator_not_allocated') throw Error('Trace scope or contract changed')
  return value
}
const path = (run, query) => '/api/kode/work-run/trace?' + new URLSearchParams({ run_id: run.id, team_id: run.team_id, run_revision: String(run.revision), ...query })
export function validateTraceManifest(value, run) {
  base(value, run, 'manifest')
  if (value.context?.id !== run.id || value.context.team_id !== run.team_id || value.context.home_hub !== run.home_hub || value.context.revision !== run.revision
      || !Array.isArray(value.streams) || value.streams.length !== TRACE_VIEWS.length || new Set(value.streams.map(row => row.view)).size !== TRACE_VIEWS.length
      || value.streams.some(row => !TRACE_VIEWS.includes(row.view) || !integer(row.through) || !integer(row.count) || row.count > row.through || (row.count === 0) !== (row.through === 0))) throw Error('Trace manifest incomplete')
  const prompt=value.prompt_attestation,modelCount=value.streams.find(row=>row.view==='model_calls').count
  if(!Array.isArray(value.redacted_paths)||value.redacted_paths.some(path=>typeof path!=='string')||!integer(prompt?.calls)||prompt.calls!==modelCount||!integer(prompt.missing)||prompt.missing>prompt.calls
      ||prompt.status!==(prompt.calls===0?'not_started':prompt.missing>0?'incomplete':'recorded'))throw Error('Trace provenance coverage unavailable')
  return value
}
export async function readTraceManifest({ run, request, signal }) {
  signal?.throwIfAborted()
  return validateTraceManifest(await request(path(run, { view: 'manifest' }), { signal }), run)
}
export async function readTracePage({ run, manifest, view, after = 0, q = '', request, signal }) {
  signal?.throwIfAborted()
  validateTraceManifest(manifest, run)
  const stream = manifest.streams.find(row => row.view === view)
  if (!stream || !integer(after) || after > stream.through || typeof q !== 'string' || new TextEncoder().encode(q).length > 160 || q.includes('\0')) throw Error('Invalid trace page request')
  const value = base(await request(path(run, { view, after: String(after), through: String(stream.through), limit: '25', q }), { signal }), run, view)
  if (value.query !== q || value.after !== after || value.through !== stream.through || !integer(value.scanned_to) || value.scanned_to < after || value.scanned_to > stream.through
      || !Array.isArray(value.items) || value.items.length > 25 || !integer(value.scanned) || value.scanned > 50
      || value.next_cursor !== null && (value.next_cursor !== value.scanned_to || value.next_cursor <= after)
      || value.next_cursor === null && value.scanned_to !== stream.through || q === '' && value.items.length !== value.scanned) throw Error('Trace continuation did not prove completion or progress')
  let cursor = after
  for (const row of value.items) {
    if (!integer(row.cursor) || row.cursor <= cursor || row.cursor > value.scanned_to || !/^[a-f0-9]{64}$/.test(row.raw_sha256)
        || !integer(row.raw_bytes) || row.raw_bytes > 4 * 1024 * 1024 || !Array.isArray(row.redacted_paths) || row.redacted_paths.some(path => typeof path !== 'string')
        || !scopes.includes(row.links?.scope)) throw Error('Invalid trace record')
    cursor = row.cursor
  }
  return value
}
export async function readTraceSlice({ run, manifest, view = 'all', cursor, q = '', request, signal, maxRecords = 25, maxPages = 4, maxBytes = 8 * 1024 * 1024 }) {
  validateTraceManifest(manifest, run)
  if (view !== 'all' && !TRACE_VIEWS.includes(view) || typeof q !== 'string' || new TextEncoder().encode(q).length > 160 || q.includes('\0')
      || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100 || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 12 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw Error('Invalid trace slice')
  const views = view === 'all' ? TRACE_VIEWS : [view]
  const key = JSON.stringify([run.home_hub, run.team_id, run.id, run.revision, view, q, ...TRACE_VIEWS.map(name => { const row = manifest.streams.find(item => item.view === name); return [name, row.through, row.count] })])
  let index = cursor?.index ?? 0, after = cursor?.after ?? 0, pages = 0, bytes = 0
  if (cursor && cursor.scope !== key || !integer(index) || index >= views.length || !integer(after) || after > manifest.streams.find(row => row.view === views[index]).through) throw Error('Trace cursor belongs to another query')
  const items = [], next = () => ({ items, next_cursor: index < views.length ? { scope: key, index, after } : null })
  while (index < views.length) {
    const source = views[index], stream = manifest.streams.find(row => row.view === source)
    if (!stream.through) { index++; after = 0; continue }
    const page = await readTracePage({ run, manifest, view: source, after, q, request, signal }); pages++
    for (const row of page.items) {
      const size = new TextEncoder().encode(JSON.stringify(row)).length
      if (items.length === maxRecords || bytes + size > maxBytes) { if (!items.length) throw Error('Trace record exceeds reader budget'); return next() }
      items.push({ view: source, ...row }); bytes += size; after = row.cursor
    }
    if (page.next_cursor === null) { index++; after = 0 } else after = page.next_cursor
    if (pages === maxPages || items.length === maxRecords) return next()
  }
  return next()
}
export async function exportTracePart({ run, request, signal, continuation, maxRecords = 5000, maxBytes = 16 * 1024 * 1024, uuid = () => crypto.randomUUID() }) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 20000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw Error('Invalid trace export budget')
  signal?.throwIfAborted()
  const manifest = continuation ? validateTraceManifest(continuation.manifest, run) : await readTraceManifest({ run, request, signal })
  let index = continuation?.index ?? 0, after = continuation?.after ?? 0
  if (!integer(index) || index >= TRACE_VIEWS.length || !integer(after) || after > manifest.streams.find(row => row.view === TRACE_VIEWS[index]).through
      || continuation && (!Number.isSafeInteger(continuation.part) || continuation.part < 2 || typeof continuation.export_id !== 'string' || !continuation.export_id)) throw Error('Wrong trace export continuation')
  const counts = continuation?.counts ? { ...continuation.counts } : Object.fromEntries(TRACE_VIEWS.map(view => [view, 0]))
  if (Object.keys(counts).sort().join(',') !== [...TRACE_VIEWS].sort().join(',') || TRACE_VIEWS.some((view, position) => {
    const maximum = manifest.streams.find(row => row.view === view).count
    return !integer(counts[view]) || counts[view] > maximum || position < index && counts[view] !== maximum || position > index && counts[view] !== 0
      || position === index && (counts[view] > after || after === 0 && counts[view] !== 0 || after > 0 && counts[view] === 0)
  })) throw Error('Trace export counts do not match its continuation')
  const document = { format: 'kode.work-run.trace.v1', export_id: continuation?.export_id ?? uuid(), part: continuation?.part ?? 1,
    home_hub: run.home_hub, team_id: run.team_id, run_id: run.id, run_revision: run.revision, manifest, records: {}, complete: false, counts }
  const encodedSize = value => new TextEncoder().encode(JSON.stringify(value)).length
  let count = 0, bytes = encodedSize(document) + 1024
  if (bytes > maxBytes) throw Error('Trace manifest exceeds export byte budget')
  const finish = next => { if (encodedSize(document) > maxBytes) throw Error('Trace part exceeds export byte budget'); return { document, continuation: next } }
  for (; index < TRACE_VIEWS.length; index++, after = 0) {
    const view = TRACE_VIEWS[index], stream = manifest.streams.find(row => row.view === view)
    document.records[view] ??= []
    if (!stream.through) continue
    while (true) {
      signal?.throwIfAborted()
      const page = await readTracePage({ run, manifest, view, after, request, signal })
      for (const row of page.items) {
        const size = encodedSize(row) + 1
        if (count + 1 > maxRecords || bytes + size > maxBytes) {
          if (!count) throw Error('Trace record exceeds export byte budget')
          document.continuation = { view, after }
          return finish({ manifest, index, after, part: document.part + 1, export_id: document.export_id, counts: { ...counts } })
        }
        document.records[view].push(row); count++; counts[view]++; bytes += size; after = row.cursor
      }
      if (page.next_cursor === null) { if (counts[view] !== stream.count) throw Error('Trace export record count is incomplete'); break }
      after = page.next_cursor
    }
  }
  document.complete = true; document.parts_total = document.part
  return finish(null)
}
