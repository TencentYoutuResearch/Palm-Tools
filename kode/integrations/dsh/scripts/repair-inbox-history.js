/** Validation/encoding worker for repair-inbox-history.py; never replaces the live log. */
import { readFile, writeFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { repairNativeInboxSplices } from '../src/repair-inbox-splices.js'
import { repairOptionalPluginRecords } from '../src/repair-plugin-records.js'
import { repairNativeSystemHeads } from '../src/repair-system-heads.js'
import { encodeHistoryArtifact } from '../src/native-history.js'
const [path, modules, output] = process.argv.slice(2)
if (!path || !modules) throw new Error('Expected artifact and released runtime modules paths')
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
if (nodeMajor < 24 || nodeMajor === 24 && nodeMinor < 22) throw new Error('Node 24.22+ is required to read concatenated Zstandard frames')
const { Session, KNOWN_SESSION_EVENT_TYPES } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-session/lib/index.js')))
const { validateStoredEvents } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-session-persistence/lib/index.js')))
const { restoreReleasedV4Artifact } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js')))
const [wireHeader, ...events] = zstdDecompressSync(await readFile(path)).toString().trim().split('\n').map(JSON.parse)
const inbox = repairNativeInboxSplices(events)
const optional = repairOptionalPluginRecords(inbox.events)
const systemHeads = repairNativeSystemHeads(optional.events)
const repaired = systemHeads.events, changes = [...inbox.changes, ...optional.changes, ...systemHeads.changes]
const header = { ...wireHeader }; delete header.type
validateStoredEvents(header, structuredClone(repaired))
// The final inherited marker is the released format's authoritative fork cut.
// Never treat a fork as an ordinary session, or alter its copied prefix length.
const inheritedEventCount = header.isSeeded ? repaired.findLastIndex(event => event.type === 'session/end-seed' && event.data?.inherited === true) : 0
restoreReleasedV4Artifact({ header, events: repaired, inheritedEventCount }, KNOWN_SESSION_EVENT_TYPES)
Session.create(header.id, repaired, header, inheritedEventCount)
if (output && changes.length) {
  await writeFile(output, encodeHistoryArtifact(wireHeader, repaired), { mode: 0o600, flag: 'wx' })
  const file = await open(output, 'r+')
  try { await file.sync() } finally { await file.close() }
}
console.log(JSON.stringify({ sessionId: header.id, eventCount: events.length, changes }))
