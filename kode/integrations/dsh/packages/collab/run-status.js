import React from 'react'
const h = React.createElement

import { Icon } from './icons.js'
import { runPresentation } from './run-presentation.js'

export function RunStatus({ run, label }) {
  const { tone, icon } = runPresentation(run)
  return h('p', { className: 'kode-collab-run-status', 'data-tone': tone },
    h(Icon, { name: icon, size: 16 }),
    h('span', null, label), h('span', { className: 'kode-collab-delivery-label' }, run.completion_authorized ? 'Hub 已确认交付' : '尚未确认交付'))
}
