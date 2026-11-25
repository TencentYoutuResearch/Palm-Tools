/**
 * Pure concurrency and ordering helpers for parallel runtime switching.
 * Kept free of Tauri/Svelte imports so Node unit tests can exercise them directly.
 */

export type SwitchStep = 'start' | 'stop' | 'import' | 'open' | 'resume'

/**
 * Concurrency semaphore for bounding one heavy phase (such as spawning PTYs or
 * importing large transcripts) inside a wider concurrent fan-out.
 */
export function createLimiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.trunc(concurrency) || 1)
  let active = 0
  const queue: Array<() => void> = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve))
    }
    active++
    try {
      return await task()
    } finally {
      active--
      queue.shift()?.()
    }
  }
}

/**
 * Run `worker` over `items` with at most `concurrency` tasks in flight at once.
 * Every item settles independently; rejections are caught inside `worker` or
 * returned via `PromiseSettledResult` so one failure never aborts siblings.
 */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (!items.length) return []
  const limit = Math.max(1, Math.min(Math.trunc(concurrency) || 1, items.length))
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let next = 0
  const runWorker = async () => {
    while (next < items.length) {
      const index = next++
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, runWorker))
  return results
}

type Waiter<S, R> = {
  what: string
  deadline: number
  probe: (snapshot: S) => R | null | undefined | false
  resolve: (value: R) => void
  reject: (error: Error) => void
}

/**
 * Share a single polling loop across N concurrent waiters.
 * Each tick fetches one snapshot and resolves every waiter whose predicate
 * matches immediately, instead of spawning N independent polling loops.
 */
export class SnapshotPoller<S> {
  private readonly intervalMs: number
  private readonly fetchSnapshot: () => Promise<S>
  private readonly waiters = new Set<Waiter<S, unknown>>()
  private loop: Promise<void> | null = null

  constructor(intervalMs: number, fetchSnapshot: () => Promise<S>) {
    this.intervalMs = Math.max(10, intervalMs)
    this.fetchSnapshot = fetchSnapshot
  }

  waitFor<R>(
    what: string,
    timeoutMs: number,
    probe: (snapshot: S) => R | null | undefined | false,
  ): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const waiter: Waiter<S, R> = {
        what,
        deadline: Date.now() + timeoutMs,
        probe,
        resolve,
        reject,
      }
      this.waiters.add(waiter as Waiter<S, unknown>)
      this.ensureLoop()
    })
  }

  private ensureLoop() {
    if (this.loop) return
    this.loop = (async () => {
      try {
        while (this.waiters.size > 0) {
          const snapshot = await this.fetchSnapshot().catch(() => null)
          const now = Date.now()
          for (const waiter of [...this.waiters]) {
            if (snapshot !== null) {
              let value: unknown = false
              try { value = waiter.probe(snapshot) } catch { value = false }
              if (value) {
                this.waiters.delete(waiter)
                waiter.resolve(value)
                continue
              }
            }
            if (now > waiter.deadline) {
              this.waiters.delete(waiter)
              waiter.reject(new Error(waiter.what))
            }
          }
          if (this.waiters.size > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.intervalMs))
          }
        }
      } finally {
        this.loop = null
        if (this.waiters.size > 0) this.ensureLoop()
      }
    })()
  }
}

export interface SwitchTabLike<Id = number> {
  id: Id
  sharedRuntime?: boolean
  sessionId?: string | null
}

/**
 * Partition dsh tabs moving back to TUI into unique conversations to resume
 * versus duplicate runtime copies that should simply be retired.
 * One terminal per native session id: if a PTY already holds that session id
 * or an earlier dsh copy in the same batch claimed it, retire the extra copy.
 */
export function partitionTuiTargets<T extends SwitchTabLike>(
  due: readonly T[],
  existingTabs: readonly T[],
): { toResume: T[]; toDrop: T[] } {
  const heldByTerminal = new Set<string>(
    existingTabs
      .filter((tab) => !tab.sharedRuntime && !!tab.sessionId)
      .map((tab) => tab.sessionId!),
  )
  const claimed = new Set<string>(heldByTerminal)
  const toResume: T[] = []
  const toDrop: T[] = []
  for (const tab of due) {
    const sid = tab.sessionId
    if (sid && claimed.has(sid)) {
      toDrop.push(tab)
    } else {
      if (sid) claimed.add(sid)
      toResume.push(tab)
    }
  }
  return { toResume, toDrop }
}

/**
 * Restore tab order after a parallel batch move.
 * Original slots keep their exact position (mapping `oldId -> newId` for moved
 * or rolled-back tabs); any brand-new tabs created concurrently append at the end.
 */
export function reorderAfterBatch<Id, T extends { id: Id }>(
  current: readonly T[],
  initialOrder: readonly Id[],
  replacements: ReadonlyMap<Id, Id>,
): T[] {
  const byId = new Map<Id, T>(current.map((tab) => [tab.id, tab]))
  const ordered: T[] = []
  for (const oldId of initialOrder) {
    const targetId = replacements.get(oldId) ?? oldId
    const tab = byId.get(targetId)
    if (tab) {
      ordered.push(tab)
      byId.delete(targetId)
    }
  }
  for (const remaining of byId.values()) ordered.push(remaining)
  return ordered
}

/**
 * Pick the active tab id to restore after a parallel batch move.
 * Keeps focus on the original active tab (or its replacement if it moved).
 */
export function targetActiveAfterBatch<Id, T extends { id: Id }>(
  previousActive: Id | null,
  replacements: ReadonlyMap<Id, Id>,
  current: readonly T[],
): Id | null {
  if (previousActive == null) return null
  const target = replacements.get(previousActive) ?? previousActive
  return current.some((tab) => tab.id === target) ? target : null
}

/**
 * Compute the aggregate step shown in the progress overlay while N conversations
 * advance in parallel: returns the earliest step among still-incomplete items
 * so a step is checked off only once every conversation has passed it.
 */
export function batchCurrentStep(
  steps: readonly SwitchStep[],
  activeStages: Iterable<SwitchStep>,
): SwitchStep {
  let earliest = steps.length - 1
  let sawAny = false
  for (const stage of activeStages) {
    const idx = steps.indexOf(stage)
    if (idx >= 0 && (!sawAny || idx < earliest)) {
      earliest = idx
      sawAny = true
    }
  }
  return steps[sawAny ? earliest : Math.max(0, steps.length - 1)]
}
