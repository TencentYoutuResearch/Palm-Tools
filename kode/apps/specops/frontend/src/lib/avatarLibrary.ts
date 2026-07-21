import { get, writable } from 'svelte/store';
import { api } from './api.ts';

export type AvatarStatus = 'running' | 'awaiting' | 'idle' | 'error';
export type AvatarSet = { name: string; frames: string[] };
export type AvatarLibrary = Record<AvatarStatus, AvatarSet[]> & { gallery: AvatarSet[] };

const EMPTY: AvatarLibrary = { running: [], awaiting: [], idle: [], error: [], gallery: [] };
export const avatarLibrary = writable<AvatarLibrary>(EMPTY);
let pending: Promise<void> | null = null;

export function loadAvatarLibrary(force = false): Promise<void> {
  if (pending && !force) return pending;
  pending = api.get<AvatarLibrary>('/api/settings/avatars').then((library) => {
    avatarLibrary.set({
      running: library.running.filter((set) => set.frames.length === 4),
      awaiting: library.awaiting.filter((set) => set.frames.length === 4),
      idle: library.idle.filter((set) => set.frames.length === 4),
      error: library.error.filter((set) => set.frames.length === 4),
      gallery: library.gallery.filter((set) => set.frames.length === 4),
    });
  }).catch(() => avatarLibrary.set(EMPTY)).finally(() => { pending = null; });
  return pending;
}

export function currentAvatarLibrary(): AvatarLibrary {
  return get(avatarLibrary);
}
