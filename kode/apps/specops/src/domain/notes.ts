import { createHash, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'

import { SpecOpsError } from '../core/errors.js'
import { atomicWrite, pathInside, readText } from '../store/workspace.js'

export type DocumentNoteStatus = 'open' | 'resolved' | 'deprecated'
export type DocumentNoteSource = 'ui' | 'agent' | 'api'

export interface DocumentNote {
  schema_version: 2
  id: string
  document_path: string
  block_id: string
  block_kind: string
  line_start: number | null
  line_end: number | null
  quote: string
  body: string
  source_hash: string
  status: DocumentNoteStatus
  stale: boolean
  created_by: string | null
  source: DocumentNoteSource
  created_at: string
  updated_at: string
}

function noteFile(workspace: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new SpecOpsError('invalid_note_id', `invalid note id: ${id}`)
  return pathInside(workspace, '.specops', 'state', 'notes', `${id}.json`)
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }

async function documentHash(workspace: string, documentPath: string): Promise<string> {
  return hash(await readText(pathInside(workspace, documentPath)))
}

export async function createDocumentNote(workspace: string, input: {
  document_path: string
  block_id: string
  block_kind: string
  line_start: number | null
  line_end: number | null
  quote: string
  body: string
  created_by?: string | null
  source?: DocumentNoteSource
}): Promise<DocumentNote> {
  if (!input.document_path.startsWith('.specops/specs/') && !input.document_path.startsWith('.specops/changes/')) {
    throw new SpecOpsError('invalid_note_path', 'notes can only target canonical SpecOps documents')
  }
  if (input.body.trim() === '') throw new SpecOpsError('invalid_note', 'note body cannot be empty')
  const now = new Date().toISOString()
  const note: DocumentNote = {
    schema_version: 2, id: randomUUID(), document_path: input.document_path,
    block_id: input.block_id, block_kind: input.block_kind,
    line_start: input.line_start, line_end: input.line_end,
    quote: input.quote, body: input.body.trim(), source_hash: await documentHash(workspace, input.document_path),
    status: 'open', stale: false, created_by: input.created_by ?? null,
    source: input.source ?? 'ui', created_at: now, updated_at: now,
  }
  await atomicWrite(noteFile(workspace, note.id), `${JSON.stringify(note, null, 2)}\n`)
  return note
}

function normalizeNote(note: DocumentNote): DocumentNote {
  note.schema_version = 2
  note.created_by ??= null
  note.source ??= 'ui'
  return note
}

export async function readDocumentNote(workspace: string, id: string): Promise<DocumentNote> {
  try { return normalizeNote(JSON.parse(await readText(noteFile(workspace, id))) as DocumentNote) } catch {
    throw new SpecOpsError('note_not_found', `note not found: ${id}`)
  }
}

export async function listDocumentNotes(workspace: string, documentPath?: string): Promise<DocumentNote[]> {
  const directory = pathInside(workspace, '.specops', 'state', 'notes')
  let names: string[]
  try { names = await readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const currentHash = documentPath === undefined ? null : await documentHash(workspace, documentPath).catch(() => null)
  const notes: DocumentNote[] = []
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    try {
      const note = normalizeNote(JSON.parse(await readText(pathInside(directory, name))) as DocumentNote)
      if (documentPath !== undefined && note.document_path !== documentPath) continue
      note.stale = currentHash !== null ? note.source_hash !== currentHash : false
      notes.push(note)
    } catch { /* malformed note is isolated from the rest of the ledger */ }
  }
  return notes.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

export async function setDocumentNoteStatus(workspace: string, id: string, status: Exclude<DocumentNoteStatus, 'open'>): Promise<DocumentNote> {
  const note = await readDocumentNote(workspace, id)
  note.status = status
  note.updated_at = new Date().toISOString()
  await atomicWrite(noteFile(workspace, id), `${JSON.stringify(note, null, 2)}\n`)
  return note
}
