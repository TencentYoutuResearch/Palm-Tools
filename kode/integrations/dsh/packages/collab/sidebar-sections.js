/** Independent presentation preferences; never change a conversation, Session or execution. */
import React from 'react'
import { IconTriangleRightFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { Icon } from './icons.js'
import { ROW, LIST, indent } from './native-rows.js'
const h = React.createElement
export const SECTION_IDS = Object.freeze(['channels', 'direct', 'sessions', 'apps', 'threads'])
export const DEFAULT_SECTIONS = Object.freeze({ channels: true, direct: true, sessions: true, apps: true, threads: true })
export const SIDEBAR_SECTIONS_KEY = 'kode.collab.sidebar.sections.v1'

function normalizeSections(value) {
  const result = { ...DEFAULT_SECTIONS }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const id of SECTION_IDS) if (Object.hasOwn(value, id) && typeof value[id] === 'boolean') result[id] = value[id]
  return result
}
export function loadSections(storage, key = SIDEBAR_SECTIONS_KEY) {
  try { return normalizeSections(JSON.parse(storage?.getItem(key) ?? 'null')) }
  catch { return { ...DEFAULT_SECTIONS } }
}
/** False means storage is unavailable; the caller's in-memory state remains authoritative. */
export function saveSections(storage, value, key = SIDEBAR_SECTIONS_KEY) {
  try {
    if (typeof storage?.setItem !== 'function') return false
    storage.setItem(key, JSON.stringify(normalizeSections(value)))
    return true
  } catch { return false }
}

/** Native keyboard disclosure on the native project-row anatomy (folder slot yields to the
 * chevron on hover, actions only on hover). Keep the body mounted so Session state survives folding. */
export function SidebarSection({ id, label, icon, open, onToggle, children, actions, headerContent, className = '', depth = 1, actionsVisible = false }) {
  if (!SECTION_IDS.includes(id)) throw new Error('Unknown sidebar section')
  const [internalOpen, setInternalOpen] = React.useState(DEFAULT_SECTIONS[id])
  const controlled = typeof open === 'boolean', expanded = controlled ? open : internalOpen
  const instance = React.useId()
  const summaryId = `kode-sidebar-section-${id}-${instance}`, bodyId = `${summaryId}-body`
  return h('details', { className: `kode-sidebar-section ${className}`.trim(), 'data-sidebar-section': id, open: expanded,
    onToggle: event => {
      if (event.target !== event.currentTarget) return
      const next = event.currentTarget.open
      if (next === expanded) return
      if (!controlled) setInternalOpen(next)
      onToggle?.(next, id)
    } },
    h('summary', { className: `${ROW.projectRow} kode-sidebar-group-row`, id: summaryId, 'aria-label': label,
      'aria-expanded': expanded, 'aria-controls': bodyId, style: indent(depth), 'data-actions-visible': actionsVisible || undefined },
      h('span', { className: `${ROW.slot} ${icon ? ROW.folder : ''}`.trim(), 'aria-hidden': true }, icon && h(Icon, { name: icon, size: 16 })),
      h('span', { className: `${ROW.slot} ${ROW.chevron}`, 'aria-hidden': true },
        h(IconTriangleRightFillRegular, { className: `${ROW.arrow} ${expanded ? ROW.arrowOpen : ''}`.trim() })),
      h('span', { className: ROW.projectText }, h('span', { className: ROW.title }, headerContent ?? label)),
      actions && h('span', { className: ROW.rowActions, 'data-row-actions': '', onClick: event => { event.stopPropagation(); event.preventDefault() } }, actions)),
    h('div', { className: `${LIST.groupSection} kode-sidebar-section-body`, id: bodyId, role: 'group', 'aria-labelledby': summaryId }, children))
}
