type DroppedFile = Pick<File, 'name'> & { path?: string }

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

function pathFromFileUri(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'file:') return null
    let path = decodeURIComponent(url.pathname)
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
    return isAbsolutePath(path) ? path : null
  } catch {
    return null
  }
}

/** Accept only trustworthy absolute paths or file:// URIs; never a bare filename. */
export function normalizeDroppedPath(raw: string): string | null {
  const value = raw.trim().replace(/^['"]|['"]$/g, '')
  if (!value || value.startsWith('#')) return null
  if (isAbsolutePath(value)) return value
  return pathFromFileUri(value)
}

function collectUniquePaths(values: Iterable<string>): string[] {
  const paths: string[] = []
  for (const value of values) {
    const path = normalizeDroppedPath(value)
    if (path) paths.push(path)
  }
  return [...new Set(paths)]
}

/** Resolve only trustworthy absolute paths; never degrade to a bare filename. */
export function absoluteDroppedFilePaths(
  files: ArrayLike<DroppedFile>,
  uriList = '',
  plainText = '',
): string[] {
  const values: string[] = []
  for (let index = 0; index < files.length; index++) {
    const path = files[index]?.path
    if (path) values.push(path)
  }
  for (const line of uriList.split(/\r?\n/)) values.push(line)
  for (const line of plainText.split(/\r?\n/)) values.push(line)
  return collectUniquePaths(values)
}

/** OS-level paths from Tauri `onDragDropEvent` (native Finder / Explorer drop). */
export function absoluteOsDroppedPaths(rawPaths: string[]): string[] {
  return collectUniquePaths(rawPaths)
}
