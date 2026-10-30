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
