type Key = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'isComposing'>

export function windowsClipboardAction(e: Key, userAgent: string): 'copy' | 'paste' | null {
  if (!/Windows/i.test(userAgent) || e.isComposing || !e.ctrlKey || e.altKey || e.metaKey) return null
  const key = e.key.toLowerCase()
  if (key === 'c' && e.shiftKey) return 'copy'
  if (key === 'v') return 'paste'
  return null // Bare Ctrl+C must remain a terminal interrupt.
}

export function handleWindowsClipboard(
  e: KeyboardEvent,
  term: { getSelection(): string; paste(text: string): void },
  readClipboard: () => Promise<string>,
): boolean {
  const action = windowsClipboardAction(e, navigator.userAgent)
  if (!action) return false
  e.preventDefault()
  e.stopPropagation()
  if (action === 'copy') {
    const selection = term.getSelection()
    if (selection) void navigator.clipboard.writeText(selection).catch(console.error)
  } else {
    // Use xterm's paste path to preserve bracketed-paste and newline handling.
    void readClipboard().then(text => { if (text) term.paste(text) }).catch(console.error)
  }
  return true
}
