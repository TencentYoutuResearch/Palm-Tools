export type GraphCommit = { hash: string; parents?: string[] }

export type GraphSegment = {
  from: number
  to: number
  color: number
  kind: 'through' | 'parent'
}

export type GraphRow = {
  hash: string
  lane: number
  color: number
  top: number[]
  bottom: number[]
  segments: GraphSegment[]
  width: number
}

type Lane = { hash: string; color: number }

/** Lay out the visible Git DAG from newest to oldest without inventing edges. */
export function layoutGitGraph(commits: GraphCommit[]): GraphRow[] {
  const rows: GraphRow[] = []
  let lanes: Lane[] = []
  let nextColor = 0
  let maxColumns = 1

  for (const commit of commits) {
    const top = lanes.slice()
    let lane = lanes.findIndex((item) => item.hash === commit.hash)
    if (lane < 0) {
      // An independent tip starts a new lane; existing lanes keep their order.
      lane = lanes.length
      lanes.push({ hash: commit.hash, color: nextColor++ })
    }
    const node = lanes[lane]
    const after = lanes.filter((item) => item.hash !== commit.hash)
    const parents = [...new Set(commit.parents ?? [])]
    const insertAt = Math.min(lane, after.length)
    parents.forEach((hash, index) => {
      if (after.some((item) => item.hash === hash)) return
      after.splice(insertAt + index, 0, {
        hash,
        color: index === 0 ? node.color : nextColor++,
      })
    })

    const segments: GraphSegment[] = []
    for (const item of top) {
      const to = item.hash === commit.hash ? lane : after.findIndex((other) => other.hash === item.hash)
      if (to >= 0) segments.push({ from: top.indexOf(item), to, color: item.color, kind: 'through' })
    }
    for (const hash of parents) {
      const to = after.findIndex((item) => item.hash === hash)
      if (to >= 0) segments.push({ from: lane, to, color: node.color, kind: 'parent' })
    }
    rows.push({
      hash: commit.hash,
      lane,
      color: node.color,
      top: top.map((item) => item.color),
      bottom: after.map((item) => item.color),
      segments,
      width: Math.max(top.length, lanes.length, after.length),
    })
    maxColumns = Math.max(maxColumns, top.length, lanes.length, after.length)
    lanes = after
  }

  return rows.map((row) => ({ ...row, width: maxColumns }))
}

export const GRAPH_LANE_STEP = 16
export const GRAPH_LANE_INSET = 11
export const GRAPH_ROW_HEIGHT = 52

export function graphPath(segment: GraphSegment): string {
  const x1 = GRAPH_LANE_INSET + segment.from * GRAPH_LANE_STEP
  const x2 = GRAPH_LANE_INSET + segment.to * GRAPH_LANE_STEP
  if (segment.kind === 'through') {
    return `M ${x1} 0 L ${x1} 26`
  }
  return x1 === x2
    ? `M ${x1} 26 L ${x2} ${GRAPH_ROW_HEIGHT}`
    : `M ${x1} 26 C ${x1} 40, ${x2} 38, ${x2} ${GRAPH_ROW_HEIGHT}`
}

export function graphContinuationPath(row: GraphRow, column: number): string | null {
  const color = row.bottom[column]
  if (color == null) return null
  const source = row.top.findIndex((item) => item === color)
  // A newly introduced parent is drawn from the current node, not as a
  // second vertical line. An already-active lane must continue even when
  // the current node also merges into that same parent.
  if (source < 0) return null
  // The current node's parent path already owns this segment.
  if (source === row.lane && row.top[source] === row.color) return null
  const x1 = GRAPH_LANE_INSET + source * GRAPH_LANE_STEP
  const x2 = GRAPH_LANE_INSET + column * GRAPH_LANE_STEP
  return x1 === x2
    ? `M ${x1} 26 L ${x2} ${GRAPH_ROW_HEIGHT}`
    : `M ${x1} 26 C ${x1} 40, ${x2} 38, ${x2} ${GRAPH_ROW_HEIGHT}`
}
