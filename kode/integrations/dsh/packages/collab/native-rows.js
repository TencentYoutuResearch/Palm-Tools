/** Orbit sidebar rows on the native workspace list anatomy.
 * ui-workspace exports no row component, but its CSS modules inject themselves as
 * `style[data-plugin-css=…]` when the package loads, so these rows use the same classes,
 * primitives (Menu, Tooltip, HoverCard, icons) and hover-only actions as session mode.
 * The CSS-module hash differs between builds of the same version, so class names are never
 * hardcoded: they are read from the native style tags actually loaded in this page. When a
 * tag is missing the tree reports it instead of rendering unstyled rows (see nativeCss). */
import React from 'react'
import * as UI from '@deepseek-ai/dsh-client-ui-primitives'
const h = React.createElement

export const NATIVE_CSS = Object.freeze({ rows: '@deepseek-ai/dsh-client-ui-workspace/Rows.module.css', list: '@deepseek-ai/dsh-client-ui-workspace/WorkspaceBrowser.module.css' })
const ROW_NAMES = ['projectRow', 'sessionRow', 'selected', 'menuOpen', 'archived', 'rowActions', 'iconButton', 'slot', 'folder', 'folderActive', 'chevron', 'arrow',
  'arrowOpen', 'projectText', 'title', 'time', 'pinIndicator', 'hoverContent', 'hoverTitle', 'hoverPath', 'hoverStatus', 'visuallyHidden']
const LIST_NAMES = { sectionHeader: 'sectionHeader', sectionLabel: 'sectionLabel', headerActions: 'headerActions', iconButton: 'iconButton', groupSection: 'groupSection', overflow: 'sessionOverflowButton' }

/** The hash prefix of one native CSS module, read from its injected style tag. */
export function nativeCssPrefix(tag, anchor, doc = globalThis.document) {
  const text = doc?.querySelector?.(`style[data-plugin-css=${JSON.stringify(tag)}]`)?.textContent
  const match = text && new RegExp(`\\.([A-Za-z0-9-]+)_${anchor}\\b`).exec(text)
  return match ? match[1] : null
}

/** Resolves once both native modules are present; observes <head> until then. */
export const nativeCss = (() => {
  let prefixes = null, observer = null
  const listeners = new Set()
  const resolve = () => {
    if (prefixes) return prefixes
    const rows = nativeCssPrefix(NATIVE_CSS.rows, 'sessionRow'), list = nativeCssPrefix(NATIVE_CSS.list, 'groupSection')
    if (rows && list) { prefixes = { rows, list }; observer?.disconnect(); observer = null; for (const fn of listeners) fn() }
    return prefixes
  }
  return {
    resolve,
    getSnapshot: () => !!resolve(),
    subscribe(fn) {
      listeners.add(fn)
      if (!resolve() && !observer && typeof MutationObserver === 'function' && globalThis.document?.head) {
        observer = new MutationObserver(() => resolve()); observer.observe(document.head, { childList: true, subtree: true, characterData: true })
      }
      return () => listeners.delete(fn)
    },
  }
})()

// Lazy maps: each read uses the loaded build's prefix. Unresolved reads give an inert class.
const lazyClasses = (names, module) => Object.freeze(Object.defineProperties({}, Object.fromEntries(Object.entries(names).map(([key, local]) =>
  [key, { enumerable: true, get: () => `${nativeCss.resolve()?.[module] ?? 'kode-native-unresolved'}_${local}` }]))))
export const ROW = lazyClasses(Object.fromEntries(ROW_NAMES.map(name => [name, name])), 'rows')
export const LIST = lazyClasses(LIST_NAMES, 'list')

const cx = (...names) => names.filter(Boolean).join(' ')
export const indent = depth => ({ '--dsh-workspace-indent': `${depth * 12}px` })
const stop = event => event.stopPropagation()
// Rows are focusable treeitems; Enter/Space act like the click, never from a nested control.
const keyActivate = fn => event => { if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return; event.preventDefault(); fn?.() }

/** A 16px row action with the native delayed tooltip. */
export function RowAction({ label, onClick, disabled, children }) {
  return h(UI.Tooltip, { label, side: 'bottom', align: 'end', delayMs: 500, portal: true },
    h('button', { type: 'button', className: ROW.iconButton, 'aria-label': label, disabled, onClick: event => { event.stopPropagation(); onClick() } }, children))
}

/** The row's "…" menu: either plain items or a native seat's children. */
function RowMenu({ label, items, onSelect, render, open, setOpen }) {
  const state = React.useMemo(() => [open, setOpen], [open, setOpen])
  return h(UI.Menu, { open, onClose: () => setOpen(false), portal: true, closeOnPointerLeave: true,
    ...(render ? { children: open ? render(state) : null } : { items, onSelect: id => { setOpen(false); onSelect(id) } }),
    anchor: h('button', { type: 'button', className: ROW.iconButton, 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': open,
      onClick: event => { event.stopPropagation(); setOpen(value => !value) } }, h(UI.IconEllipsisOutlineRegular, null)) })
}

export function HoverText({ title, detail }) {
  return h('div', { className: ROW.hoverContent }, h('div', { className: ROW.hoverTitle }, title), detail && h('div', { className: ROW.hoverPath }, detail))
}

/** A folder-style row: workspace projects and their 频道/私信/会话 groups. */
export function ProjectRow({ rowKey, label, title = label, expanded, active, depth = 0, icon, onToggle, menu, actions, hover, copyText, className, ...rest }) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const row = h('div', { className: cx(ROW.projectRow, menuOpen && ROW.menuOpen, className), 'data-row-key': rowKey, role: 'treeitem', 'aria-expanded': expanded,
    tabIndex: 0, style: indent(depth), onClick: onToggle, onKeyDown: keyActivate(onToggle), ...rest },
    h('span', { className: cx(ROW.slot, ROW.folder, active && ROW.folderActive), 'aria-hidden': true },
      icon ?? (expanded ? h(UI.IconFolderOpenRegular, null) : h(UI.IconFolderCloseRegular, null))),
    h('span', { className: cx(ROW.slot, ROW.chevron), 'aria-hidden': true }, h(UI.IconTriangleRightFillRegular, { className: cx(ROW.arrow, expanded && ROW.arrowOpen) })),
    h('span', { className: ROW.projectText }, h('span', { className: ROW.title, title }, label)),
    (menu || actions) && h('span', { className: ROW.rowActions, 'data-row-actions': '', onClick: stop }, menu && h(RowMenu, { ...menu, open: menuOpen, setOpen: setMenuOpen }), actions))
  return hover ? h(UI.HoverCard, { anchor: row, content: hover, openDelayMs: 800, grouped: true, disabled: menuOpen, copyText, copyLabel: '复制', copiedLabel: '已复制' }) : row
}

/** A leaf row: channel, DM, Team Builder or Session. Actions show on hover or while the menu is open. */
export function ItemRow({ rowKey, kind, depth = 2, leading, title, selected, archived, pinned, trailing, trailingLabel, onOpen, menu, actions, hover, copyText, label, className, ...rest }) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const row = h('div', { className: cx(ROW.sessionRow, selected && ROW.selected, menuOpen && ROW.menuOpen, archived && ROW.archived, className),
    'data-row-key': rowKey, 'data-sidebar-row': kind, role: 'treeitem', 'aria-selected': !!selected, 'aria-current': selected ? 'page' : undefined,
    'aria-label': label, tabIndex: 0, style: indent(depth), onClick: onOpen, onKeyDown: keyActivate(onOpen), ...rest },
    h('span', { className: ROW.slot, 'aria-hidden': true }, leading),
    h('span', { className: ROW.title, 'data-row-title': '' }, title),
    trailing != null && trailing !== false && h('span', { className: ROW.time, 'aria-label': trailingLabel }, trailing),
    pinned && !archived && h('span', { className: ROW.pinIndicator, role: 'img', 'aria-label': '已置顶', title: '已置顶' }, h(UI.IconPinFillRegular, { size: 14 })),
    (menu || actions) && h('span', { className: ROW.rowActions, 'data-row-actions': '', onClick: stop }, menu && h(RowMenu, { ...menu, open: menuOpen, setOpen: setMenuOpen }), actions))
  return hover ? h(UI.HoverCard, { anchor: row, content: hover, openDelayMs: 800, grouped: true, disabled: menuOpen, copyText, copyLabel: '复制', copiedLabel: '已复制' }) : row
}

/** Pin and archive as the native row buttons (archive first, pin second; pin hidden when archived). */
export function PinArchiveActions({ pinned, archived, busy, onPin, onArchive }) {
  return h(React.Fragment, null,
    h(RowAction, { label: archived ? '移出归档' : '归档', disabled: busy, onClick: onArchive },
      archived ? h(UI.IconUnarchiveOutlineRegular, { size: 14 }) : h(UI.IconArchiveOutlineRegular, { size: 14 })),
    !archived && h(RowAction, { label: pinned ? '取消置顶' : '置顶', disabled: busy, onClick: onPin },
      pinned ? h(UI.IconPinFillRegular, { size: 14 }) : h(UI.IconPinOutlineRegular, { size: 14 })))
}

/** Presentation-only pin/archive for rows without a server preference (channels, discussion DMs).
 * Stored on this device; never changes a conversation, its members or any execution. */
export function createLocalRowPreferences(storage, key = 'kode.collab.row-preferences.v1') {
  const listeners = new Set()
  let value = read()
  function read() {
    try { const parsed = JSON.parse(storage?.getItem(key) ?? 'null'); return { pinned: Array.isArray(parsed?.pinned) ? parsed.pinned.filter(id => typeof id === 'string') : [], archived: Array.isArray(parsed?.archived) ? parsed.archived.filter(id => typeof id === 'string') : [] } }
    catch { return { pinned: [], archived: [] } }
  }
  const write = next => { value = next; try { storage?.setItem(key, JSON.stringify(next)) } catch {} for (const fn of listeners) fn() }
  const toggle = (list, id) => value[list].includes(id) ? value[list].filter(item => item !== id) : [...value[list], id]
  return {
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    getSnapshot: () => value,
    togglePin: id => write({ ...value, pinned: toggle('pinned', id) }),
    toggleArchive: id => write({ pinned: value.pinned.filter(item => item !== id), archived: toggle('archived', id) }),
  }
}

/** Pinned first, archived out of the main list; stable otherwise. */
export function arrangeRows(rows, idOf, preferences) {
  const pinned = new Set(preferences.pinned), archived = new Set(preferences.archived)
  const live = rows.filter(row => !archived.has(idOf(row)))
  return { rows: [...live.filter(row => pinned.has(idOf(row))), ...live.filter(row => !pinned.has(idOf(row)))], archived: rows.filter(row => archived.has(idOf(row))) }
}

/** The native list's "show more" affordance, used for a group's archived rows. */
export function OverflowButton({ depth = 2, expanded, onClick, children }) {
  return h('button', { type: 'button', className: LIST.overflow, style: indent(depth), 'aria-expanded': expanded, onClick }, children)
}

export const nativeRowStyles = () => `
.kode-native-tree [role=treeitem]:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.kode-native-tree summary{list-style:none}.kode-native-tree summary::-webkit-details-marker{display:none}
.kode-native-tree .kode-sidebar-group-row{height:30px;color:var(--dsw-alias-label-secondary)}
.kode-native-tree .kode-sidebar-group-row .${ROW.title}{font-size:13px}
.kode-native-tree .kode-sidebar-group-row[data-actions-visible] .${ROW.rowActions}{display:inline-flex}
/* Native rows swap the section icon for the chevron on hover only; keyboard focus and touch get the same swap, touch a 44px target. */
.kode-native-tree .kode-sidebar-group-row:focus-visible .${ROW.chevron}{display:inline-flex}
.kode-native-tree .kode-sidebar-group-row:focus-visible .${ROW.folder}{display:none}
@media (hover:none),(pointer:coarse){.kode-native-tree .kode-sidebar-group-row{height:auto;min-height:44px}.kode-native-tree .kode-sidebar-group-row .${ROW.chevron}{display:inline-flex}.kode-native-tree .kode-sidebar-group-row .${ROW.folder}{display:none}}
.kode-native-tree .${ROW.sessionRow} .${ROW.slot} img,.kode-native-tree .${ROW.sessionRow} .${ROW.slot} [data-avatar]{max-width:16px;max-height:16px}
.kode-native-tree .${ROW.sessionRow} .${ROW.slot}>span{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;overflow:hidden;border-radius:4px}
.kode-native-tree .kode-sidebar-unread{min-width:16px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-primary,#fff);font-size:10px;line-height:16px;text-align:center}
.kode-native-tree .kode-sidebar-attention{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}
.kode-native-tree .kode-sidebar-empty{margin:0;padding:2px 8px 6px calc(30px + var(--dsh-workspace-indent,0px));color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.kode-native-tree .kode-sidebar-empty button:not(.kode-collab-icon-button){padding:0;border:0;background:none;color:var(--dsw-alias-link);font:inherit;cursor:pointer}
`
