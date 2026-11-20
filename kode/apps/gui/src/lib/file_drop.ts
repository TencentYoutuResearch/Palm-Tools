type DroppedFile = Pick<File, 'name'> & { path?: string }

function withoutWindowsVerbatimPrefix(path: string): string {
  return path
    .replace(/^\\\\\?\\UNC\\/i, '\\\\')
    .replace(/^\\\\\?\\(?=[A-Za-z]:[\\/])/, '')
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(path)
    || /^\\\\[^\\]/.test(path)
}

function pathFromFileUri(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'file:') return null
    let path = decodeURIComponent(url.pathname)
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
    else if (url.hostname) path = `\\\\${url.hostname}${path.replace(/\//g, '\\')}`
    path = withoutWindowsVerbatimPrefix(path)
    return isAbsolutePath(path) ? path : null
  } catch {
    return null
  }
}

/** Accept only trustworthy absolute paths or file:// URIs; never a bare filename. */
export function normalizeDroppedPath(raw: string): string | null {
  const value = withoutWindowsVerbatimPrefix(raw.trim().replace(/^['"]|['"]$/g, ''))
  if (!value || value.startsWith('#') || /[\u0000-\u001f\u007f]/.test(value)) return null
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

/**
 * Paths read back from the macOS drag pasteboard, trusted only when their
 * names match the dropped files one for one. The pasteboard outlives the drag,
 * so a mismatch means it still holds an earlier drag's items.
 */
export function pasteboardPathsForDrop(files: ArrayLike<Pick<File, 'name'>>, pasteboardPaths: readonly string[]): string[] {
  const paths = collectUniquePaths(pasteboardPaths)
  if (files.length === 0 || paths.length !== files.length) return []
  const key = (name: string) => name.normalize('NFC')
  const dropped = Array.from(files, file => key(file.name)).sort()
  const named = paths.map(path => key(path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '')).sort()
  return dropped.every((name, index) => name === named[index]) ? paths : []
}

/** Finder can expose only file URLs while omitting the generic `Files` type. */
export function hasExternalFileDrag(types: readonly string[]): boolean {
  return types.includes('Files') || types.includes('text/uri-list')
}

/**
 * Format trusted composer paths as non-submitting @references. External callers
 * pass these through absolute-path normalization first; workspace Git rows may
 * intentionally provide repository-relative paths.
 */
export function composerPathReferences(rawPaths: Iterable<string>): string {
  const paths = [...new Set([...rawPaths]
    .map(path => withoutWindowsVerbatimPrefix(path.trim()))
    .filter(path => path && !/[\u0000-\u001f\u007f]/.test(path)))]
  return paths.map(path => `@${path}`).join(' ') + (paths.length ? ' ' : '')
}

/**
 * Absolute paths of an external HTML5 drop. Read `dataTransfer` before the
 * first await: the browser empties it once the drop handler returns.
 */
export async function htmlDroppedPaths(
  data: DataTransfer,
  readPasteboard: () => Promise<readonly string[]> = async () => (await import('./ipc')).ipc.dragPasteboardPaths(),
): Promise<string[]> {
  const files = Array.from(data.files as ArrayLike<DroppedFile>)
  const paths = absoluteDroppedFilePaths(files, data.getData('text/uri-list'), data.getData('text/plain'))
  if (paths.length > 0 || files.length === 0) return paths
  try { return pasteboardPathsForDrop(files, await readPasteboard()) } catch { return [] }
}
