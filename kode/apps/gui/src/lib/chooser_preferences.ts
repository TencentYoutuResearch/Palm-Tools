/** Last successful new-tab selection. Resume IDs are deliberately not persisted. */
import type { EndpointId } from './ipc'

const STORAGE_KEY = 'kode.chooser.lastSelection'
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>
export type ChooserSelection = {
  backendKey: string
  endpointId: EndpointId
  cwd: string
  model?: string
}

function defaultStorage(): Storage | null {
  try { return globalThis.localStorage ?? null } catch { return null }
}

export function rememberedSelection(storage: Storage | null = defaultStorage()): ChooserSelection | null {
  try {
    const value = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null')
    if (!value || typeof value.backendKey !== 'string' || !value.backendKey
      || typeof value.cwd !== 'string'
      || (value.model !== undefined && typeof value.model !== 'string')
      || !(value.endpointId?.kind === 'local'
        || (value.endpointId?.kind === 'remote' && typeof value.endpointId.id === 'string'))) return null
    return value
  } catch { return null }
}

export function rememberSelection(selection: ChooserSelection, storage: Storage | null = defaultStorage()): void {
  const { backendKey, endpointId, cwd, model } = selection
  try { storage?.setItem(STORAGE_KEY, JSON.stringify({ backendKey, endpointId, cwd, model })) } catch {}
}

export function sameEndpoint(a: EndpointId, b: EndpointId): boolean {
  return a.kind === b.kind && (a.kind === 'local' || (b.kind === 'remote' && a.id === b.id))
}
