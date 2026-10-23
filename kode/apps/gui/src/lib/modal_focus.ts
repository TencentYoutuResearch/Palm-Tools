/** Trap modal keyboard focus and restore the invoking control on close. */
export function modalFocus(node: HTMLElement) {
  const previous = document.activeElement as HTMLElement | null
  const siblings: Array<[HTMLElement, boolean]> = []
  let branch: HTMLElement = node
  while (branch.parentElement && branch.parentElement !== document.documentElement) {
    for (const sibling of branch.parentElement.children) {
      if (sibling !== branch && sibling instanceof HTMLElement) {
        siblings.push([sibling, sibling.inert]); sibling.inert = true
      }
    }
    branch = branch.parentElement
  }
  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Tab') return
    const controls = [...node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')]
    if (!controls.length) { event.preventDefault(); node.focus(); return }
    const first = controls[0], last = controls[controls.length - 1]
    if (event.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) {
      event.preventDefault(); last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) {
      event.preventDefault(); first.focus()
    }
  }
  node.addEventListener('keydown', keydown)
  return { destroy() { node.removeEventListener('keydown', keydown); for (const [sibling, inert] of siblings) sibling.inert = inert; if (previous?.isConnected) previous.focus() } }
}
