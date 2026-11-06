/** Refresh one bounded page per tick, preserving the user's loaded window. */
export function validateRunPage(result, team, after = '') {
  if (result.team_id !== team.id || result.home_hub !== team.home_hub || !Array.isArray(result.items) || result.items.length > 25) throw Error('Invalid history')
  let cursor = after
  for (const row of result.items) {
    if (typeof row.id !== 'string' || row.id <= cursor || row.team_id !== team.id || row.home_hub !== team.home_hub || typeof row.completion_authorized !== 'boolean' || !Number.isSafeInteger(row.revision) || row.revision < 1) throw Error('Invalid history identity')
    cursor = row.id
  }
  if (result.next_cursor !== null && (!result.items.length || result.next_cursor !== cursor)) throw Error('Invalid history cursor')
  return result
}
export function mergeRunPage(previous, result, { more = false } = {}) {
  const ceiling = previous.items.at(-1)?.id ?? ''
  const expand = more || previous.items.length < 25
  const rows = new Map(previous.items.map(row => [row.id, row]))
  for (const row of result.items) {
    if (!expand && row.id > ceiling) continue
    if (!rows.has(row.id) || rows.get(row.id).revision < row.revision) rows.set(row.id, row)
  }
  const items = [...rows.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const last = result.items.at(-1)?.id ?? ''
  const reachedEnd = result.next_cursor === null || last >= ceiling
  const next = more || expand ? result.next_cursor : reachedEnd ? (result.next_cursor !== null || last > ceiling ? ceiling : null) : previous.next
  return { items, next, loaded: true }
}
export function nextRunRefresh(previous, result) {
  const ceiling = previous.items.at(-1)?.id ?? ''
  return result.next_cursor && result.next_cursor < ceiling ? result.next_cursor : ''
}
