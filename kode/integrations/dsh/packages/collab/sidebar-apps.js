/** Reuse registered application navigation without installing plugins or connecting external services. */
import React from 'react'
import { Button, Tooltip, IconPluginPinwheelOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { APPLICATION_CONNECTION_NOTE, createSidebarAppsSource, openPluginManagement, openSidebarApplication } from './sidebar-app-source.js'
const h = React.createElement
const noopSubscribe = () => () => {}
const emptyPanel = () => null

/** renderSlot, when supplied, must be the sidebar owner's face for sidebar.panellist. */
export function SidebarApps({ ctx, renderSlot, wide = true, showConnectionNote = true, showHeading = false }) {
  const source = React.useMemo(() => createSidebarAppsSource({ slots: ctx.slots, locale: ctx.locale }), [ctx])
  const entries = React.useSyncExternalStore(source.subscribe, source.getSnapshot)
  const panelInfo = ctx.layout?.panelInfo
  const panelSource = React.useMemo(() => panelInfo ? {
    subscribe: listener => panelInfo.subscribe(listener), getSnapshot: () => panelInfo.getSnapshot().activePanelId ?? null,
  } : { subscribe: noopSubscribe, getSnapshot: emptyPanel }, [panelInfo])
  const activePanel = React.useSyncExternalStore(panelSource.subscribe, panelSource.getSnapshot)
  const disabled = typeof ctx.layout?.selectPanel !== 'function'
  const icon = (id, active) => renderSlot
    ? renderSlot('sidebar.panellist', { size: wide ? 16 : 18, active }, { only: id })
    : h(IconPluginPinwheelOutlineRegular, { size: wide ? 16 : 18, 'aria-hidden': true })
  return h('section', { className: 'kode-sidebar-apps', 'aria-label': '应用' },
    wide && showHeading && h('h3', { className: 'kode-sidebar-section-label' }, '应用'),
    entries.length ? h('div', { className: 'kode-sidebar-app-list' }, ...entries.map(entry =>
      h(Tooltip, { key: entry.id, label: entry.label, delayMs: 500, disabled: wide },
        h(Button, { type: 'button', className: 'kode-sidebar-row kode-sidebar-app-entry', 'data-panel-id': entry.id,
          'aria-label': entry.label, 'aria-current': activePanel === entry.id ? 'page' : undefined,
          disabled, onClick: () => openSidebarApplication(ctx, entry.id) },
        h('span', { className: 'kode-sidebar-app-icon', 'aria-hidden': true }, icon(entry.id, activePanel === entry.id)),
        h('span', { className: wide ? 'kode-sidebar-app-label' : 'kode-collab-sr-only' }, entry.label)))))
      : h(React.Fragment, null,
        wide && h('p', { className: 'kode-sidebar-app-note' }, '尚无额外应用入口'),
        h(Tooltip, { label: '管理插件', delayMs: 500, disabled: wide },
          h(Button, { type: 'button', className: 'kode-sidebar-row kode-sidebar-app-entry', 'aria-label': '管理插件', disabled,
            onClick: () => openPluginManagement(ctx) },
          h(IconPluginPinwheelOutlineRegular, { size: wide ? 16 : 18, 'aria-hidden': true }),
          h('span', { className: wide ? 'kode-sidebar-app-label' : 'kode-collab-sr-only' }, '管理插件')))),
    wide && showConnectionNote && h('p', { className: 'kode-sidebar-app-note' }, APPLICATION_CONNECTION_NOTE))
}
