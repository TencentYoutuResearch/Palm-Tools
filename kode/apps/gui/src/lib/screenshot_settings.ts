export type ScreenshotShortcut = 'cmd-shift-s' | 'cmd-shift-k' | 'cmd-alt-s' | 'disabled'
export type ScreenshotMode = 'window' | 'area'

const SCREENSHOT_SHORTCUT_KEY = 'kode.screenshot.shortcut'
const SCREENSHOT_MODE_KEY = 'kode.screenshot.mode'

export const SCREENSHOT_SETTINGS_EVENT = 'kode:screenshot-settings-changed'

export type ScreenshotSettings = {
  shortcut: ScreenshotShortcut
  mode: ScreenshotMode
}

export type ScreenshotSettingsChangedDetail = ScreenshotSettings

export const SCREENSHOT_SHORTCUT_OPTIONS: Array<{ value: ScreenshotShortcut; label: string }> = [
  { value: 'cmd-shift-s', label: 'Cmd/Ctrl+Shift+S' },
  { value: 'cmd-shift-k', label: 'Cmd/Ctrl+Shift+K' },
  { value: 'cmd-alt-s', label: 'Cmd/Ctrl+Option/Alt+S' },
  { value: 'disabled', label: 'Disabled' },
]

export const SCREENSHOT_MODE_OPTIONS: Array<{ value: ScreenshotMode; label: string }> = [
  { value: 'window', label: 'Current window' },
  { value: 'area', label: 'Global area' },
]

function normalizeShortcut(value: string | null | undefined): ScreenshotShortcut {
  return value === 'cmd-shift-s' || value === 'cmd-shift-k' || value === 'cmd-alt-s' || value === 'disabled'
    ? value
    : 'cmd-shift-s'
}

function normalizeMode(value: string | null | undefined): ScreenshotMode {
  return value === 'window' || value === 'area' ? value : 'window'
}

export function loadScreenshotSettings(): ScreenshotSettings {
  try {
    return {
      shortcut: normalizeShortcut(localStorage.getItem(SCREENSHOT_SHORTCUT_KEY)),
      mode: normalizeMode(localStorage.getItem(SCREENSHOT_MODE_KEY)),
    }
  } catch {
    return { shortcut: 'cmd-shift-s', mode: 'window' }
  }
}

export function saveScreenshotSettings(next: ScreenshotSettings): ScreenshotSettings {
  const normalized: ScreenshotSettings = {
    shortcut: normalizeShortcut(next.shortcut),
    mode: normalizeMode(next.mode),
  }
  try {
    localStorage.setItem(SCREENSHOT_SHORTCUT_KEY, normalized.shortcut)
    localStorage.setItem(SCREENSHOT_MODE_KEY, normalized.mode)
  } catch {}
  dispatchScreenshotSettingsChanged(normalized)
  return normalized
}

export function screenshotShortcutLabel(shortcut: ScreenshotShortcut): string {
  return SCREENSHOT_SHORTCUT_OPTIONS.find((option) => option.value === shortcut)?.label ?? 'Cmd/Ctrl+Shift+S'
}

export function screenshotShortcutMatches(event: KeyboardEvent, shortcut: ScreenshotShortcut): boolean {
  if (!(event.metaKey || event.ctrlKey)) return false
  if (shortcut === 'disabled') return false
  if (shortcut === 'cmd-shift-s') {
    return event.code === 'KeyS' && event.shiftKey && !event.altKey
  }
  if (shortcut === 'cmd-shift-k') {
    return event.code === 'KeyK' && event.shiftKey && !event.altKey
  }
  return event.code === 'KeyS' && event.altKey && !event.shiftKey
}

export function dispatchScreenshotSettingsChanged(settings = loadScreenshotSettings()) {
  window.dispatchEvent(
    new CustomEvent<ScreenshotSettingsChangedDetail>(SCREENSHOT_SETTINGS_EVENT, {
      detail: settings,
    }),
  )
}

export function onScreenshotSettingsChanged(
  callback: (detail: ScreenshotSettingsChangedDetail) => void,
): () => void {
  const handler = (event: Event) =>
    callback((event as CustomEvent<ScreenshotSettingsChangedDetail>).detail)
  window.addEventListener(SCREENSHOT_SETTINGS_EVENT, handler)
  return () => window.removeEventListener(SCREENSHOT_SETTINGS_EVENT, handler)
}
