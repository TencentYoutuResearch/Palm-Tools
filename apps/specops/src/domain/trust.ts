import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Add the SpecOps worktree cache root to codebuddy's trusted directories
 * so the "trust this directory?" prompt doesn't appear when codebuddy
 * starts inside a git worktree under that path.
 *
 * Writes to `~/.codebuddy/settings.json`, merging with existing config.
 * This is a best-effort operation — failures are logged but never thrown.
 */
export async function trustWorktreeRoot(runCacheRoot?: string): Promise<void> {
  try {
    const cacheRoot = runCacheRoot ?? defaultCacheRoot()
    const worktreeParent = path.join(cacheRoot, 'worktrees')

    const settingsPath = path.join(os.homedir(), '.codebuddy', 'settings.json')
    let settings: Record<string, unknown> = {}
    try {
      const raw = await readFile(settingsPath, 'utf8')
      settings = JSON.parse(raw) as Record<string, unknown>
    } catch {
      // File doesn't exist or is invalid — start fresh
    }

    let trusted: string[] = []
    if (Array.isArray(settings.trustedDirectories)) {
      trusted = settings.trustedDirectories.filter(
        (d: unknown) => typeof d === 'string'
      ) as string[]
    }

    if (!trusted.includes(worktreeParent)) {
      trusted.push(worktreeParent)
      settings.trustedDirectories = trusted
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')
    }
  } catch {
    // Best-effort: if we can't write settings, the agent session will
    // still work — the user just needs to manually approve the directory.
  }
}

function defaultCacheRoot(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'kode', 'specops')
  }
  return path.join(os.homedir(), '.cache', 'kode', 'specops')
}
