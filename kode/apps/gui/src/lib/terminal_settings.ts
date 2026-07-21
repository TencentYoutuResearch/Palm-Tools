export type TerminalTarget = 'pty' | 'shell'
export type TerminalThemeMode = 'system' | 'light' | 'dark'

export const TERMINAL_FONT_SIZE_MIN = 8
export const TERMINAL_FONT_SIZE_MAX = 32
export const TERMINAL_FONT_SIZE_DEFAULT = 13

export const TERMINAL_FONT_PRESETS = [
  'SF Mono',
  'JetBrains Mono',
  'Menlo',
  'Monaco',
  'Courier New',
  'Fira Code',
  'Cascadia Code',
  'IBM Plex Mono',
  'Source Code Pro',
  'Hack',
  'Meslo LG M',
  'monospace',
]

const PTY_FONT_SIZE_KEY = 'kode.terminal.fontSize'
const PTY_FONT_FAMILY_KEY = 'kode.terminal.fontFamily'
const PTY_THEME_KEY = 'kode.terminal.themeMode'
const SHELL_FONT_SIZE_KEY = 'kode.shellTerminal.fontSize'
const SHELL_FONT_FAMILY_KEY = 'kode.shellTerminal.fontFamily'
const SHELL_THEME_KEY = 'kode.shellTerminal.themeMode'

export const TERMINAL_SETTINGS_EVENT = 'kode:terminal-settings-changed'

export type TerminalAppearance = {
  fontFamily: string
  fontSize: number
  themeMode: TerminalThemeMode
}

export type TerminalSettingsChangedDetail = {
  target: TerminalTarget
  settings: TerminalAppearance
}

function keysFor(target: TerminalTarget) {
  return target === 'pty'
    ? { fontSize: PTY_FONT_SIZE_KEY, fontFamily: PTY_FONT_FAMILY_KEY, theme: PTY_THEME_KEY }
    : { fontSize: SHELL_FONT_SIZE_KEY, fontFamily: SHELL_FONT_FAMILY_KEY, theme: SHELL_THEME_KEY }
}

function defaultFontFamily(target: TerminalTarget): string {
  return target === 'pty' ? '"JetBrains Mono", "SF Mono", Menlo, monospace' : 'SF Mono'
}

export function clampTerminalFontSize(size: number): number {
  if (!Number.isFinite(size)) return TERMINAL_FONT_SIZE_DEFAULT
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(size)))
}

export function loadTerminalAppearance(target: TerminalTarget): TerminalAppearance {
  const keys = keysFor(target)
  let fontFamily = defaultFontFamily(target)
  let fontSize = TERMINAL_FONT_SIZE_DEFAULT
  let themeMode: TerminalThemeMode = 'system'
  try {
    const savedFamily = localStorage.getItem(keys.fontFamily)?.trim()
    if (savedFamily) fontFamily = savedFamily
    const savedSize = localStorage.getItem(keys.fontSize)
    if (savedSize) fontSize = clampTerminalFontSize(parseInt(savedSize, 10))
    const savedTheme = localStorage.getItem(keys.theme)
    if (savedTheme === 'system' || savedTheme === 'light' || savedTheme === 'dark') {
      themeMode = savedTheme
    }
  } catch {}
  return { fontFamily, fontSize, themeMode }
}

export function saveTerminalAppearance(target: TerminalTarget, next: TerminalAppearance): TerminalAppearance {
  const keys = keysFor(target)
  const normalized: TerminalAppearance = {
    fontFamily: next.fontFamily.trim() || defaultFontFamily(target),
    fontSize: clampTerminalFontSize(next.fontSize),
    themeMode: next.themeMode,
  }
  try {
    localStorage.setItem(keys.fontFamily, normalized.fontFamily)
    localStorage.setItem(keys.fontSize, String(normalized.fontSize))
    localStorage.setItem(keys.theme, normalized.themeMode)
  } catch {}
  dispatchTerminalSettingsChanged(target, normalized)
  return normalized
}

export function updateTerminalFontSize(target: TerminalTarget, fontSize: number): TerminalAppearance {
  const current = loadTerminalAppearance(target)
  return saveTerminalAppearance(target, { ...current, fontSize })
}

export function effectiveTerminalDark(appIsDark: boolean, mode: TerminalThemeMode): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return appIsDark
}

export function buildXtermTheme(appIsDark: boolean, mode: TerminalThemeMode = 'system') {
  const dark = effectiveTerminalDark(appIsDark, mode)
  const ansiDark = {
    black: '#1A1D1B', red: '#FF6B6B', green: '#71D47D', yellow: '#E6B450',
    blue: '#8FD3FF', magenta: '#D8B4FE', cyan: '#7DD3C7', white: '#C9CEC8',
    brightBlack: '#70776F', brightRed: '#FF8585', brightGreen: '#9FE870',
    brightYellow: '#F0C96A', brightBlue: '#A9DEFF', brightMagenta: '#E4C7FF',
    brightCyan: '#99E5DB', brightWhite: '#EDEFEB',
  }
  const ansiLight = {
    black: '#171A18', red: '#C24141', green: '#216E45', yellow: '#9A6700',
    blue: '#146C94', magenta: '#7E4CB8', cyan: '#087A6D', white: '#5F675F',
    brightBlack: '#7A827B', brightRed: '#D95656', brightGreen: '#2F8F58',
    brightYellow: '#B7791F', brightBlue: '#1D84B5', brightMagenta: '#935FD0',
    brightCyan: '#0F9486', brightWhite: '#171A18',
  }
  return dark
    ? { background: '#0D0F0E', foreground: '#EDEFEB', cursor: '#9FE870',
        cursorAccent: '#0D0F0E', selectionBackground: 'rgba(159, 232, 112, 0.48)', ...ansiDark }
    : { background: '#F7F7F3', foreground: '#171A18', cursor: '#216E45',
        cursorAccent: '#F7F7F3', selectionBackground: 'rgba(33, 110, 69, 0.42)', ...ansiLight }
}

export function dispatchTerminalSettingsChanged(target: TerminalTarget, settings = loadTerminalAppearance(target)) {
  window.dispatchEvent(new CustomEvent<TerminalSettingsChangedDetail>(TERMINAL_SETTINGS_EVENT, {
    detail: { target, settings },
  }))
}

export function onTerminalSettingsChanged(
  callback: (detail: TerminalSettingsChangedDetail) => void,
): () => void {
  const handler = (event: Event) => callback((event as CustomEvent<TerminalSettingsChangedDetail>).detail)
  window.addEventListener(TERMINAL_SETTINGS_EVENT, handler)
  return () => window.removeEventListener(TERMINAL_SETTINGS_EVENT, handler)
}
