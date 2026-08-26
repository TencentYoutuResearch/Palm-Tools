/** Split a workspace filter into ordered tokens (whitespace and slashes). */
export function workspaceQueryTokens(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/[\s/\\]+/)
    .filter(Boolean)
}

/**
 * VS Code-style path filter: every token must appear left-to-right in the
 * relative path, or all tokens must appear in the basename.
 */
export function workspacePathMatches(relPath: string, name: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true
  const hay = relPath.replace(/\\/g, '/').toLowerCase()
  const nameL = name.toLowerCase()
  let from = 0
  const ordered = tokens.every((token) => {
    const i = hay.indexOf(token, from)
    if (i < 0) return false
    from = i + token.length
    return true
  })
  if (ordered) return true
  return tokens.every((token) => nameL.includes(token))
}

/** Rank a matched path consistently across local and remote workspaces. */
export function workspaceSearchScore(relPath: string, name: string, tokens: string[]): number {
  if (tokens.length === 0) return 0
  const rel = relPath.replace(/\\/g, '/').toLowerCase()
  const nameL = name.toLowerCase()
  const joined = tokens.join('')
  let score = 0
  if (nameL === joined) score += 800
  if (nameL.startsWith(tokens[0])) score += 400
  if (tokens.every((token) => nameL.includes(token))) score += 250
  if (nameL.includes(joined)) score += 80
  score += Math.max(0, 120 - Math.min(120, rel.length))
  return score
}

export const WORKSPACE_SEARCH_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
  '.turbo',
  'coverage',
  'Pods',
  '.cache',
])
