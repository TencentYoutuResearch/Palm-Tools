import React from 'react'
import { BuilderStartForm } from './builder-start-form.js'
import { builderStartKey } from './builder-start-command.js'
const h = React.createElement
/** Existing controlled Builder starts stay viewable. No new legacy start is offered:
 * budget and grants belong to automatic team execution, not planning chat. */
export function BuilderLegacySession({ draft, storage, request, onDraftUpdated }) {
  const [state, setState] = React.useState('loading')
  React.useEffect(() => {
    let alive = true
    storage.read(builderStartKey(draft)).then(value => { if (alive) setState(value ? 'present' : 'absent') }).catch(() => { if (alive) setState('error') })
    return () => { alive = false }
  }, [draft.id, draft.home_hub])
  if (state === 'absent' || state === 'loading') return null
  if (state === 'error') return h('p', { role: 'status' }, '无法读取旧版搭建记录。')
  return h('details', { className: 'kode-builder-legacy' }, h('summary', null, '旧版受控搭建会话'),
    h('p', { className: 'kode-config-note' }, '此草案曾通过旧流程启动，记录保留可查看；不会自动切换到新的规划会话。'),
    h(BuilderStartForm, { draft, storage, request, onDraftUpdated }))
}
