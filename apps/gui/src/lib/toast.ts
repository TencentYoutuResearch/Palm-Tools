import { writable } from 'svelte/store'

export type ToastSeverity = 'info' | 'success' | 'warning' | 'error'

export interface ToastInput {
  severity: ToastSeverity
  title: string
  detail?: string
  durationMs?: number
}

export interface Toast extends ToastInput {
  id: number
  createdAt: number
  expiresAt: number
}

const MAX_TOASTS = 3
const DEFAULT_DURATION_MS = 3200

export const toasts = writable<Toast[]>([])

let nextId = 1
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function scheduleRemoval(id: number, delayMs: number) {
  // 现有同 id 定时器先清掉,避免重复触发
  const existing = timers.get(id)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    removeToast(id)
    timers.delete(id)
  }, delayMs)
  timers.set(id, timer)
}

export function pushToast(input: ToastInput): number {
  const now = Date.now()
  const duration = input.durationMs ?? DEFAULT_DURATION_MS
  const toast: Toast = {
    ...input,
    id: nextId++,
    createdAt: now,
    expiresAt: now + duration,
  }
  toasts.update((list) => {
    const next = [toast, ...list]
    if (next.length > MAX_TOASTS) {
      // 淘汰最老的:即 createdAt 最小的、列表末尾的
      const evicted = next.pop()
      if (evicted) {
        const t = timers.get(evicted.id)
        if (t) {
          clearTimeout(t)
          timers.delete(evicted.id)
        }
      }
    }
    return next
  })
  scheduleRemoval(toast.id, duration)
  return toast.id
}

export function removeToast(id: number) {
  toasts.update((list) => list.filter((t) => t.id !== id))
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
}
