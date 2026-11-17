import React from 'react'
import { PlanningConversationPanel, EmbeddedSession } from './planning-session-embed.js'
import { conversationViewSource, createTabbedConversationView, sessionViewTabStyles } from './session-view-tabs.js'
const h = React.createElement

/**
 * Orbit's right Sidebar: the native ui-sidebar-right tab framework (tabs, panes, drag,
 * close, layout) hosted by the kode-collab main panel through the pinned panel-host
 * patch (@kode/dsh-sidebar-right). The host scope is a real resource, never a Session:
 * `team/<home>/<team_id>` for a team, `draft/<home>/<draft_id>` for a Builder draft that
 * has no team yet, `builder/<home>` for Team Builder itself before any draft is chosen. Each scope has its own tab layout (a local UI preference of the
 * native store); a tab body acts only within the scope its tab lives in.
 */
/** `{ available, open(kind) }` for views inside the Orbit main panel; null without the Sidebar host. */
export const TeamSidebarContext = React.createContext(null)
export const TEAM_SIDEBAR_PANEL = 'kode-collab'
export const MESSAGES_KIND = 'kode-collab.messages'
export const SETTINGS_KIND = 'kode-collab.settings'
export const SESSION_KIND = 'kode-collab.session'
export const SESSION_PROTOCOL = 'kode-collab-session'
export const SIDEBAR_SESSION_SLOT = 'kode.orbit.sidebar.session'
export const SIDEBAR_RETAIN_SOURCE = 'kodeOrbitSidebar'
const SESSION_ADDRESS = `dsh-resource://${SESSION_PROTOCOL}/session/`
const HOST_TAB = 'sidebar.right.host.tab', HOST_TITLE = 'sidebar.right.host.tab.title'
const ids = { [MESSAGES_KIND]: '@kode/dsh-collab:messages', [SETTINGS_KIND]: '@kode/dsh-collab:settings', [SESSION_KIND]: '@kode/dsh-collab:session' }

const valid = value => typeof value === 'string' && value !== ''
export const teamScope = team => valid(team?.home_hub) && valid(team?.id) ? `team/${encodeURIComponent(team.home_hub)}/${encodeURIComponent(team.id)}` : undefined
export const draftScope = draft => valid(draft?.home_hub) && valid(draft?.id) ? `draft/${encodeURIComponent(draft.home_hub)}/${encodeURIComponent(draft.id)}` : undefined
export const builderScope = home => valid(home) ? `builder/${encodeURIComponent(home)}` : undefined

/** The exact team, draft or Builder home a scope names; anything else names nothing. */
export function parseScope(value) {
  if (!valid(value)) return undefined
  const parts = value.split('/')
  if (parts.length === 2 && parts[0] === 'builder') {
    let home
    try { home = decodeURIComponent(parts[1]) } catch { return undefined }
    return valid(home) ? { kind: 'builder', home_hub: home } : undefined
  }
  if (parts.length !== 3 || (parts[0] !== 'team' && parts[0] !== 'draft')) return undefined
  let home, id
  try { home = decodeURIComponent(parts[1]); id = decodeURIComponent(parts[2]) } catch { return undefined }
  if (!valid(home) || !valid(id)) return undefined
  return parts[0] === 'team' ? { kind: 'team', home_hub: home, team_id: id } : { kind: 'draft', home_hub: home, draft_id: id }
}

export const sessionAddress = id => `${SESSION_ADDRESS}${encodeURIComponent(id)}`
export function parseSessionAddress(value) {
  let url
  try { url = new URL(value) } catch { return undefined }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== SESSION_PROTOCOL) return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'session' || url.search) return undefined
  try { const id = decodeURIComponent(parts[1]); return valid(id) ? id : undefined } catch { return undefined }
}

const untilAbort = signal => signal.aborted ? Promise.resolve() : new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))

/** The native SidebarChatTab provider shape: retain the real Session while the tab holds it, release on close. */
export function sessionResourceProvider(sessions) {
  return {
    protocol: SESSION_PROTOCOL,
    async *open(address, { signal }) {
      const id = parseSessionAddress(address)
      if (id === undefined) { yield { ok: false, error: Error('无效的会话地址。') }; return }
      if (signal.aborted) return
      let reference
      try { reference = sessions.retain(id, { source: SIDEBAR_RETAIN_SOURCE, signal }) }
      catch (error) { yield { ok: false, error }; return }
      try {
        yield { ok: true, value: { sessionId: id, reference } }
        await untilAbort(signal)
      } finally { reference.release() }
    },
  }
}

/** The current host scope, published by the Orbit main view for what it shows. */
export function createScopeSource() {
  let value
  const listeners = new Set()
  return {
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    getSnapshot: () => value,
    set(next) { next = valid(next) ? next : undefined; if (next === value) return; value = next; for (const fn of listeners) fn() },
  }
}

/** The tab body's own host scope, read from the native tab information. */
export function useHostScope(useTabInfo) {
  const info = useTabInfo()
  return React.useMemo(() => parseScope(info.host?.scope), [info.host?.scope])
}

function SessionTab({ useResource, useTabInfo, SessionProvider, renderSlot }) {
  const { tab } = useTabInfo()
  const resource = useResource(tab.contentId)
  const sessionId = parseSessionAddress(tab.contentId)
  const host = React.useMemo(() => ({ renderSession: reference => h(SessionProvider, { session: reference }, renderSlot(SIDEBAR_SESSION_SLOT, {})) }), [SessionProvider, renderSlot])
  if (resource.status === 'failed' || sessionId === undefined) return h('div', { className: 'kode-sidebar-tab-status', role: 'status' }, h('p', null, '无法载入这个会话。它可能已被删除或不在当前主机。'))
  if (resource.value === undefined) return h('div', { className: 'kode-sidebar-tab-status', role: 'status' }, h('p', null, '正在载入会话…'))
  return h('div', { className: 'kode-sidebar-session', 'data-kode-sidebar-session': sessionId },
    h(EmbeddedSession, { host, sessionId, reference: resource.value.reference, label: '会话' }))
}

/**
 * Register Orbit's tab types, bodies and the session resource on the native Sidebar and,
 * when the pinned host patch is present, the kode-collab host for the given scope source.
 * Returns a handle whose `source` reports whether tabs can be opened for the current scope.
 */
export function installTeamSidebar(ctx, { scope, MessagesTab, SettingsTab, sessionTitle }) {
  let handle = null
  const listeners = new Set()
  const notify = () => { for (const fn of listeners) fn() }
  const snapshot = () => !!handle && scope.getSnapshot() !== undefined
  const source = { subscribe: fn => { listeners.add(fn); const off = scope.subscribe(fn); return () => { listeners.delete(fn); off() } }, getSnapshot: snapshot }
  // The native developer-tools switch gates 轨迹 exactly as in session mode; optional, read when present.
  let devForm = null
  const devListeners = new Set()
  const devChanged = () => { for (const fn of devListeners) fn() }
  const devTools = { getSnapshot: () => !!devForm?.getSnapshot?.(), subscribe: fn => { devListeners.add(fn); return () => devListeners.delete(fn) } }
  const sessionViewSource = conversationViewSource(ctx.slots, devTools)
  const sessionViews = createTabbedConversationView(sessionViewSource)
  ctx.inject?.(['configForms'], inner => {
    inner.effect(() => {
      devForm = inner.get?.('configForms')?.developerTools?.enabled ?? inner.configForms?.developerTools?.enabled ?? null
      const off = devForm?.subscribe?.(devChanged)
      devChanged()
      return () => { off?.(); devForm = null; devChanged() }
    }, 'kode.collab.sidebar-devtools')
  })
  ctx.inject(['sidebarRight', 'sidebarRightTabs', 'resources', 'sessions'], inner => {
    const sidebar = inner.get('sidebarRight'), types = inner.get('sidebarRightTabs'), resources = inner.get('resources')
    // Stock ui-sidebar-right has no panel hosts: Orbit keeps its in-place views.
    if (typeof sidebar?.registerHost !== 'function' || !types?.register || !resources?.register) return
    inner.effect(() => resources.register(sessionResourceProvider(inner.get('sessions'))), 'kode.collab.sidebar-session-resource')
    inner.effect(() => types.register({ id: ids[MESSAGES_KIND], kind: MESSAGES_KIND, priority: 'builtin', title: () => '消息列' }), 'kode.collab.sidebar-messages-type')
    inner.effect(() => types.register({ id: ids[SETTINGS_KIND], kind: SETTINGS_KIND, priority: 'builtin', title: () => '设置' }), 'kode.collab.sidebar-settings-type')
    inner.effect(() => types.register({ id: ids[SESSION_KIND], kind: SESSION_KIND, priority: 'builtin', patterns: [`${SESSION_ADDRESS}**`],
      canOpen: address => parseSessionAddress(address) !== undefined,
      title: address => { const id = parseSessionAddress(address); return id === undefined ? '会话' : sessionTitle(id) } }), 'kode.collab.sidebar-session-type')
    const body = (kind, component, children) => inner.slots.inject(HOST_TAB, () => inner.slots.register({ name: HOST_TAB, key: ids[kind], ...(children ? { children } : {}) }, component))
    inner.effect(() => body(MESSAGES_KIND, MessagesTab), 'kode.collab.sidebar-messages-body')
    inner.effect(() => body(SETTINGS_KIND, SettingsTab), 'kode.collab.sidebar-settings-body')
    inner.effect(() => body(SESSION_KIND, SessionTab, { [SIDEBAR_SESSION_SLOT]: { kind: 'single', scope: 'session' } }), 'kode.collab.sidebar-session-body')
    // A real Session in a tab gets the native view tabs (对话 / 轨迹 …), same entries and rules as session mode.
    const SidebarConversation = props => h(React.Fragment, null, h('style', null, sessionViewTabStyles), h(PlanningConversationPanel, { ...props, views: sessionViews }))
    inner.effect(() => inner.slots.inject(SIDEBAR_SESSION_SLOT, () => inner.slots.register({ name: SIDEBAR_SESSION_SLOT }, SidebarConversation)), 'kode.collab.sidebar-session-conversation')
    inner.effect(() => inner.slots.inject(HOST_TITLE, () => inner.slots.register({ name: HOST_TITLE, key: ids[SESSION_KIND] }, SessionTitle)), 'kode.collab.sidebar-session-title')
    inner.effect(() => {
      // Settings is the one page a host surface opens with; other tabs only on request.
      handle = sidebar.registerHost(TEAM_SIDEBAR_PANEL, { scope, seed: SETTINGS_KIND }); notify()
      return () => { handle.dispose(); handle = null; notify() }
    }, 'kode.collab.sidebar-host')
  })
  function SessionTitle({ useTabInfo }) {
    const { tab } = useTabInfo()
    const id = parseSessionAddress(tab.contentId)
    const list = ctx.get('sessions')?.list
    const title = React.useSyncExternalStore(list?.subscribe ?? (() => () => {}), () => id === undefined ? undefined : sessionTitle(id))
    return title ?? tab.title
  }
  const require = () => { if (!snapshot()) throw Error('当前视图没有可用的右侧栏。'); return handle }
  return {
    source,
    sessionViews,
    sessionViewSource,
    available: snapshot,
    // The pinned host patch is present (tabs may still wait for the scope to settle).
    hosted: () => !!handle,
    openTab: kind => require().openTab(kind),
    openSession: id => require().openResource(sessionAddress(id), { kind: SESSION_KIND }),
  }
}

/** Honest placeholder for a draft scope: the draft has no team, so no DM or team settings exist yet. */
export function DraftScopeNote({ children }) {
  return h('div', { className: 'kode-sidebar-tab-status', role: 'status' }, h('p', null, children))
}
