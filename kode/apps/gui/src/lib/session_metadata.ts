import type { PersistedTab, SessionId, SessionMeta } from './ipc'
import type { TabInfo } from './sessions'

const usageFields = ['tokens', 'input_tokens', 'output_tokens', 'cached_tokens', 'cost_usd'] as const
export const MAX_PENDING_SESSION_METADATA = 256

export function applySessionMetadata(tab: TabInfo, meta: SessionMeta): TabInfo {
  const sessionChanged = Boolean(meta.session_id && meta.session_id !== tab.sessionId)
  const next: TabInfo = {
    ...tab,
    ...(meta.title && !tab.titlePinned ? { title: meta.title } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.session_id ? { sessionId: meta.session_id } : {}),
  }
  // A new binding invalidates old totals even when the bridge omits tokens_reset.
  if (meta.tokens_reset || sessionChanged) {
    delete next.tokens
    delete next.inputTokens
    delete next.outputTokens
    delete next.cachedTokens
    delete next.costUsd
  }
  if (sessionChanged && !tab.titlePinned && !meta.title) {
    next.title = `tab · ${tab.backendKey}`
  }
  if (meta.tokens != null) next.tokens = meta.tokens
  if (meta.input_tokens != null) next.inputTokens = meta.input_tokens
  if (meta.output_tokens != null) next.outputTokens = meta.output_tokens
  if (meta.cached_tokens != null) next.cachedTokens = meta.cached_tokens
  if (meta.cost_usd != null) next.costUsd = meta.cost_usd
  return next
}

interface PendingMetadata {
  meta: SessionMeta
  clearTitle: boolean
}

export class SessionMetadataBuffer {
  private pending = new Map<SessionId, PendingMetadata>()

  get size(): number {
    return this.pending.size
  }

  receive(tabs: TabInfo[], meta: SessionMeta): TabInfo[] {
    if (tabs.some((tab) => tab.id === meta.id)) {
      return tabs.map((tab) => tab.id === meta.id ? applySessionMetadata(tab, meta) : tab)
    }
    const previous = this.pending.get(meta.id)
    const merged: SessionMeta = { ...previous?.meta, id: meta.id }
    const invalidate = Boolean(meta.tokens_reset
      || (meta.session_id && meta.session_id !== merged.session_id))
    if (invalidate) {
      for (const field of usageFields) delete merged[field]
      delete merged.title
      // Replay the invalidation even if a later DTO already carries this UUID.
      merged.tokens_reset = true
    }
    if (meta.session_id) merged.session_id = meta.session_id
    if (meta.model) merged.model = meta.model
    if (meta.title) merged.title = meta.title
    for (const field of usageFields) {
      if (meta[field] != null) merged[field] = meta[field]
    }
    if (!previous && this.pending.size >= MAX_PENDING_SESSION_METADATA) {
      const oldest = this.pending.keys().next().value
      if (oldest !== undefined) this.pending.delete(oldest)
    }
    this.pending.set(meta.id, {
      meta: merged,
      clearTitle: invalidate || previous?.clearTitle || false,
    })
    return tabs
  }

  consume(tab: TabInfo): TabInfo {
    const pending = this.pending.get(tab.id)
    if (!pending) return tab
    this.pending.delete(tab.id)
    const next = applySessionMetadata(tab, pending.meta)
    if (pending.clearTitle && !pending.meta.title && !tab.titlePinned) {
      next.title = `tab · ${tab.backendKey}`
    }
    return next
  }

  delete(id: SessionId): void {
    this.pending.delete(id)
  }

  clear(): void {
    this.pending.clear()
  }
}

/** Spawn configuration fills in an early created tab without replacing runtime metadata. */
export function upsertSessionTab(
  tabs: TabInfo[],
  incoming: TabInfo,
  pending: SessionMetadataBuffer,
  mergeSpawn = false,
): TabInfo[] {
  const existing = tabs.find((tab) => tab.id === incoming.id)
  const base = existing && mergeSpawn ? {
    ...incoming,
    ...existing,
    backendKey: incoming.backendKey,
    transportKind: incoming.transportKind ?? existing.transportKind,
    cwd: incoming.cwd ?? existing.cwd,
    permissionMode: incoming.permissionMode,
    endpointId: incoming.endpointId,
    model: existing.model || incoming.model,
    sessionId: existing.sessionId || incoming.sessionId,
  } : existing ?? incoming
  const next = pending.consume(base)
  return existing
    ? tabs.map((tab) => tab.id === incoming.id ? next : tab)
    : [...tabs, next]
}

export function sessionTabToPersisted(tab: TabInfo): PersistedTab {
  return {
    backend_key: tab.backendKey,
    transport_kind: tab.transportKind,
    title: tab.title,
    title_pinned: tab.titlePinned ?? false,
    cwd: tab.cwd ?? '',
    workspace_title: tab.workspaceTitle ?? null,
    session_id: tab.sessionId ?? null,
    model: tab.model ?? null,
    permission_mode: tab.permissionMode ?? null,
    endpoint_id: tab.endpointId?.kind === 'remote' ? tab.endpointId : null,
    avatar_id: tab.avatarId ?? null,
  }
}
