import React from 'react'
const h = React.createElement
export function SessionDiagnostics({ run, request, onOpenSession }) {
  const [opened, setOpened] = React.useState(false), [page, setPage] = React.useState(null)
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const active = React.useRef(null)
  React.useEffect(() => () => active.current?.abort(), [run.id, run.team_id, run.home_hub])
  const open = async item => {
    setError('')
    try { await onOpenSession(run, item) }
    catch { setError('无法打开此执行 Host 的原生会话，请核对连接与会话归属。') }
  }
  const load = async append => {
    active.current?.abort()
    const controller = new AbortController(); active.current = controller
    setOpened(true); setBusy(true); setError('')
    try {
      if (append && page.run_revision !== run.revision) throw Error('Refresh changed run first')
      const query = new URLSearchParams({ run_id: run.id, view: 'diagnostics', run_revision: String(run.revision),
        ...(append ? { after: page.next_cursor } : {}) })
      const result = await request(`/api/kode/work-run?${query}`, { signal: controller.signal })
      if (result?.schema_version !== 1 || result.home_hub !== run.home_hub || result.team_id !== run.team_id || result.run_id !== run.id
        || result.run_revision !== run.revision || result.read_only !== true || result.scope !== 'home_durable_assignment_metadata'
        || !Array.isArray(result.items) || result.items.length > 25 || (result.next_cursor !== null && typeof result.next_cursor !== 'string')) throw Error('Invalid diagnostic scope')
      let previous = append ? page.next_cursor : ''
      for (const item of result.items) {
        if (typeof item.assignment_id !== 'string' || item.assignment_id <= previous || typeof item.worker?.node_id !== 'string'
          || typeof item.worker?.session_id !== 'string' || typeof item.operation?.id !== 'string' || item.session_access !== 'read_only'
          || item.runtime_liveness !== 'not_probed') throw Error('Invalid diagnostic session')
        previous = item.assignment_id
      }
      if (result.next_cursor !== null && result.next_cursor !== previous) throw Error('Invalid diagnostic cursor')
      if (!controller.signal.aborted) setPage({ ...result, items: append ? [...page.items, ...result.items] : result.items })
    } catch { if (!controller.signal.aborted) setError('无法更新会话诊断，请刷新后重试。') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return h('section', { className: 'kode-collab-session-diagnostics', 'aria-label': '内部会话只读诊断' },
    h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void load(false) }, opened ? '刷新会话诊断' : '查看内部会话诊断'),
    opened && h('p', { className: 'kode-collab-note' }, '只读显示 Home 已记录的执行身份与状态，运行端存活状态尚未探测。'),
    page && page.run_revision !== run.revision && h('p', { role: 'status' }, '任务版本已改变，请刷新会话诊断。'),
    error && h('p', { role: 'status' }, error),
    page && h('ul', null, ...page.items.map(item => h('li', { key: item.assignment_id },
      h('p', null, `${item.stage_id} · 第 ${item.stage_attempt} 次 · ${item.current_stage_attempt ? '当前分配' : '历史分配'}`),
      h('p', null, `Host ${item.worker.node_id} · Session ${item.worker.session_id}`),
      h('p', null, `Operation ${item.operation.id} · ${item.operation.state} · epoch ${item.operation.epoch}`),
      h('p', null, `停止记录 ${item.stop_state || '尚无确认'} · 用量结算${item.accounting_confirmed ? '已确认' : '待确认'} · 持有资源 ${item.held_resources}`),
      onOpenSession && item.worker.node_id === run.home_hub && h('button', { type: 'button', className: 'kode-collab-button', onClick: () => void open(item) }, '打开原生会话（只读）'),
      item.worker.node_id !== run.home_hub && h('p', { className: 'kode-collab-note' }, '原始会话保存在执行 Host，可在该 Host 的 Session 模式只读查看。')))),
    opened && page?.items.length === 0 && h('p', null, '尚无 Worker 会话分配记录。'),
    page?.next_cursor && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy || page.run_revision !== run.revision, onClick: () => void load(true) }, '更多会话记录'))
}
