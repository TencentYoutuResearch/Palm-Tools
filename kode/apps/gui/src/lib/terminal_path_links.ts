export type TerminalPathSegment = {
  text: string
  start: number
  end: number
  target: string
  revealChild: string | null
  isFinal: boolean
}

export type TerminalLinkTarget = {
  text: string
  start: number
  end: number
  target: string
  revealChild: string | null
  activation: 'open' | 'reveal'
}

function anchorLength(path: string): number {
  if (/^[A-Za-z]:[\\/]/.test(path)) return 3
  if (path.startsWith('\\\\')) {
    return path.match(/^\\\\[^\\/]+[\\/][^\\/]+[\\/]/)?.[0].length ?? 2
  }
  if (/^~[\\/]/.test(path)) return 2
  if (path.startsWith('/')) return 1
  return 0
}

export function terminalPathSegments(path: string): TerminalPathSegment[] {
  const anchor = anchorLength(path)
  const segments: TerminalPathSegment[] = []

  if (anchor > 0) {
    segments.push({
      text: path.slice(0, anchor),
      start: 0,
      end: anchor,
      target: path.slice(0, anchor),
      revealChild: null,
      isFinal: anchor === path.length,
    })
  }

  const remainder = path.slice(anchor)
  const pattern = /[^\\/]+/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(remainder)) !== null) {
    const start = anchor + match.index
    const end = start + match[0].length
    segments.push({
      text: match[0],
      start,
      end,
      target: path.slice(0, end),
      revealChild: null,
      isFinal: true,
    })
  }

  for (let index = 0; index < segments.length - 1; index += 1) {
    segments[index].revealChild = segments[index + 1].target
    segments[index].isFinal = false
  }
  return segments
}

export function isTerminalAbsolutePath(path: string): boolean {
  return path.startsWith('/')
    || path.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/.test(path)
    || /^~[\\/]/.test(path)
}

export function resolveTerminalPath(path: string, cwd: string | null | undefined): string {
  if (!path || isTerminalAbsolutePath(path) || !cwd) return path
  const base = cwd.replace(/[\\/]+$/, '')
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base}${separator}${path.replace(/^[\\/]+/, '')}`
}

export function cleanTerminalLinkText(raw: string): string {
  return raw
    .replace(/[.,;:!?，。、；：（）【】「」『』）】」』\]）>]+$/, '')
    .replace(/:\d+(?::\d+)?$/, '')
}

export function isTerminalUrl(raw: string): boolean {
  const lower = raw.toLowerCase()
  return lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('file://')
}

export function terminalLinkTargets(raw: string): TerminalLinkTarget[] {
  const cleaned = cleanTerminalLinkText(raw)
  if (!cleaned) return []
  if (isTerminalUrl(cleaned)) {
    return [{
      text: cleaned,
      start: 0,
      end: cleaned.length,
      target: cleaned,
      revealChild: null,
      activation: 'open',
    }]
  }
  return terminalPathSegments(cleaned).map(segment => ({
    text: segment.text,
    start: segment.start,
    end: segment.end,
    target: segment.target,
    revealChild: segment.revealChild,
    activation: segment.isFinal ? 'open' : 'reveal',
  }))
}
