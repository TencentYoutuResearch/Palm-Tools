/** Reacquire Host-scoped services after a generation switch; resume also restores archive membership. */
export async function openSessionTarget(ctx, target, signal) {
  signal.throwIfAborted()
  if (target.resume) {
    await ctx.get('workspaces').unarchiveSession(target.sessionId)
    signal.throwIfAborted()
    await ctx.get('sessions').refresh()
  }
  signal.throwIfAborted()
  const ui = ctx.get('uiWorkspace'), layout = ctx.get('layout')
  if (!ui || !layout) throw new Error('会话视图尚未就绪，请重试。')
  layout.beginNavigation()
  ui.openSession(target.sessionId)
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
