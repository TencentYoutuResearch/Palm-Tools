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

export type WrappedTerminalCell = {
  char: string
  x: number
  endX: number
}

export type WrappedTerminalRow = {
  y: number
  isWrapped: boolean
  cells: WrappedTerminalCell[]
}

export type TerminalCellPosition = {
  row: number
  x: number
  endX: number
}

export type LogicalTerminalLine = {
  text: string
  positions: TerminalCellPosition[]
  startRow: number
  endRow: number
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

export function terminalLogicalRowBounds(
  isWrappedAt: (index: number) => boolean | undefined,
  requestedIndex: number,
): { start: number; end: number } | null {
  if (requestedIndex < 0 || isWrappedAt(requestedIndex) === undefined) return null
  let start = requestedIndex
  while (start > 0 && isWrappedAt(start) === true) start -= 1
  let end = requestedIndex
  while (isWrappedAt(end + 1) === true) end += 1
  return { start, end }
}

export function joinWrappedTerminalRows(rows: WrappedTerminalRow[]): LogicalTerminalLine | null {
  if (rows.length === 0) return null
  let text = ''
  const positions: TerminalCellPosition[] = []
  for (const row of rows) {
    for (const cell of row.cells) {
      for (let offset = 0; offset < cell.char.length; offset += 1) {
        text += cell.char[offset]
        positions.push({ row: row.y, x: cell.x, endX: cell.endX })
      }
    }
  }

  while (text.endsWith(' ') && positions.length > 0) {
    text = text.slice(0, -1)
    positions.pop()
  }

  return {
    text,
    positions,
    startRow: rows[0].y,
    endRow: rows[rows.length - 1].y,
  }
}

export function terminalRangeForOffsets(
  line: LogicalTerminalLine,
  start: number,
  end: number,
): { start: { x: number; y: number }; end: { x: number; y: number } } | null {
  if (start < 0 || end <= start || end > line.positions.length) return null
  const first = line.positions[start]
  const last = line.positions[end - 1]
  if (!first || !last) return null
  return {
    start: { x: first.x, y: first.row },
    end: { x: last.endX, y: last.row },
  }
}

export function terminalCharIndexAtPosition(
  line: LogicalTerminalLine,
  row: number,
  x: number,
): number {
  return line.positions.findIndex(position =>
    position.row === row && x >= position.x && x < position.endX
  )
}
