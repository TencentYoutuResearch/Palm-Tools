import { readonly, writable } from 'svelte/store'

const uploadCounts = writable<Record<number, number>>({})
export const remoteUploadCounts = readonly(uploadCounts)
const uploadTasks = new Map<number, Set<{ active: boolean; closed: boolean }>>()

function publishUploadCount(sessionId: number) {
  const count = [...(uploadTasks.get(sessionId) ?? [])].filter(task => task.active).length
  uploadCounts.update(counts => {
    const next = { ...counts }
    if (count) next[sessionId] = count
    else delete next[sessionId]
    return next
  })
}

export function clearRemoteUploads(sessionId: number) {
  const tasks = uploadTasks.get(sessionId)
  if (!tasks) return
  for (const task of tasks) task.closed = true
  uploadTasks.delete(sessionId)
  publishUploadCount(sessionId)
}

export async function withRemoteUpload<T>(
  sessionId: number,
  targetExists: () => boolean,
  work: (start: () => void) => Promise<T>,
): Promise<T> {
  const task = { active: false, closed: false }
  const tasks = uploadTasks.get(sessionId) ?? new Set()
  uploadTasks.set(sessionId, tasks)
  tasks.add(task)
  const start = () => {
    if (task.closed || task.active || !targetExists()) return
    task.active = true
    publishUploadCount(sessionId)
  }
  try {
    return await work(start)
  } finally {
    task.closed = true
    tasks.delete(task)
    if (uploadTasks.get(sessionId) === tasks) {
      if (!tasks.size) uploadTasks.delete(sessionId)
      if (task.active) publishUploadCount(sessionId)
    }
  }
}

export function remoteAttachmentReferences(paths: string[]): string {
  return paths.map(path => {
    if (!path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path)) {
      throw new Error('Invalid remote attachment path')
    }
    // Quote path tokens containing whitespace or quotes, without submitting the composer.
    return `@${/[\s"'\\]/.test(path) ? JSON.stringify(path) : path}`
  }).join(' ') + (paths.length ? ' ' : '')
}

export async function insertRemoteAttachments(
  upload: () => Promise<string[]>,
  targetExists: () => boolean,
  write: (text: string) => Promise<void>,
): Promise<boolean> {
  const paths = await upload()
  if (!targetExists() || paths.length === 0) return false
  await write(remoteAttachmentReferences(paths))
  return true
}

/** Native and HTML5 drop events can both report the same upload. */
export class RemoteDropGuard {
  private pending = new Set<string>()
  private recent = new Map<string, number>()
  async run(key: string, work: () => Promise<void>): Promise<void> {
    if (this.pending.has(key) || Date.now() - (this.recent.get(key) ?? 0) < 500) return
    this.pending.add(key)
    try {
      await work()
      const now = Date.now()
      for (const [old, time] of this.recent) if (now - time >= 500) this.recent.delete(old)
      this.recent.set(key, now)
    } finally {
      this.pending.delete(key)
    }
  }
}
