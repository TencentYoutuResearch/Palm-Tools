/** Reacquire Host-scoped services after a generation switch; resume also restores archive membership. */
export async function openSessionTarget(ctx, target, signal, fetchHost) {
  signal.throwIfAborted()
  if (target.resume) {
    await ctx.get('workspaces').unarchiveSession(target.sessionId)
    signal.throwIfAborted()
  }
  // Kode's workbench directory and the native client catalog are published
  // independently. retain(id) only accepts identities admitted on this Host.
  const sessions = ctx.get('sessions')
  const missing = () => sessions?.list && !sessions.list.getSnapshot().byId[target.sessionId]
    && !sessions.subagentAddress?.(target.sessionId)
  if (target.resume || missing()) {
    await sessions.refresh()
    signal.throwIfAborted()
  }
  if (missing() && fetchHost && sessions.handleSessionAdded) {
    const response = await fetchHost('/api/kode/native-sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: target.sessionId, lookupOnly: true }), signal,
    })
    const data = await response.json()
    signal.throwIfAborted()
    if (ctx.get('sessions') !== sessions) throw new Error('会话主机已切换，请重新打开。')
    if (!response.ok || data.summary?.sessionId !== target.sessionId) {
      throw new Error(data.error || '当前主机的 DSH 目录中找不到此会话。')
    }
    sessions.handleSessionAdded(data.summary)
  }
  signal.throwIfAborted()
  const ui = ctx.get('uiWorkspace'), layout = ctx.get('layout')
  if (!ui || !layout) throw new Error('会话视图尚未就绪，请重试。')
  layout.beginNavigation()
  await ui.openSession(target.sessionId)
}

/** The Kode directory can publish workspaces before DSH's client catalog sees them. */
export async function openWorkspaceTarget(ctx, target, signal) {
  signal.throwIfAborted()
  const workspaces = ctx.get('workspaces')
  let { workspaceId } = target
  if (!workspaces.list.getSnapshot().items.some(row => row.workspaceId === workspaceId) && target.workspacePath) {
    // DSH resolves existing paths on the selected Host and admits the result
    // to its client catalog before returning.
    const workspace = await workspaces.create({ path: target.workspacePath })
    signal.throwIfAborted()
    workspaceId = workspace.workspaceId
  }
  const ui = ctx.get('uiWorkspace')
  if (target.startSession) return ui.startSession(workspaceId, target.options)
  return ui.openWorkspace(workspaceId)
}
