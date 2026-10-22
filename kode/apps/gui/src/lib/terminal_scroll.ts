export function terminalScrollSensitivity(backendKey: string): number {
  return ['claude', 'tclaude', 'claude-code', 'claudecode', 'claude-internal'].includes(backendKey)
    ? 3
    : 1
}

type ScrollEvent = Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'shiftKey' | 'altKey' | 'ctrlKey'>

type ScrollOptions = {
  scrollSensitivity?: number
  fastScrollSensitivity?: number
  fastScrollModifier?: 'alt' | 'ctrl' | 'shift'
}

export function terminalWheelDelta(
  event: ScrollEvent,
  rowHeight: number,
  viewportHeight: number,
  options: ScrollOptions,
): number {
  if (event.deltaY === 0 || event.shiftKey) return 0
  const pixels = event.deltaMode === 1
    ? event.deltaY * rowHeight
    : event.deltaMode === 2
      ? event.deltaY * viewportHeight
      : event.deltaY
  const modifier = options.fastScrollModifier ?? 'alt'
  const fast = (modifier === 'alt' && event.altKey) || (modifier === 'ctrl' && event.ctrlKey)
  return pixels * (options.scrollSensitivity ?? 1)
    * (fast ? options.fastScrollSensitivity ?? 5 : 1)
}
