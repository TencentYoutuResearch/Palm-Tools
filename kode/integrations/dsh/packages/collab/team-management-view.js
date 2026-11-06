import React from 'react'
import { TeamActivationView } from './team-activation-view.js'
const h = React.createElement
/** Refresh configuration from the owner Hub; directory and browser receipts are not live authority. */
export function TeamManagementView({ team, request, storage }) {
  const [configuration, setConfiguration] = React.useState(null), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), generation = React.useRef(0)
  const refresh = async () => {
    active.current?.abort()
    const controller = new AbortController(); active.current = controller
    setBusy(true); setMessage('')
    // Old configuration cannot be confirmed while a refresh is unresolved.
    setConfiguration(null)
    try {
      const value = await request(`/api/kode/collab/teams?team_id=${encodeURIComponent(team.id)}`, { signal: controller.signal })
      const row = value.team
      if (value.projection !== 'configuration_revision' || row?.id !== team.id || row.home_hub !== team.home_hub
        || row.superagent_id !== team.superagent_id || row.conversation_id !== team.conversation_id || !Number.isSafeInteger(row.revision) || row.revision < 1) throw Error('Wrong team configuration')
      if (!controller.signal.aborted) { generation.current++; setConfiguration(row) }
    } catch { if (!controller.signal.aborted) setMessage('无法读取团队配置，请重试。') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  React.useEffect(() => { void refresh(); return () => active.current?.abort() }, [team.id, team.home_hub])
  return h('section', { className: 'kode-collab-team-management', 'aria-label': '团队管理' }, h('h2', null, '团队管理'),
    h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void refresh() }, busy ? '正在读取配置…' : '刷新团队配置'),
    configuration && h('div', null, h('p', null, configuration.spec.purpose), h(TeamActivationView, { key: generation.current, team: configuration, storage })),
    message && h('p', { role: 'status' }, message))
}
