/** Private disk archive, committed before removing an acknowledged queue entry. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, link, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
const digest = value => createHash('sha256').update(value).digest('hex')
export class OfficialToolArchive {
  constructor(profilePath) { this.root = `${profilePath}.tool-archive` }
  path(session, call) { return join(this.root, `${digest(JSON.stringify([session, call]))}.json`) }
  async assertAvailable(metadata) {
    if (!metadata) return
    if (metadata.root !== this.root || metadata.version !== 1) throw new Error('Tool archive identity changed')
    if ((await readFile(join(this.root, 'identity'), 'utf8')) !== metadata.identity) throw new Error('Tool archive unavailable')
  }
  async contains(session, call) {
    try { await readFile(this.path(session, call)); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }
  async create(metadata) {
    if (metadata) { await this.assertAvailable(metadata); return metadata }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const identity = randomUUID()
    await this.immutable(join(this.root, 'identity'), identity, false)
    return { version: 1, root: this.root, identity: await readFile(join(this.root, 'identity'), 'utf8'), count: 0 }
  }
  async immutable(path, body, compare = true) {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(body); await file.sync() } finally { await file.close() }
      try { await link(temporary, path) } catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (compare && await readFile(path, 'utf8') !== body) throw new Error('Tool archive record conflict')
      }
      const directory = await open(this.root, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  async put(session, row) {
    await this.immutable(this.path(session, row.call_id), JSON.stringify({ version: 1, session_id: session, evidence: row }))
  }
}
