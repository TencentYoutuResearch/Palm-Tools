/** Human-name discovery. Routing always uses an address returned by the directory. */
export function searchSessions(directory, query) {
  if (!query?.trim()) return directory
  const normalize = text => String(text ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  const needle = normalize(query)
  if (!needle) return { ...directory, sessions: [] }
  const score = session => {
    const title = normalize(session.title)
    if (title === needle) return 3
    if (title.includes(needle)) return 2
    const words = query.trim().split(/\s+/).map(normalize).filter(Boolean)
    return words.length > 1 && words.every(word => title.includes(word)) ? 1 : 0
  }
  return { ...directory, sessions: directory.sessions.map(session => ({ session, score: score(session) })).filter(row => row.score).sort((a, b) => b.score - a.score).map(row => row.session) }
}
