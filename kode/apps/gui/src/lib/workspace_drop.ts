export type WorkspaceDrop = { paths: string[]; directory?: string }
export function workspaceDropTarget(node: HTMLElement, receive: (drop: WorkspaceDrop) => void) {
  const listener = (event: Event) => receive((event as CustomEvent<WorkspaceDrop>).detail)
  node.addEventListener('workspace-files-drop', listener)
  return { destroy() { node.removeEventListener('workspace-files-drop', listener) } }
}
export function routeWorkspaceNativeDrop(payload: { type: string; paths?: string[]; position?: { x: number; y: number } }): boolean {
  document.querySelectorAll('.workspace-drop-active').forEach(node => node.classList.remove('workspace-drop-active'))
  if (!payload.position || payload.type === 'leave') return false
  const hit = document.elementFromPoint(payload.position.x / window.devicePixelRatio, payload.position.y / window.devicePixelRatio)
  const pane = hit?.closest<HTMLElement>('[data-workspace-files]')
  if (!pane) return false
  const target = hit?.closest<HTMLElement>('[data-drop-directory]') ?? pane
  if (payload.type === 'drop') {
    pane.dispatchEvent(new CustomEvent<WorkspaceDrop>('workspace-files-drop', {
      detail: { paths: payload.paths ?? [], directory: target.dataset.dropDirectory },
    }))
  } else target.classList.add('workspace-drop-active')
  return true
}
