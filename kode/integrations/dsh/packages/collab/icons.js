/** Prefer dsh primitives; navigation bubbles/hash use unchanged upstream Lucide icons. */
import React from 'react'
import {LucideIcon} from './vendor/lucide/icons.js'
import * as UI from '@deepseek-ai/dsh-client-ui-primitives'
const h = React.createElement
const icons = {
 plus: UI.IconPlusOutlineRegular, refresh: UI.IconRefreshOutlineRegular, search: UI.IconSearchOutlineRegular,
 close: UI.IconCloseOutlineRegular, archive: UI.IconArchiveOutlineRegular, more: UI.IconEllipsisOutlineRegular,
 chat: UI.IconNewChatOutlineRegular, session: UI.IconFlatListOutlineRegular, panel: UI.IconPanelLeftOutlineRegular,
 settings: UI.IconSettingsOutlineRegular, wallet: UI.IconGaugeOutlineRegular,
 process: UI.IconChecklistOutlineRegular, send: UI.IconSendOutlineRegular,
 down: UI.IconChevronDownOutlineRegular, right: UI.IconChevronRightOutlineRegular,
 check: UI.IconCheckOutlineRegular, alert: UI.IconWarningTriangleOutlineRegular,
 activity: UI.IconLoadingOutlineRegular, pause: UI.IconPauseOutlineRegular,
 clock: UI.IconClockOutlineRegular, user: UI.IconUserOutlineRegular,
 users: UI.IconUsersOutlineRegular, agent: UI.IconAgentPresetOutlineRegular,
 appearance: UI.IconPersonalizationOutlineRegular, folder: UI.IconFolderCloseRegular,
 edit: UI.IconEditOutlineRegular,
}
export function Icon({ name, size = 18 }) {
 if (name==='session'||name==='chat'||name==='channel') return h(LucideIcon,{name:name==='channel'?'hash':'message-square',size})
 return h(icons[name] ?? UI.IconInfoOutlineRegular, { size, 'aria-hidden': true, focusable: false })
}
export function IconButton({ icon, label, className = '', size, ...props }) {
 return h(UI.Tooltip, { label }, h(UI.Button, { type:'button', ...props,
  className:`kode-collab-icon-button ${size === 'sm' ? 'kode-collab-icon-button-sm' : ''} ${className}`.trim(), title:label, 'aria-label':label },
  h(Icon, {name:icon, size:size === 'sm' ? 14 : 18}), h('span',{className:'kode-collab-sr-only'},label)))
}
