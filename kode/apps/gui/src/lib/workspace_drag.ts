export type WorkspaceReference = { path: string; endpointId: string | null }

/** App-local dragging must not depend on WebView HTML5/OS drag interoperability. */
export function workspaceFileDrag(node: HTMLElement, reference: WorkspaceReference) {
  let stop = () => {}
  let suppressClick = false
  function down(start: PointerEvent) {
    if (start.button !== 0 || !start.isPrimary || start.pointerType === 'touch') return
    stop()
    suppressClick = false
    const source = { ...reference }
    let dragging = false
    let target: HTMLElement | null = null
    let directory: string | undefined
    const hover = (next: HTMLElement | null) => {
      if (target === next) return
      target?.classList.remove('workspace-drop-active')
      target?.dispatchEvent(new CustomEvent('workspace-reference-hover', { detail: false }))
      target = next
      target?.classList.add('workspace-drop-active')
      target?.dispatchEvent(new CustomEvent('workspace-reference-hover', { detail: true }))
    }
    const locate = (event: PointerEvent) => {
      const hit = document.elementFromPoint(event.clientX, event.clientY)
      const files = hit?.closest<HTMLElement>('[data-workspace-files]')
      directory = hit?.closest<HTMLElement>('[data-drop-directory]')?.dataset.dropDirectory
      hover(files ?? hit?.closest<HTMLElement>('[data-workspace-reference-target]') ?? null)
    }
    const move = (event: PointerEvent) => {
      if (event.pointerId !== start.pointerId) return
      if (!dragging && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 6) return
      dragging = true
      suppressClick = true
      event.preventDefault()
      window.getSelection()?.removeAllRanges()
      locate(event)
    }
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== start.pointerId) return
      if (dragging) {
        event.preventDefault()
        locate(event)
        if (target?.hasAttribute('data-workspace-files')) {
          target.dispatchEvent(new CustomEvent('workspace-files-drop', {
            detail: { paths: [source.path], directory, endpointId: source.endpointId, external: false },
          }))
        } else target?.dispatchEvent(new CustomEvent('workspace-reference-drop', { detail: source }))
      }
      stop()
    }
    const cancel = (event: PointerEvent) => { if (event.pointerId === start.pointerId) stop() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); stop() } }
    stop = () => {
      hover(null)
      window.removeEventListener('pointermove', move, { capture: true })
      window.removeEventListener('pointerup', finish, { capture: true })
      window.removeEventListener('pointercancel', cancel, { capture: true })
      window.removeEventListener('keydown', escape, { capture: true })
      window.removeEventListener('blur', stop)
    }
    window.addEventListener('pointermove', move, { capture: true, passive: false })
    window.addEventListener('pointerup', finish, { capture: true })
    window.addEventListener('pointercancel', cancel, { capture: true })
    window.addEventListener('keydown', escape, { capture: true })
    window.addEventListener('blur', stop)
  }
  // Prevent native drag takeover and the click generated after releasing a drag.
  const nativeDrag = (event: DragEvent) => event.preventDefault()
  const click = (event: MouseEvent) => {
    if (suppressClick && event.detail !== 0) {
      suppressClick = false
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }
  node.addEventListener('pointerdown', down)
  node.addEventListener('dragstart', nativeDrag)
  node.addEventListener('click', click, { capture: true })
  return {
    update(next: WorkspaceReference) { reference = next },
    destroy() {
      stop()
      node.removeEventListener('pointerdown', down)
      node.removeEventListener('dragstart', nativeDrag)
      node.removeEventListener('click', click, { capture: true })
    },
  }
}

export function workspaceReferenceTarget(node: HTMLElement, handlers: {
  hover: (active: boolean) => void
  drop: (reference: WorkspaceReference) => void
}) {
  const hover = (event: Event) => handlers.hover((event as CustomEvent<boolean>).detail)
  const drop = (event: Event) => handlers.drop((event as CustomEvent<WorkspaceReference>).detail)
  node.addEventListener('workspace-reference-hover', hover)
  node.addEventListener('workspace-reference-drop', drop)
  return { destroy() {
    node.removeEventListener('workspace-reference-hover', hover)
    node.removeEventListener('workspace-reference-drop', drop)
  } }
}
