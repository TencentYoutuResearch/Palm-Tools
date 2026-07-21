import { readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type AvatarState = 'running' | 'awaiting' | 'idle' | 'error'

export interface AvatarSet {
  name: string
  frames: string[]
}

export interface AvatarLibrary {
  running: AvatarSet[]
  awaiting: AvatarSet[]
  idle: AvatarSet[]
  error: AvatarSet[]
  gallery: AvatarSet[]
}

const STATES: AvatarState[] = ['running', 'awaiting', 'idle', 'error']

export function avatarRootDir(): string {
  const override = process.env.KODE_AVATAR_DIR?.trim()
  if (override) return override.startsWith('~/') ? path.join(os.homedir(), override.slice(2)) : override
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'kode', 'avatars')
  return path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), 'kode', 'avatars')
}

async function directories(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

async function readSet(dir: string, name: string): Promise<AvatarSet | null> {
  const frames: string[] = []
  for (let index = 1; index <= 4; index += 1) {
    try {
      const bytes = await readFile(path.join(dir, `frame-${String(index).padStart(2, '0')}.png`))
      frames.push(`data:image/png;base64,${bytes.toString('base64')}`)
    } catch {
      return null
    }
  }
  return { name, frames }
}

async function readSets(dir: string, name: string): Promise<AvatarSet[]> {
  const direct = await readSet(dir, name)
  if (direct) return [direct]
  const nested = await directories(dir)
  return (await Promise.all(nested.map((entry) => readSet(path.join(dir, entry), name))))
    .filter((set): set is AvatarSet => set !== null)
}

export async function loadAvatarLibrary(root = avatarRootDir()): Promise<AvatarLibrary> {
  const library: AvatarLibrary = { running: [], awaiting: [], idle: [], error: [], gallery: [] }
  for (const state of STATES) {
    const stateRoot = path.join(root, state)
    const direct = await readSet(stateRoot, state)
    if (direct) library[state].push(direct)
    else {
      for (const entry of await directories(stateRoot)) {
        const set = await readSet(path.join(stateRoot, entry), `${state}/${entry}`)
        if (set) library[state].push(set)
      }
    }
  }

  const galleryRoot = path.join(root, 'gallery')
  for (const entry of await directories(galleryRoot)) {
    const id = `gallery/${entry}`
    const entryRoot = path.join(galleryRoot, entry)
    const direct = await readSet(entryRoot, id)
    const idle = direct ?? (await readSets(path.join(entryRoot, 'idle'), id))[0] ?? null
    if (idle) library.gallery.push(idle)
    for (const state of STATES) {
      library[state].push(...await readSets(path.join(entryRoot, state), id))
    }
  }
  return library
}
