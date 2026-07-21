import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { archiveChange, initWorkspace, markChangeCompleted } from '../src/domain/commands.js'
import { parseDocument, serializeDocument, type SpecDocument } from '../src/domain/spec.js'
import { gitCommit, gitWorkspace } from './helpers.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })))
})

async function fixture() {
  const workspace = await gitWorkspace()
  const cache = await mkdtemp(path.join(os.tmpdir(), 'specops-cache-'))
  cleanup.push(workspace, cache)
  await initWorkspace(workspace)
  await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1')
  return { workspace, cache }
}

/** Write a `.specops/changes/<id>/proposal.md` with the given frontmatter status. */
async function writeProposal(workspace: string, changeId: string, status: 'proposed' | 'completed' | 'archived'): Promise<string> {
  const folder = path.join(workspace, '.specops', 'changes', changeId)
  await mkdir(folder, { recursive: true })
  const doc: SpecDocument = {
    frontmatter: { schema_version: 1, id: changeId, kind: 'change', title: `Change ${changeId}`, status },
    body: `# ${changeId}\n\nBody.\n`,
    relativePath: `.specops/changes/${changeId}/proposal.md`,
  }
  const proposalPath = path.join(folder, 'proposal.md')
  await writeFile(proposalPath, serializeDocument(doc))
  return proposalPath
}

async function readProposalStatus(workspace: string, changeId: string, archiveFolder?: string): Promise<string> {
  const base = archiveFolder !== undefined
    ? path.join(workspace, '.specops', 'changes', 'archive', archiveFolder)
    : path.join(workspace, '.specops', 'changes', changeId)
  const proposalPath = path.join(base, 'proposal.md')
  return parseDocument(await readFile(proposalPath, 'utf8'), proposalPath).frontmatter.status
}

describe('markChangeCompleted', () => {
  test('flips a proposed change to completed', async () => {
    const { workspace } = await fixture()
    const changeId = 'fix-foo'
    await writeProposal(workspace, changeId, 'proposed')
    await markChangeCompleted(workspace, changeId)
    expect(await readProposalStatus(workspace, changeId)).toBe('completed')
  })

  test('no-ops silently when no matching folder is found', async () => {
    const { workspace } = await fixture()
    // No proposal created — must not throw.
    await expect(markChangeCompleted(workspace, 'does-not-exist')).resolves.toBeUndefined()
  })

  test('does not regress an already-completed proposal (no write)', async () => {
    const { workspace } = await fixture()
    const changeId = 'already-done'
    const proposalPath = await writeProposal(workspace, changeId, 'completed')
    const before = await readFile(proposalPath, 'utf8')
    await markChangeCompleted(workspace, changeId)
    const after = await readFile(proposalPath, 'utf8')
    expect(after).toBe(before)
  })

  test('skips archived folders', async () => {
    const { workspace } = await fixture()
    const changeId = 'archived-one'
    // Place a proposal directly under changes/archive/ — it must NOT be touched.
    const archivedFolder = path.join(workspace, '.specops', 'changes', 'archive', '2026-01-01-archived-one')
    await mkdir(archivedFolder, { recursive: true })
    const doc: SpecDocument = {
      frontmatter: { schema_version: 1, id: changeId, kind: 'change', title: 'x', status: 'archived' },
      body: '',
      relativePath: '.specops/changes/archive/2026-01-01-archived-one/proposal.md',
    }
    await writeFile(path.join(archivedFolder, 'proposal.md'), serializeDocument(doc))
    await markChangeCompleted(workspace, changeId)
    // Stays archived — did not regress to completed.
    expect(await readProposalStatus(workspace, changeId, '2026-01-01-archived-one')).toBe('archived')
  })
})

describe('archiveChange', () => {
  test('archives a completed change and writes status archived', async () => {
    const { workspace } = await fixture()
    const changeId = 'fix-bar'
    await writeProposal(workspace, changeId, 'completed')
    const result = await archiveChange(workspace, changeId)
    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual([])
    const status = await readProposalStatus(workspace, changeId, result.data!.to.split('/').slice(-1)[0]!)
    expect(status).toBe('archived')
  })

  test('archives a proposed change but emits a warning diagnostic', async () => {
    const { workspace } = await fixture()
    const changeId = 'legacy-proposed'
    await writeProposal(workspace, changeId, 'proposed')
    const result = await archiveChange(workspace, changeId)
    expect(result.ok).toBe(true)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]!.severity).toBe('warning')
    expect(result.diagnostics[0]!.code).toBe('archive_not_completed')
    const status = await readProposalStatus(workspace, changeId, result.data!.to.split('/').slice(-1)[0]!)
    expect(status).toBe('archived')
  })

  test('archives an already-completed change with no warning', async () => {
    const { workspace } = await fixture()
    const changeId = 'done-change'
    await writeProposal(workspace, changeId, 'completed')
    const result = await archiveChange(workspace, changeId)
    expect(result.ok).toBe(true)
    expect(result.diagnostics.some((d) => d.code === 'archive_not_completed')).toBe(false)
  })

  test('returns 404 when change is not found', async () => {
    const { workspace } = await fixture()
    const result = await archiveChange(workspace, 'no-such-change')
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]!.code).toBe('change_not_found')
  })
})
