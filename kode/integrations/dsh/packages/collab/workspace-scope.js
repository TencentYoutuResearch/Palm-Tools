/** Canonical scope comes from the registered workspace catalogue, never a title or path prefix. */
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
export const validWorkspaceScope = value => !!value && id(value.home_hub) && id(value.host_id) && id(value.workspace_id)
  && typeof value.root_ref === 'string' && value.root_ref.trim().length > 0 && new TextEncoder().encode(value.root_ref).length <= 1024 && !value.root_ref.includes('\0')
export const workspaceScopeKey = value => validWorkspaceScope(value) ? JSON.stringify([value.home_hub,value.host_id,value.workspace_id,value.root_ref]) : null
export const sameWorkspace = (a,b) => workspaceScopeKey(a) !== null && workspaceScopeKey(a) === workspaceScopeKey(b)
export const teamInWorkspace = (team,scope) => validWorkspaceScope(scope) && team?.home_hub === scope.home_hub
  && team.spec?.workspace_refs?.some(ref => ref.host_id === scope.host_id && ref.workspace_id === scope.workspace_id && ref.root_ref === scope.root_ref) === true
/** Overview links use the authorized selected project, not an inferred team default. */
export function teamProjectPointer(team, selected, catalogue) {
  if (!catalogue?.ready || !teamInWorkspace(team, selected)) return null
  const matches = (catalogue.scopes ?? []).filter(row => sameWorkspace(row, selected))
  return matches.length === 1 ? matches[0] : null
}
export function registeredWorkspaceScopes(native, directory, home) {
  const scopes = new Map()
  for (const host of directory?.hosts ?? []) for (const workspace of host.workspaces ?? []) {
    const value = {home_hub:home,host_id:host.nodeId,workspace_id:workspace.id,root_ref:workspace.path}
    if (!validWorkspaceScope(value)) continue
    const rowId = host.id === directory.current ? workspace.id : `kode-host:${encodeURIComponent(host.id)}/${encodeURIComponent(workspace.id)}`
    scopes.set(rowId,{...value,rowId,title:workspace.title})
  }
  // The local native controller is authoritative even before Kode's cold directory returns.
  for (const workspace of native?.items ?? []) {
    if((directory&&directory.current!=='local')||scopes.has(workspace.workspaceId) || workspace.workspaceId?.startsWith('kode-host:')) continue
    const value={home_hub:home,host_id:home,workspace_id:workspace.workspaceId,root_ref:workspace.path}
    if(validWorkspaceScope(value)) scopes.set(workspace.workspaceId,{...value,rowId:workspace.workspaceId,title:workspace.title})
  }
  return [...scopes.values()]
}
