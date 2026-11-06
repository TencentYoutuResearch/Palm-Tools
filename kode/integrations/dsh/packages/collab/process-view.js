import React from 'react'
import { visibleRefresh } from './visible-refresh.js'
import { validateRunPage, mergeRunPage, nextRunRefresh } from './run-pages.js'
import { ProcessDetail } from './process-detail.js'
const h = React.createElement
const waitingLabels = { waiver_delivery_disallowed: '已记录人工豁免，但当前流程不允许带豁免交付，任务尚未完成。', waiver_delivery_review_pending: '已记录人工豁免，仍需按流程策略核对交付条件。', team_budget_exhausted: '团队预算不足。补充团队预算后，任务会自动继续。', rework_limit_exhausted: '已达到流程允许的返工次数，需要你决定下一步。', human_delivery_acceptance_required: '交付证据已准备好，等待你验收。', human_delivery_rejected: '本次交付未获接受，等待后续处理。', team_activation_required: '团队尚未激活，请先核对并激活团队。', team_deactivated: '团队已停用，需要重新激活后继续。', execution_stop_confirmation_required: '正在等待执行停止确认，资源尚不能视为已释放。' }
const labels = { waiting_user: '等待确认', queued: '等待开始', running: '进行中', waiting_resource: '等待资源', blocked: '需要处理', completed: '执行结束', failed: '失败', cancelled: '已取消', cancelling: '正在取消', cancel_unconfirmed: '取消待确认', taking_over: '接管待确认', paused: '已暂停，可人工处理' }
export function ProcessView({ team, request, storage, onFollowup, onOpenSession }) {
  const [selected, setSelected] = React.useState(null)
  const [page, setPage] = React.useState({ items: [], next: null, loaded: false })
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const active = React.useRef(null), loading = React.useRef(false), refreshAfter = React.useRef(''), latestLoad = React.useRef(null)
  const updateSummary = React.useCallback(run => setPage(previous => {
    const row = previous.items.find(item => item.id === run.id)
    if (!row || row.revision >= run.revision) return previous
    return { ...previous, items: previous.items.map(item => item.id === run.id ? { ...item, revision: run.revision, state: run.state, completion_authorized: run.completion_authorized, waiting_reason: run.waiting_reason, updated_at: run.updated_at } : item) }
  }), [])
  const load = async (more, background = false) => {
    if (background && loading.current) return 3000
    active.current?.abort()
    const controller = new AbortController(); active.current = controller
    loading.current = true
    if (!background) setBusy(true)
    setError('')
    const after = more ? page.next : background ? refreshAfter.current : ''
    try {
      const result = await request(`/api/kode/collab/runs?team_id=${encodeURIComponent(team.id)}&limit=25&after=${encodeURIComponent(after || '')}`, { signal: controller.signal })
      if (controller.signal.aborted) return
      validateRunPage(result, team, after || '')
      refreshAfter.current = more ? '' : nextRunRefresh(page, result)
      setPage(previous => mergeRunPage(previous, result, { more }))
    } catch { if (!controller.signal.aborted) setError('暂时无法读取工作过程，已保留上次内容。请重试。'); return 10000 }
    finally { if (active.current === controller) loading.current = false; if (!controller.signal.aborted) setBusy(false) }
  }
  React.useEffect(() => { void load(false); return () => active.current?.abort() }, [team.id, team.home_hub])
  latestLoad.current = load
  React.useEffect(() => {
    let first = true
    return visibleRefresh({ refresh: () => { if (first) { first = false; return 3000 } return latestLoad.current(false, true) } })
  }, [team.id, team.home_hub])
  return h('section', { className: 'kode-collab-process', 'aria-label': '工作过程' },
    h('div', { className: 'kode-collab-toolbar' }, h('h2', null, '工作过程'), h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void load(false) }, busy ? '正在读取…' : '刷新工作过程')),
    error && h('p', { role: 'status', className: 'kode-collab-note' }, error),
    page.loaded && !page.items.length && h('p', { className: 'kode-collab-note' }, '还没有任务。消息接收后，由 Superagent 决定如何安排工作。'),
    ...page.items.map(row => h('article', { key: row.id, className: 'kode-collab-run' },
      h('h3', null, row.request_preview || '团队任务'),
      h('p', null, labels[row.state] || '状态待识别', ' · ', row.completion_authorized ? 'Hub 已确认交付' : '尚未确认交付'),
      row.waiting_reason && h('p', { className: 'kode-collab-note' }, waitingLabels[row.waiting_reason] || '等待条件满足，可查看详情了解当前进度。'),
      h('small', null, '任务编号：', row.id),
      h('button', { type: 'button', className: 'kode-collab-button', 'aria-expanded': selected === row.id, onClick: () => setSelected(value => value === row.id ? null : row.id) }, selected === row.id ? '收起详情' : '查看详情'),
      selected === row.id && h(ProcessDetail, { key: row.id, team, runId: row.id, request, storage, onUpdated: updateSummary, onFollowup, onOpenSession }))),
    page.next && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void load(true) }, '更多任务'))
}
