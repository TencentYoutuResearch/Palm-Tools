import { TeamConfigurationForm } from './team-configuration-form.js'
import { IconButton } from './icons.js'
import React from 'react'
import { TeamActivationView } from './team-activation-view.js'
import { readTeamConfiguration } from './team-agent-defaults.js'
const h = React.createElement
/** Refresh configuration from the owner Hub; directory and browser receipts are not live authority. */
export function TeamManagementView({ team, request, storage, controls, focusInstructions, onSaved }) {
  const [configuration, setConfiguration] = React.useState(null), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), generation = React.useRef(0)
  const refresh = async () => {
    active.current?.abort()
    const controller = new AbortController(); active.current = controller
    setBusy(true); setMessage('')
    // Old configuration cannot be confirmed while a refresh is unresolved.
    setConfiguration(null)
    try {
      const row = await readTeamConfiguration(request, team, controller.signal)
      if (!controller.signal.aborted) { generation.current++; setConfiguration(row) }
    } catch { if (!controller.signal.aborted) setMessage('无法读取团队配置，请重试。') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  React.useEffect(() => { void refresh(); return () => active.current?.abort() }, [team.id, team.home_hub])
  return h('section', { className: 'kode-collab-team-management', 'aria-label': '团队管理' }, h('h2', null, '团队管理'),
    h(IconButton, { icon: 'refresh', label: busy ? '正在读取配置…' : '刷新团队配置', disabled: busy, onClick: () => void refresh() }),
    configuration && h('div', null, h('p', null, configuration.spec.purpose), h(TeamConfigurationForm, { key: `edit-${generation.current}`, team: configuration, storage, controls, focusInstructions, onSaved: row => { onSaved?.(row); generation.current++; setConfiguration(row); setMessage(row.spec.execution_mode === 'interactive_native' ? `已保存第 ${row.revision} 版配置，身份与历史保持不变。尚未发送任务；请在下方单独确认当前版本。` : `已保存第 ${row.revision} 版草稿，尚未激活。`) } }), configuration.spec.execution_mode === 'interactive_native' && h(TeamActivationView, { key: generation.current, team: configuration, storage })),
    message && h('p', { role: 'status' }, message))
}
