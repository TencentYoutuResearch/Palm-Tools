import React from 'react'
import { nativeCssPrefix } from './native-rows.js'
const h = React.createElement

/**
 * The native Conversation View tabs (对话 / 轨迹 / …) for a real Session embedded in Orbit's
 * right Sidebar. The native tab row lives only in the main-panel session header, which an
 * embedded occurrence does not render; this row lists the same `conversation.view` entries
 * with the same rules (chat first, then by registration order; 轨迹 only while the native
 * developer-tools switch is on) and the same ConversationRoot classes, and hands the chosen
 * view to the native `conversation.session` slot. The choice is local to this occurrence,
 * so it never switches the view of the same Session open in session mode.
 * Why not the native ConversationSessionHeader itself: `conversation.session.header` is a child
 * slot declared once by `conversation.header` (a second declarer throws at load), and its
 * selectView writes the per-session conversationStore, which ui-conversation does not expose.
 * Only the tab row is ours; the body is the native DefaultConversationViews → conversation.view.
 */
export const CONVERSATION_CSS = '@deepseek-ai/dsh-client-ui-conversation/ConversationRoot.module.css'
const label = value => typeof value === 'function' ? value() : typeof value === 'string' ? value : undefined

/** `{ subscribe, getSnapshot }` over the registered views; `devTools` is the native switch source or null. */
export function conversationViewSource(slots, devTools, sessionId) {
  let key = '', value = []
  const read = () => {
    const tabs = []
    for (const entry of slots.entries('conversation.view')) {
      const id = entry.options?.id
      if (typeof id !== 'string') continue
      if (id === 'trajectory' && !devTools?.getSnapshot?.()) continue
      if (typeof entry.options?.kodeVisibleForSession === 'function' && !entry.options.kodeVisibleForSession(sessionId)) continue
      tabs.push({ id, label: label(entry.options.label) ?? id })
    }
    const next = JSON.stringify(tabs)
    if (next !== key) { key = next; value = tabs }
    return value
  }
  return {
    getSnapshot: read,
    subscribe(fn) {
      let visibilityOffs = []
      const watch = () => {
        for (const off of visibilityOffs) off()
        const sources = new Set(slots.entries('conversation.view').map(entry => entry.options?.kodeVisibilitySubscribe).filter(source => typeof source === 'function'))
        visibilityOffs = [...sources].map(source => source(sessionId, fn)).filter(off => typeof off === 'function')
      }
      watch()
      const offSlots = slots.subscribe('conversation.view', () => { watch(); fn() })
      const offDevTools = devTools?.subscribe?.(fn)
      return () => {
        offSlots()
        if (typeof offDevTools === 'function') offDevTools()
        for (const off of visibilityOffs) off()
      }
    },
    forSession(id) { return conversationViewSource(slots, devTools, id) },
  }
}

const classes = () => {
  const prefix = nativeCssPrefix(CONVERSATION_CSS, 'viewTabs')
  return prefix ? { tabs: `${prefix}_tabs`, viewTabs: `${prefix}_viewTabs`, tab: `${prefix}_tab`, active: `${prefix}_tabActive`, tabLabel: `${prefix}_tabLabel` } : null
}

/** The `views` local slot of `conversation.content`: native tab row + the native session view. */
export function createTabbedConversationView(source) {
  return function TabbedConversationView(props) {
    const sessionSource = React.useMemo(() => source.forSession?.(props.sessionId) ?? source, [source, props.sessionId])
    const tabs = React.useSyncExternalStore(sessionSource.subscribe, sessionSource.getSnapshot)
    const [chosen, choose] = React.useState('chat')
    const ordered = React.useMemo(() => [...tabs.filter(tab => tab.id === 'chat'), ...tabs.filter(tab => tab.id !== 'chat')], [tabs])
    const view = ordered.some(tab => tab.id === chosen) ? chosen : 'chat'
    const css = React.useMemo(classes, [tabs])
    return h(React.Fragment, null,
      ordered.length > 1 && h('div', { className: `kode-session-view-tabs ${css?.tabs ?? ''}`.trim() },
        h('div', { className: css?.viewTabs, role: 'tablist', 'aria-label': '会话视图', 'data-conversation-tabs': '' },
          ordered.map(tab => h('button', { key: tab.id, type: 'button', role: 'tab', 'aria-selected': tab.id === view,
            className: [css?.tab, tab.id === view && css?.active].filter(Boolean).join(' ') || undefined, onClick: () => choose(tab.id) },
            h('span', { className: css?.tabLabel }, tab.label))))),
      props.renderSlot('conversation.session', { view }))
  }
}

/** Sticky so the row stays above the transcript scroll, on the panel background like the native header. */
export const sessionViewTabStyles = `.kode-session-view-tabs{position:sticky;top:0;margin-top:0;padding-top:10px;padding-bottom:0;background:var(--dsw-alias-bg-base);border-bottom:.5px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}`
