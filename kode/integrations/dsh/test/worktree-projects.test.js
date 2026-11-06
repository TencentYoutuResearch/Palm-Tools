import test from 'node:test'
import assert from 'node:assert/strict'
import { groupWorktreeProjects, rememberWorktreeProject } from '../src/worktree-projects.js'
import { hostDirectory } from '../src/workspace-directory.js'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const projects = [
  { id: 'project', title: 'Project', path: '/srv/project', sessionIds: ['main'] },
  { id: 'checkout', title: 'Internal checkout', path: '/srv/worktree', sessionIds: ['work'] },
  { id: 'nested', title: 'Nested checkout', path: '/srv/nested', sessionIds: ['nested-work', 'work'] },
  { id: 'other', title: 'Other project', path: '/srv/other', sessionIds: ['unrelated'] },
]
const parents = { checkout: 'project', nested: 'checkout' }
test('project grouping retains worktree sessions across hosts/reloads without changing execution paths', async () => {
  const before = structuredClone(projects), grouped = groupWorktreeProjects(projects, parents)
  assert.deepEqual(grouped.map(row => row.id), ['project', 'other'])
  assert.deepEqual(grouped[0].sessionIds, ['main', 'work', 'nested-work'])
  assert.equal(grouped[0].path, '/srv/project'); assert.deepEqual(projects, before)
  const source = await readFile(new URL('../src/agent-client.js', import.meta.url), 'utf8'), scope = {}
  vm.runInNewContext(source.slice(0, source.indexOf('function resumeCandidates(')), scope)
  const clientRows = projects.map(({ id, ...row }) => ({ workspaceId: id, ...row }))
  const rendered = scope.groupProjectWorkspaces(clientRows, parents)
  assert.deepEqual(JSON.parse(JSON.stringify(rendered)), grouped.map(({ id, ...row }) => ({ workspaceId: id, ...row })))
  assert.equal(groupWorktreeProjects(projects, { checkout: 'missing' }).length, 4, 'missing owners do not hide their checkouts')
  assert.equal(groupWorktreeProjects(projects, { checkout: 'nested', nested: 'checkout' }).length, 4, 'cyclic ownership cannot hide projects')
})

test('ownership is durable in the existing document and merges concurrent edits while retaining other session metadata', async () => {
  let value = { imports: { original: { threadId: 'original-thread' } } }, conflict = true
  const client = { call: async (_path, update) => {
    if (!update) return { revision: 1, value: structuredClone(value) }
    if (conflict) { conflict = false; value.worktreeParents = { other: 'project' }; throw new Error('configuration changed') }
    value = structuredClone(update.value); return { revision: 2, value }
  } }
  await rememberWorktreeProject(client, 'checkout', 'project')
  assert.deepEqual(value.worktreeParents, { other: 'project', checkout: 'project' })
  await rememberWorktreeProject(client, 'nested', 'checkout')
  assert.equal(value.worktreeParents.nested, 'project')
  assert.equal(value.imports.original.threadId, 'original-thread')
  await assert.rejects(rememberWorktreeProject(client, 'project', 'checkout'), /parent project|cyclic/)
  await assert.rejects(rememberWorktreeProject(client, 'checkout', 'unrelated'), /another project/)
})

test('cold host directory exposes a single parent project with worktree execution cwd intact', async () => {
  const registry = { list: () => projects, archivedSessionIds: [] }
  const rows = [{ sessionId: 'work', cwd: '/srv/worktree', blank: false, projections: { values: { title: 'Worktree task' } } }]
  const ctx = { get: key => key === 'workspaceRegistry' ? registry : key === 'sessionController' ? { list: async () => ({ items: rows }) } : undefined }
  const backendClient = { call: async path => path.endsWith('/node') ? { node_id: 'fixture' } : { revision: 1, value: path.endsWith('/session-index') ? { worktreeParents: parents } : { global: { archivedSessionIds: [] } } } }
  const value = await hostDirectory(ctx, { backendClient })
  assert.equal(value.workspaces.length, 2)
  assert.ok(value.workspaces[0].sessionIds.includes('work'))
  assert.equal(value.sessions[0].cwd, '/srv/worktree')
  assert.deepEqual(value.worktreeParents, parents)
})
