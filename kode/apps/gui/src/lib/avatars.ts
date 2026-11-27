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

export const BOT_BANNER_PRESETS: ReadonlyArray<{ id: string; label: string; style: string }> = [
  { id: 'blurple', label: '靛蓝星云', style: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 55%, #312e81 100%)' },
  { id: 'aurora', label: '极光青翠', style: 'linear-gradient(135deg, #10b981 0%, #14b8a6 55%, #38bdf8 100%)' },
  { id: 'cyber', label: '霓虹赛博', style: 'linear-gradient(135deg, #ec4899 0%, #8b5cf6 55%, #22d3ee 100%)' },
  { id: 'sunset', label: '日落琥珀', style: 'linear-gradient(135deg, #f97316 0%, #f43f5e 55%, #a855f7 100%)' },
  { id: 'forest', label: '幽林翡翠', style: 'linear-gradient(135deg, #065f46 0%, #10b981 58%, #047857 100%)' },
  { id: 'sakura', label: '樱花暮粉', style: 'linear-gradient(135deg, #f472b6 0%, #fb7185 55%, #c084fc 100%)' },
  { id: 'ocean', label: '深海湛蓝', style: 'linear-gradient(135deg, #2563eb 0%, #0ea5e9 58%, #06b6d4 100%)' },
  { id: 'amber', label: '鎏金暖阳', style: 'linear-gradient(135deg, #f59e0b 0%, #ea580c 58%, #d97706 100%)' },
  // Legacy preset aliases kept for backward compatibility
  { id: 'ember', label: '晚霞', style: 'linear-gradient(135deg, #c2410c 0%, #e11d48 60%, #7c2d12 100%)' },
  { id: 'slate', label: '石板', style: 'linear-gradient(135deg, #1e293b 0%, #475569 58%, #0f172a 100%)' },
  { id: 'plum', label: '梅紫', style: 'linear-gradient(135deg, #6d28d9 0%, #db2777 62%, #4c1d95 100%)' },
  { id: 'mint', label: '薄荷', style: 'linear-gradient(135deg, #0f766e 0%, #22c55e 65%, #115e59 100%)' },
  { id: 'rose', label: '蔷薇', style: 'linear-gradient(135deg, #be185d 0%, #f43f5e 62%, #881337 100%)' },
]

export function findGalleryAvatar(library: AvatarLibrary, avatarId?: string | null) {
  if (!avatarId) return null
  return (
    library.gallery.find((s) => s.name === avatarId || s.aliases?.includes(avatarId)) ?? null
  )
}

export function resolveBannerCss(
  banner?: string | null,
  avatar?: { banner?: string | null; background?: string | null } | null,
): { image?: string; background?: string } | null {
  const value = (banner ?? '').trim()
  if (value === 'none') return null
  if (value.startsWith('preset:')) {
    const preset = BOT_BANNER_PRESETS.find((p) => p.id === value.slice(7))
    return preset ? { background: preset.style } : null
  }
  if (value.startsWith('color:')) {
    const hex = value.slice(6).trim()
    return /^#[0-9a-fA-F]{6}$/.test(hex)
      ? { background: `linear-gradient(135deg, ${hex} 0%, ${hex}cc 100%)` }
      : null
  }
  const image = avatar?.banner || avatar?.background || undefined
  if (image) return { image }
  return null
}

export function resolveBackgroundMedia(
  library: AvatarLibrary,
  avatarId?: string | null,
  banner?: string | null,
): { image?: string; background?: string } | null {
  if ((banner ?? '').trim() === 'none') return null
  const set = findGalleryAvatar(library, avatarId)
  if (set?.background) return { image: set.background }
  return resolveBannerCss(banner, set)
}

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
