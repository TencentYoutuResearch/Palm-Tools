type OutsidePressCloseParams = {
  onClose: () => void
  disabled?: boolean
}

export function outsidePressClose(node: HTMLElement, params: OutsidePressCloseParams) {
  let current = params
  let pressedOutside = false

  function isBackdropEvent(e: PointerEvent): boolean {
    return e.target === node
  }

  function onPointerDown(e: PointerEvent) {
    pressedOutside = !current.disabled && isBackdropEvent(e)
  }

  function onPointerUp(e: PointerEvent) {
    const shouldClose = pressedOutside && !current.disabled && isBackdropEvent(e)
    pressedOutside = false
    if (shouldClose) current.onClose()
  }

  function onPointerCancel() {
    pressedOutside = false
  }

  node.addEventListener('pointerdown', onPointerDown)
  node.addEventListener('pointerup', onPointerUp)
  node.addEventListener('pointercancel', onPointerCancel)

  return {
    update(next: OutsidePressCloseParams) {
      current = next
    },
    destroy() {
      node.removeEventListener('pointerdown', onPointerDown)
      node.removeEventListener('pointerup', onPointerUp)
      node.removeEventListener('pointercancel', onPointerCancel)
    },
  }
}

export function outsideElementPressClose(node: HTMLElement, params: OutsidePressCloseParams) {
  let current = params
  let pressedOutside = false

  function isOutside(e: PointerEvent): boolean {
    return e.target instanceof Node && !node.contains(e.target)
  }

  function onPointerDown(e: PointerEvent) {
    pressedOutside = !current.disabled && isOutside(e)
  }

  function onPointerUp(e: PointerEvent) {
    const shouldClose = pressedOutside && !current.disabled && isOutside(e)
    pressedOutside = false
    if (shouldClose) current.onClose()
  }

  function onPointerCancel() {
    pressedOutside = false
  }

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('pointerup', onPointerUp, true)
  document.addEventListener('pointercancel', onPointerCancel, true)

  return {
    update(next: OutsidePressCloseParams) {
      current = next
    },
    destroy() {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', onPointerCancel, true)
    },
  }
}
