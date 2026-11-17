import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { offerPlanningText } from './builder-planning.js'
const h = React.createElement

/** Slot owned by the Orbit main entry; the official embedded-Conversation pattern
 * (dsh-client-ui-subagent ConversationSlotPanel / SidebarChatTab). */
export const PLANNING_SLOT = 'kode.orbit.planning'
export const PLANNING_RETAIN_SOURCE = 'kodeOrbitPlanning'

/** Fixed Chat view, as in the native embedded occurrence. */
function FixedChatConversationView(props) {
  return props.renderSlot('conversation.session', { view: 'chat' })
}

/**
 * The shared native Conversation content for one retained Session: transcript,
 * composer, model seat, attachments and voice are all the native ones. Hero is
 * never shown, so its workspace picker cannot rebind the draft to another Session.
 * `views` replaces the fixed Chat view (the right-Sidebar session tab adds the native view tabs).
 */
export function PlanningConversationPanel({ sessionId, useSession, useConversation, useSessions, renderFactorySlot, views = FixedChatConversationView }) {
  const session = useSession(value => value)
  const targets = useConversation(value => value).activeTargets.size
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  const engaged = targets > 0 || !session.blank && !session.awaitingFirstTurn || session.running
  const settling = !engaged && !session.promptAttempted && session.openState === 'loading' && summaryBlank !== true
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: settling ? 'settling' : 'active', hero: false },
    { slots: { views } })
}

/** Fill results that settle the offer; anything else ('blocked', 'input_unavailable', a throw) stays pending. */
const SETTLED = new Set(['applied', 'preserved', 'opened'])
const cssId = value => globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&')

/**
 * One Session binding owns one native editor: a composer already mounted for this
 * Session anywhere else (session mode, a right-Sidebar Conversation) is its writer,
 * and a second occurrence would take the editor root away from it.
 */
export function sessionWriterElsewhere(sessionId, root = globalThis.document, own = null) {
  return Array.from(root?.querySelectorAll?.(`[data-conversation-session="${cssId(sessionId)}"] [data-composer-input]`) ?? [])
    .some(node => !own?.contains(node))
}

/**
 * Orbit holds a composer, then another writer mounts and takes the editor root. The
 * patched native composer (@kode/dsh-conversation) hands the root back when that writer
 * leaves and never detaches it when Orbit leaves first; until then Orbit's covered copy
 * is inert so nothing can be typed into an unbound editor.
 */
function useWriterYield(sessionId, own) {
  const [yielded, setYielded] = React.useState(false)
  React.useEffect(() => {
    const node = own.current
    if (!node) return
    const check = () => setYielded(sessionWriterElsewhere(sessionId, node.ownerDocument, node))
    // Streaming transcripts mutate the DOM constantly: one check per frame at most.
    let frame = 0
    const observer = new MutationObserver(() => { frame ||= requestAnimationFrame(() => { frame = 0; check() }) })
    observer.observe(node.ownerDocument.body, { childList: true, subtree: true })
    check()
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [sessionId, own.current])
  return yielded
}

export function EmbeddedSession({ host, sessionId, reference, label }) {
  const own = React.useRef(null), [, mounted] = React.useReducer(value => value + 1, 0)
  const yielded = useWriterYield(sessionId, own)
  // `inert` through the DOM: the attribute's React prop form differs across React versions.
  React.useLayoutEffect(() => { own.current?.toggleAttribute('inert', yielded) }, [yielded])
  return h(React.Fragment, null,
    yielded && h('p', { className: 'kode-builder-event kode-builder-embed-yield', role: 'status' }, `此${label}已在其他位置打开输入框，这里的输入框暂停使用；关闭那里后会自动恢复。`),
    h('div', { ref: node => { if (node && own.current !== node) { own.current = node; mounted() } },
      className: 'kode-builder-native-session', 'data-planning-session': sessionId, 'data-writer-yielded': yielded ? '' : undefined,
      'aria-hidden': yielded ? 'true' : undefined },
    host.renderSession(reference)))
}

/**
 * Retains the real Session for as long as it is embedded and Orbit is the active
 * panel; leaving releases it so the native session mode owns the only composer.
 * The pending text settles only once the native draft applied or preserved it; a
 * failed fill releases the reference at once and keeps the text for an explicit retry.
 * Without text it is the same chain for any existing Session Orbit shows in place.
 */
export function PlanningSessionEmbed({ host, sessionId, text, onOffered, label = '规划会话' }) {
  const active = React.useSyncExternalStore(host.panel.subscribe, host.panel.isActive)
  const [state, setState] = React.useState({ phase: 'loading', reference: null })
  const [attempt, retry] = React.useReducer(value => value + 1, 0)
  const settled = React.useRef('')
  const pending = React.useRef(text)
  pending.current = text
  React.useEffect(() => {
    if (!active) return
    const controller = new AbortController(), aborted = () => controller.signal.aborted
    let reference = null
    // The failed reference is released only after its Session subtree has unmounted.
    const stop = phase => {
      const retired = reference; reference = null
      if (aborted()) retired?.release(); else setState({ phase, reference: null, retired })
    }
    setState({ phase: 'loading', reference: null })
    void (async () => {
      try {
        await host.sessions.refresh()
        if (aborted()) return
        if (sessionWriterElsewhere(sessionId)) return stop('occupied')
        reference = host.sessions.retain(sessionId, { source: PLANNING_RETAIN_SOURCE, signal: controller.signal })
        setState({ phase: 'ready', reference })
        await reference.ready
      } catch { if (!aborted()) stop('load_failed'); return }
      if (aborted() || settled.current === sessionId) return
      const prompt = pending.current
      let result
      try { result = prompt ? await offerPlanningText(host, sessionId, prompt) : 'opened' } catch { result = 'failed' }
      if (aborted()) return
      if (!SETTLED.has(result)) return stop('fill_failed')
      settled.current = sessionId
      // The native draft already holds the outcome; the parent's own persistence never re-offers it.
      try { await onOffered?.(result) } catch {}
    })()
    return () => { controller.abort(); reference?.release() }
  }, [active, sessionId, attempt])
  React.useEffect(() => { state.retired?.release() }, [state.retired])
  if (!active) return null
  const status = (message, action) => h('div', { className: 'kode-builder-embed-status', role: 'status' },
    h('p', { className: 'kode-builder-event' }, message), action && h(Button, { variant: 'text', onClick: retry }, action))
  switch (state.phase) {
    case 'load_failed': return status(`无法载入${label}，请重试或在会话模式中打开。`, '重试载入')
    case 'fill_failed': return status(`${label}已打开，但目标未能填入它的输入框；没有发送任何内容，目标与补充仍保留。`, '重试填入')
    case 'occupied': return status(`此${label}正在其他位置编辑。为避免两个输入框争用同一份草稿，这里暂不显示输入框。`, '重新检查')
  }
  if (!state.reference) return status(`正在载入${label}…`)
  return h(EmbeddedSession, { host, sessionId, reference: state.reference, label })
}
