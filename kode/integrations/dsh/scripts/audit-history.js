/** Read-only compatibility audit. Enumerate current artifacts on every run; never use a saved file list. */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { repairNativeInboxSplices } from '../src/repair-inbox-splices.js'
const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1]
if (!args.includes('--home') || !args.includes('--runtime-modules')) throw new Error('Expected --home <dsh-home> --runtime-modules <released-node_modules>')
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 24 || major === 24 && minor < 22) throw new Error('Node 24.22+ is required to read concatenated Zstandard frames')
const home = resolve(value('--home')), modules = resolve(value('--runtime-modules'))
const { Session, KNOWN_SESSION_EVENT_TYPES } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-session/lib/index.js')))
const { validateStoredEvents } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-session-persistence/lib/index.js')))
const { restoreReleasedV4Artifact } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js')))
let scanned = 0, changedDuringRead = 0
const problems = []
for (const workspace of await readdir(join(home, 'sessions'), { withFileTypes: true })) {
  if (!workspace.isDirectory()) continue
  const root = join(home, 'sessions', workspace.name)
  for (const session of await readdir(root, { withFileTypes: true })) {
    if (!session.isDirectory()) continue
    const path = join(root, session.name, 'session.v4.jsonl.zstd')
    let before
    try { before = await stat(path) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    scanned++
    try {
      const [wireHeader, ...events] = zstdDecompressSync(await readFile(path)).toString().trim().split('\n').map(JSON.parse)
      const header = { ...wireHeader }; delete header.type
      const inheritedEventCount = header.isSeeded ? events.findLastIndex(e => e.type === 'session/end-seed' && e.data?.inherited === true) : 0
      validateStoredEvents(header, structuredClone(events))
      restoreReleasedV4Artifact({ header, events, inheritedEventCount }, KNOWN_SESSION_EVENT_TYPES)
      Session.create(header.id, events, header, inheritedEventCount)
      const inbox = repairNativeInboxSplices(events)
      if (inbox.changes.length) throw new Error(`Invalid persisted inbox splice; repair required at seq ${inbox.changes[0].seq}`)
      if ((await stat(path)).mtimeMs !== before.mtimeMs) changedDuringRead++
    } catch (error) { problems.push({ sessionId: session.name, path, error: error.message }) }
  }
}
console.log(JSON.stringify({ home, scanned, passed: scanned - problems.length, changedDuringRead, problems }, null, 2))
if (problems.length) process.exitCode = 1
