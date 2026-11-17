import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { builderConversationStyles } from './builder-conversation-styles.js'
import { openPlanningSession } from './builder-planning.js'
import { PlanningSessionEmbed } from './planning-session-embed.js'
import { sessionViewTabStyles } from './session-view-tabs.js'
import { IconButton } from './icons.js'
const h = React.createElement

const sessionTitle = row => row?.displayTitle || row?.title || '未命名会话'
const emptyViewSource = { subscribe: () => () => {}, getSnapshot: () => [] }

/**
 * An existing native Session opened from Orbit's sidebar, shown in Orbit's canvas through
 * the same retained-reference chain as the planning Session: the native transcript,
 * composer and model seat, one writer, nothing sent or rebound on open.
 */
export function OrbitSessionView({ host, views, viewSource = emptyViewSource, sessionId, actions = null, onClose }) {
  const list = host.sessions?.list
  const row = React.useSyncExternalStore(list?.subscribe ?? (() => () => {}), () => list?.getSnapshot()?.byId?.[sessionId] ?? null)
  const viewTabs = React.useSyncExternalStore(viewSource.subscribe, viewSource.getSnapshot)
  const hasTabs = viewTabs.length > 1
  const [shown, setShown] = React.useState(true), [notice, setNotice] = React.useState('')
  React.useEffect(() => { setShown(true); setNotice('') }, [sessionId])
  const title = sessionTitle(row)
  const sessionHost = React.useMemo(() => views ? Object.assign(Object.create(host), {
    renderSession: reference => host.renderSession(reference, { views }),
  }) : host, [host, views])
  const openInSessionMode = async () => {
    // Unmount (and release) the embedded composer first: one writer per Session.
    setShown(false); setNotice('')
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    try { await openPlanningSession(host, sessionId, '') }
    catch { setShown(true); setNotice('无法在会话模式打开，请刷新会话列表后重试。') }
  }
  return h('section', { className: 'kode-collab-builder kode-builder-conversation-layout kode-orbit-session', 'aria-label': `会话：${title}`, 'data-orbit-session': sessionId },
    h('style', null, builderConversationStyles + sessionViewTabStyles + orbitSessionStyles),
    h('header', { className: 'kode-builder-topbar' + (hasTabs ? ' kode-builder-topbar-with-tabs' : '') },
      h('h1', { className: 'kode-builder-title', title }, title),
      h('div', { className: 'kode-builder-header-actions' },
        // Ordinary Sessions only (managed ones never open here): the native handoff keeps this Session.
        row && shown && actions,
        h(Button, { variant: 'text', onClick: () => void openInSessionMode() }, '在会话模式打开'),
        h(IconButton, { icon: 'close', label: '关闭会话，返回私信', onClick: onClose }))),
    notice && h('p', { className: 'kode-builder-event', role: 'status' }, notice),
    h('div', { className: 'kode-builder-native-session-frame' },
      shown && h(PlanningSessionEmbed, { host: sessionHost, sessionId, label: '会话' })))
}

const orbitSessionStyles = `
.kode-orbit-session>.kode-builder-event{padding:0 24px;margin:0 0 8px}
`
