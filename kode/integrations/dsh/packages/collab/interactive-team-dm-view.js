import React from 'react'
import { discussionKey } from './discussion-model.js'
import { readInteractiveDms, selectInteractiveDm } from './interactive-team-dm.js'
const h = React.createElement

/** Read-only bridge to an explicitly chosen, existing discussion DM.
 * The legacy history and unsent draft stay exactly where they were.
 */
export function InteractiveTeamDmEntry({ team, scope, onOpen, onCreate }) {
  const [rows, setRows] = React.useState(null), [selected, setSelected] = React.useState('')
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const [reload, refresh] = React.useReducer(n => n + 1, 0)
  const active = React.useRef(null), opening = React.useRef(false)
  const key = scope ? discussionKey(scope) : ''
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller; opening.current = false
    setRows(null); setSelected(''); setError(''); setBusy(false)
    readInteractiveDms({ team, scope, signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setRows(value)
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message || '无法读取已有原生私信。') })
    return () => controller.abort()
  }, [team.id, team.home_hub, team.revision, key, reload])
  const open = async () => {
    const controller = active.current
    if (opening.current || !selected || !rows || controller?.signal.aborted) return
    opening.current = true; setBusy(true); setError('')
    try {
      const target = await selectInteractiveDm({ team, scope, surfaceId: selected, signal: controller.signal })
      if (!controller.signal.aborted) onOpen(target)
    } catch (failure) {
      if (!controller.signal.aborted) { setSelected(''); setError(failure.message || '无法打开所选私信，请重新读取。') }
    } finally {
      if (!controller.signal.aborted) { opening.current = false; setBusy(false) }
    }
  }
  return h('section', { className: 'kode-collab-composer', 'aria-label': '原生团队私信入口' },
    h('p', { className: 'kode-collab-note' }, '此团队使用原生 CLI / 模型交互。请选择已有原生私信，再选择职责和执行组合；打开私信不会发送消息。'),
    h('p', { className: 'kode-collab-note' }, '这里的历史与未发送草稿会保留，不会复制到所选私信。'),
    rows?.length ? h('label', null, '已有原生私信', h('select', { 'aria-label': '已有原生私信', value: selected, disabled: busy,
      onChange: event => { setSelected(event.target.value); setError('') } }, h('option', { value: '' }, '请选择私信'),
      rows.map(row => h('option', { key: row.id, value: row.id }, `${row.title || '未命名私信'} · ${row.id}`))))
      : h('p', { role: 'status', className: 'kode-collab-note' }, rows ? '当前工作区没有可用的已有原生私信，尚未发送任务。' : error ? '' : '正在读取已有原生私信…'),
    rows?.length === 0 && onCreate && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: onCreate }, '开始原生私信'),
    h('button', { type: 'button', className: 'kode-collab-button', disabled: !selected || busy || !rows, onClick: () => void open() }, busy ? '正在核对私信…' : '打开所选原生私信'),
    h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => refresh() }, '重新读取私信'),
    error && h('p', { role: 'alert', className: 'kode-collab-note' }, error))
}
