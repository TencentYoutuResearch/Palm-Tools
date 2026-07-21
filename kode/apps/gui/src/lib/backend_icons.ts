export type BackendIconProfile = {
  asset: string | null
  tint: string | null
  fallback: string
  monochrome: boolean
}

const ICONS: Record<string, Omit<BackendIconProfile, 'fallback'>> = {
  codebuddy: { asset: 'codebuddy', tint: null, monochrome: false },
  claude: { asset: 'claudecode', tint: '#D97757', monochrome: false },
  'claude-code': { asset: 'claudecode', tint: '#D97757', monochrome: false },
  claudecode: { asset: 'claudecode', tint: '#D97757', monochrome: false },
  codex: { asset: 'codex', tint: '#7A9DFF', monochrome: false },
  gemini: { asset: 'gemini', tint: '#3186FF', monochrome: false },
  opencode: { asset: 'opencode', tint: '#B0B0B0', monochrome: true },
  amp: { asset: 'amp', tint: '#E8B168', monochrome: false },
  cursor: { asset: 'cursor', tint: '#F54E00', monochrome: true },
  'cursor-agent': { asset: 'cursor', tint: '#F54E00', monochrome: true },
  copilot: { asset: 'githubcopilot', tint: '#6E40C9', monochrome: true },
  'github-copilot': { asset: 'githubcopilot', tint: '#6E40C9', monochrome: true },
  githubcopilot: { asset: 'githubcopilot', tint: '#6E40C9', monochrome: true },
  grok: { asset: 'grok', tint: '#E8E8E8', monochrome: true },
  antigravity: { asset: 'antigravity', tint: '#4285F4', monochrome: false },
  agy: { asset: 'antigravity', tint: '#4285F4', monochrome: false },
  kimi: { asset: 'kimi', tint: '#C9C3D6', monochrome: true },
  pi: { asset: 'pi', tint: '#C2C5CE', monochrome: true },
  kiro: { asset: 'kiro', tint: '#9046FF', monochrome: false },
  'kiro-cli': { asset: 'kiro', tint: '#9046FF', monochrome: false },
  droid: { asset: 'droid', tint: '#C9CDD3', monochrome: true },
}

export function backendIconProfile(key: string, command?: string | null): BackendIconProfile {
  const normalized = [key, command ?? '']
    .flatMap((value) => normalizeBackendTokens(value))
    .find((token) => ICONS[token])

  const matched = normalized ? ICONS[normalized] : null
  return {
    asset: matched?.asset ?? null,
    tint: matched?.tint ?? null,
    monochrome: matched?.monochrome ?? false,
    fallback: fallbackLabel(key || command || '?'),
  }
}

function normalizeBackendTokens(value: string): string[] {
  const raw = value.trim().toLowerCase()
  if (!raw) return []
  const base = raw.split(/[\\/]/).pop() ?? raw
  const withoutExt = base.replace(/\.(cmd|exe|sh|zsh|bash)$/, '')
  const compact = withoutExt.replace(/[_\s]+/g, '-')
  return [compact, compact.replace(/-internal$/, ''), compact.replace(/-cli$/, '')]
}

function fallbackLabel(value: string): string {
  const parts = value
    .trim()
    .replace(/[_/\\]+/g, '-')
    .split('-')
    .filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return (parts[0] ?? '?').slice(0, 2).toUpperCase()
}
