/** Cold, owner-only workspace metadata. Reading the sidebar never resumes an Agent. */
import { BackendDocument } from './backend-state.js'
import { importedSessionId, localSavedTabs, savedDirectoryId, savedSessionOperation } from './saved-session-state.js'
export const DIRECTORY_PATH = '/api/kode/host-directory'
export async function hostDirectory(ctx, config = {}) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry) throw new Error('工作区服务尚未就绪。')
  const { items } = await ctx.sessionController.list({})
  const runtime = ctx.get('kodeAgents'), profiles = runtime?.profiles
  const hiddenSessionIds = []
  const sessions = items.flatMap(item => {
    const values = item.projections?.values ?? {}, model = values.modelSelection
    const binding = profiles?.binding(item.sessionId)
    const provider = model?.next?.provider ?? model?.lastUsed?.provider
    const dsh = binding ? binding.profile.type === 'dsh' : !provider?.startsWith('kode-agent-')
    const type = binding?.profile.type ?? (dsh ? 'dsh' : undefined)
    if (type && runtime?.hasRuntime && !runtime.hasRuntime(type) && !item.blank) { hiddenSessionIds.push(item.sessionId); return [] }
    if (item.blank) return []
    return [{ id: item.sessionId, title: values.title || '未命名会话', cwd: item.cwd, updatedAt: item.updatedAt, running: item.running, ...(binding?.threadId ? { nativeThreadId: binding.threadId } : {}) }]
  })
  const result = { archivedSessionIds: [...registry.archivedSessionIds], pinnedSessionIds: [...(registry.pinnedSessionIds ?? [])], hiddenSessionIds, sessions,
    workspaces: registry.list().map(w => ({ id: w.id, title: w.title, path: w.path, sessionIds: [...w.sessionIds], createdAt: w.createdAt, updatedAt: w.updatedAt })) }
  if (config.backendClient) {
    const client = config.backendClient
    const [index, workspaces, node] = await Promise.all([new BackendDocument(client, 'session-index').read(), new BackendDocument(client, 'workspaces').read(), client.call('/api/v1/messaging/node')])
    if (workspaces?.global) { result.archivedSessionIds = [...workspaces.global.archivedSessionIds]; result.pinnedSessionIds = [...(workspaces.global.pinnedSessionIds ?? [])] }
    for (const tab of localSavedTabs(index)) {
      const adopted = tab.dsh_session_id ?? importedSessionId(tab)
      if (sessions.some(row => row.id === adopted)) continue
      const id = savedDirectoryId(node.node_id, tab)
      sessions.push({ id, title: tab.title || '已保存的会话', cwd: tab.cwd, updatedAt: 0, running: false, nativeThreadId: tab.session_id, savedTab: tab })
      const workspace = result.workspaces.find(workspace => workspace.path === tab.cwd)
      if (workspace) workspace.sessionIds.push(id)
      if (result.archivedSessionIds.includes(adopted)) result.archivedSessionIds.push(id)
      if (result.pinnedSessionIds.includes(adopted)) result.pinnedSessionIds.push(id)
    }
  }
  return result
}
export async function hostOperation(ctx, input, config = {}) {
  if (input.nativeSession) {
    if (!config.backendClient) throw new Error('Kode 会话存储尚未就绪。')
    return savedSessionOperation(config.backendClient, input)
  }
  const args = input.args ?? {}
  const allowed = { 'rename-workspace': 'rename', 'delete-workspace': 'delete', 'reorder-workspace': 'insertBefore', 'archive-session': 'archiveSession', 'unarchive-session': 'unarchiveSession', 'pin-session': 'pinSession', 'unpin-session': 'unpinSession' }
  if (input.operation === 'rename-session') return ctx.sessionController.rename({ sessionId: args.sessionId, title: args.title })
  if (!Object.hasOwn(allowed, input.operation)) throw new Error('未知目录操作。')
  const controller = ctx.get('workspaceController')
  if (!controller) throw new Error('工作区服务尚未就绪。')
  const request = input.operation.endsWith('workspace') ? { workspaceId: args.workspaceId, ...(input.operation === 'rename-workspace' ? { title: args.title } : {}), ...(input.operation === 'reorder-workspace' && args.beforeWorkspaceId ? { beforeWorkspaceId: args.beforeWorkspaceId } : {}) } : { sessionId: args.sessionId }
  return controller[allowed[input.operation]](request)
}
export function registerHostDirectory(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: DIRECTORY_PATH, handler: async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'GET or POST required' })
    try {
      if (req.method === 'POST') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON required' })
        let body = ''; for await (const part of req) { body += part; if (Buffer.byteLength(body) > 16384) throw new Error('请求过长。') }
        await hostOperation(ctx, JSON.parse(body), config)
      }
      send(200, await hostDirectory(ctx, config))
    } catch (error) { send(503, { error: error.message }) }
  } })
}
