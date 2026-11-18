export interface MonitorGroupSession {
  id: number
  cwd?: string | null
}

export interface MonitorSessionGroup<T extends MonitorGroupSession> {
  id: string
  cwd: string
  name: string
  pathHint: string
  showPathHint: boolean
  sessions: T[]
}

function pathParts(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean)
}

export function monitorPathBasename(path: string): string {
  const parts = pathParts(path)
  return parts.at(-1) ?? path
}

function monitorPathHint(path: string): string {
  const slash = path.lastIndexOf('/')
  const backslash = path.lastIndexOf('\\')
  const separatorIndex = Math.max(slash, backslash)
  const parent = separatorIndex > 0 ? path.slice(0, separatorIndex) : path
  if (parent.length <= 34) return parent
  const separator = backslash > slash ? '\\' : '/'
  const parts = pathParts(parent)
  return `…${separator}${parts.slice(-2).join(separator)}`
}

/**
 * Group Monitor sessions by cwd in first-seen order. Session order inside each
 * group is preserved so it stays aligned with the source Worker's list.
 */
export function groupMonitorSessions<T extends MonitorGroupSession>(
  sessions: readonly T[],
): MonitorSessionGroup<T>[] {
  const order: string[] = []
  const groups = new Map<string, T[]>()
  for (const session of sessions) {
    const cwd = session.cwd?.trim() || '(no cwd)'
    let rows = groups.get(cwd)
    if (!rows) {
      rows = []
      groups.set(cwd, rows)
      order.push(cwd)
    }
    rows.push(session)
  }

  const draft = order.map((cwd) => ({
    id: cwd,
    cwd,
    name: cwd === '(no cwd)' ? 'Other' : monitorPathBasename(cwd),
    pathHint: cwd === '(no cwd)' ? '' : monitorPathHint(cwd),
    sessions: groups.get(cwd)!,
  }))
  const nameCounts = new Map<string, number>()
  for (const group of draft) {
    nameCounts.set(group.name, (nameCounts.get(group.name) ?? 0) + 1)
  }
  return draft.map((group) => ({
    ...group,
    showPathHint: (nameCounts.get(group.name) ?? 0) > 1 && !!group.pathHint,
  }))
}
