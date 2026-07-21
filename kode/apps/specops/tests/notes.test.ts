import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createDocumentNote, listDocumentNotes, readDocumentNote, setDocumentNoteStatus } from '../src/domain/notes.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('document notes', () => {
  it('persists anchors, detects stale documents, and resolves notes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'specops-notes-'))
    roots.push(root)
    await mkdir(path.join(root, '.specops', 'specs'), { recursive: true })
    await writeFile(path.join(root, '.specops', 'specs', 'demo.md'), '# Demo\n\nOriginal')
    const note = await createDocumentNote(root, {
      document_path: '.specops/specs/demo.md', block_id: 'block-demo', block_kind: 'markdown',
      line_start: 3, line_end: 3, quote: 'Original', body: 'Keep this behavior',
      created_by: 'alice', source: 'ui',
    })
    expect((await listDocumentNotes(root, '.specops/specs/demo.md'))[0]).toMatchObject({ id: note.id, stale: false, status: 'open', created_by: 'alice', source: 'ui' })
    await writeFile(path.join(root, '.specops', 'specs', 'demo.md'), '# Demo\n\nChanged')
    expect((await listDocumentNotes(root, '.specops/specs/demo.md'))[0]?.stale).toBe(true)
    await setDocumentNoteStatus(root, note.id, 'resolved')
    expect((await listDocumentNotes(root, '.specops/specs/demo.md'))[0]?.status).toBe('resolved')
  })

  it('normalizes legacy notes without author metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'specops-notes-'))
    roots.push(root)
    const directory = path.join(root, '.specops', 'state', 'notes')
    await mkdir(directory, { recursive: true })
    const id = '11111111-1111-1111-1111-111111111111'
    await writeFile(path.join(directory, `${id}.json`), `${JSON.stringify({
      schema_version: 1, id, document_path: '.specops/specs/demo.md', block_id: 'demo', block_kind: 'markdown',
      line_start: null, line_end: null, quote: '', body: 'legacy', source_hash: 'hash', status: 'open', stale: false,
      created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z',
    })}\n`)
    await expect(readDocumentNote(root, id)).resolves.toMatchObject({ schema_version: 2, created_by: null, source: 'ui' })
  })
})
