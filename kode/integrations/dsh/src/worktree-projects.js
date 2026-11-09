/** Worktree checkout identities stay internal; project directories group them under their owner. */
import { BackendDocument } from './backend-state.js'

export function groupWorktreeProjects(workspaces, parents = {}) {
  const rootOf = id => {
    const seen = new Set()
    while (parents[id] && !seen.has(id)) { seen.add(id); id = parents[id] }
    return seen.has(id) ? undefined : id
  }
  const byId = new Map(workspaces.map(row => [row.id ?? row.workspaceId, { ...row, sessionIds: [...row.sessionIds] }]))
  const hidden = new Set()
  for (const row of workspaces) {
    const id = row.id ?? row.workspaceId, root = rootOf(id), parent = byId.get(root)
    if (!parent || root === id) continue
    parent.sessionIds = [...new Set([...parent.sessionIds, ...row.sessionIds])]
    hidden.add(id)
  }
  return [...byId].filter(([id]) => !hidden.has(id)).map(([, row]) => row)
}

export async function rememberWorktreeProject(client, childId, parentId) {
  const document = new BackendDocument(client, 'session-index')
  for (let attempt = 0; attempt < 6; attempt++) {
    const index = await document.read() ?? { version: 1 }
    const parents = index.worktreeParents ?? {}, seen = new Set([childId])
    while (parents[parentId]) {
      if (seen.has(parentId)) throw new Error('Worktree project ownership is cyclic')
      seen.add(parentId); parentId = parents[parentId]
    }
    if (parentId === childId) throw new Error('Worktree cannot own its parent project')
    if (parents[childId] && parents[childId] !== parentId) throw new Error('Worktree already belongs to another project')
    index.worktreeParents = { ...parents, [childId]: parentId }
    try { await document.write(index); return index.worktreeParents }
    catch (error) { if (attempt === 5 || !/configuration changed/.test(error.message)) throw error }
  }
}
