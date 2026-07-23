import { writable } from 'svelte/store'
import { ipc, type AvatarLibrary } from './ipc'

export type AvatarStatus = 'running' | 'awaiting' | 'idle' | 'error'

const EMPTY_LIBRARY: AvatarLibrary = {
  running: [],
  awaiting: [],
  idle: [],
  error: [],
  gallery: [],
}

export const avatarLibrary = writable<AvatarLibrary>(EMPTY_LIBRARY)

let loadPromise: Promise<void> | null = null
let loadVersion = 0

export function loadAvatarLibrary(force = false): Promise<void> {
  if (force) loadPromise = null
  if (loadPromise) return loadPromise
  const version = ++loadVersion
  loadPromise = ipc
    .listAvatarLibrary()
    .then((library) => {
      if (version !== loadVersion) return
      avatarLibrary.set({
        running: library.running.filter((s) => s.frames.length === 4),
        awaiting: library.awaiting.filter((s) => s.frames.length === 4),
        idle: library.idle.filter((s) => s.frames.length === 4),
        error: library.error.filter((s) => s.frames.length === 4),
        gallery: library.gallery.filter((s) => s.frames.length === 4),
      })
    })
    .catch((e) => {
      if (version !== loadVersion) return
      console.warn('loadAvatarLibrary failed:', e)
      avatarLibrary.set(EMPTY_LIBRARY)
    })
  return loadPromise
}
