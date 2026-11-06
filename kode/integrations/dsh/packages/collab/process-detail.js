import { TraceView } from './trace-view.js'
import { SessionDiagnostics } from './session-diagnostics.js'
import { InterventionForm } from './intervention-form.js'
import { ExecutionRecheckForm } from './execution-recheck-form.js'
import { ExecutionStatusView } from './execution-status-view.js'
import React from 'react'
import { StageWaiverForm } from './stage-waiver-form.js'
import { visibleRefresh } from './visible-refresh.js'
import { DeliveryDecisionForm } from './delivery-decision-form.js'
import { deliveryDecisionKey } from './delivery-decision.js'
import { RunCancelForm } from './run-cancel-form.js'
import { EvidenceDetail } from './evidence-detail.js'
import { stageEvidence } from './stage-evidence.js'
const h = React.createElement
const states = { waived: '人工豁免（未验证通过）', pending: '待开始', running: '执行中', ready: '等待判定', passed: '通过', rejected: '需返工', failed: '失败', cancelled: '已取消' }
const kinds = { execution_recheck_requested: '请求重新检查执行条件', stage_waived: '记录人工阶段豁免', work_run_budget_wait: '等待补充团队预算', delivery_acceptance_requested: '请求人工交付验收', delivery_acceptance_decided: '记录人工验收决定', work_run_received: '接收任务', work_run_cancel_requested: '已请求取消，等待停止确认', work_run_cancelled: '取消任务', stage_completed: '阶段完成', assignment_prepared: '分配工作' }
function Evidence({ run, stage, request }) {
  if (stage.state === 'waived') return h('div', { className: 'kode-collab-stage-evidence' },
    h('p', null, '此阶段已人工豁免，不代表评审或验证通过。'),
    h('p', null, '原因：', stage.waiver?.reason || '原因记录不可用，请刷新后重试。'),
    h('p', null, stage.waiver?.scope?.policy?.allow_delivery === true
      ? '策略允许带豁免交付；任务仍需通过其余交付条件。'
      : '当前策略不允许带豁免交付。'))
  const evidence = stageEvidence(run, stage)
  const labels = { absent: '尚未选定证据', invalid: '证据引用不一致，请刷新后重试', selected: 'Hub 已选定证据，阶段判定尚未完成', passed: 'Hub 阶段判定通过', rejected: 'Hub 阶段判定需返工' }
  const kinds = { artifact: '产物', review: '评审', verification: '验证' }
  return h('div', { className: 'kode-collab-stage-evidence' }, h('p', null, labels[evidence.state]),
    evidence.outputs.length > 0 && h('ul', null, ...evidence.outputs.map(row => h('li', { key: row.name },
      `${kinds[row.kind] || '证据'} · ${row.name} · 记录编号 ${row.seq}`,
      h(EvidenceDetail, { run, stage, output: row, request })))))
}
export function ProcessDetail({ team, runId, request, storage, onUpdated, onFollowup, onOpenSession }) {
  const [detail, setDetail] = React.useState(null), [events, setEvents] = React.useState([])
  const [executionObservation, setExecutionObservation] = React.useState(null)
  const [cursor, setCursor] = React.useState(0), [more, setMore] = React.useState(false)
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const active = React.useRef(null), loading = React.useRef(false), latestLoad = React.useRef(null)
  const load = async (append, background = false) => {
    if (background && loading.current) return 3000
    active.current?.abort()
    const controller = new AbortController(); active.current = controller
    loading.current = true
    if (!background) setBusy(true)
    setError('')
    try {
      const path = `/api/kode/work-run?run_id=${encodeURIComponent(runId)}`
      const run = await request(path, { signal: controller.signal })
      if (run.id !== runId || run.team_id !== team.id || run.home_hub !== team.home_hub || !Array.isArray(run.stages) || typeof run.completion_authorized !== 'boolean' || !Number.isSafeInteger(run.revision) || run.revision < 1) throw Error('Invalid run identity')
      if (controller.signal.aborted) return
      const after = append ? cursor : 0
      const history = background && more ? { events: [], next_cursor: after } : await request(`${path}&view=events&after=${after}`, { signal: controller.signal })
      let next = after
      if (!Array.isArray(history.events) || history.events.length > 200) throw Error('Invalid events')
      for (const event of history.events) {
        if (!Number.isSafeInteger(event.seq) || event.seq <= next || typeof event.data?.kind !== 'string') throw Error('Invalid event cursor')
        next = event.seq
      }
      if (history.next_cursor !== next) throw Error('Invalid continuation')
      if (controller.signal.aborted) return
      setDetail(previous => previous && previous.revision >= run.revision ? previous : run); setEvents(previous => append ? history.events.length ? [...previous, ...history.events] : previous : history.events)
      onUpdated?.(run)
      setCursor(next); setMore(background && more ? true : history.events.length === 200)
    } catch { if (!controller.signal.aborted) setError('暂时无法更新任务详情，已保留上次内容。请重试。'); return 10000 }
    finally { if (active.current === controller) loading.current = false; if (!controller.signal.aborted) setBusy(false) }
  }
  React.useEffect(() => { void load(false); return () => active.current?.abort() }, [runId, team.id, team.home_hub])
  latestLoad.current = load
  React.useEffect(() => {
    if (!detail || ['completed', 'failed', 'cancelled'].includes(detail.state)) return
    let first = true
    return visibleRefresh({ refresh: () => { if (first) { first = false; return 3000 } return latestLoad.current(true, true) } })
  }, [runId, team.id, team.home_hub, detail?.state])
  return h('div', { className: 'kode-collab-run-detail' },
    h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void load(false) }, busy ? '正在读取详情…' : '刷新详情'),
    error && h('p', { role: 'status' }, error),
    detail && h(React.Fragment, null,
      h('p', null, detail.completion_authorized ? 'Hub 已确认交付' : '尚未确认交付'),
      h(ExecutionStatusView, { run: detail, request, onObservation: setExecutionObservation }),
      h(ExecutionRecheckForm, { run: detail, observation: executionObservation, storage, onChanged: () => void load(false) }),
      detail.human_acceptance && h(DeliveryDecisionForm, { key: deliveryDecisionKey(detail), run: detail, storage, onChanged: () => void load(false) }),
      h(RunCancelForm, { run: detail, storage, onChanged: () => void load(false) }),
      h(InterventionForm, { run: detail, storage, onChanged: () => void load(false) }),
      onFollowup && ['completed', 'failed', 'cancelled'].includes(detail.state) && h('button', { type: 'button', className: 'kode-collab-button', onClick: () => onFollowup(detail) }, '基于此任务提出修改'),
      detail.prior_run_id && h('p', { className: 'kode-collab-note' }, '关联原任务：', detail.prior_run_id),
      h('h4', null, '流程阶段'),
      h('ol', null, ...detail.stages.map(stage => h('li', { key: stage.stage_id },
        h('span', null, stage.stage_id, '：', states[stage.state] || stage.state, stage.attempt > 0 ? ` · 第 ${stage.attempt} 次尝试` : ' · 尚未分配'),
        stage.assignment_id && h('p', null, '工作分配：', stage.assignment_id),
        h(Evidence, { run: detail, stage, request }),
        detail.context?.binding?.workflow?.pack?.stages?.find(item => item.id === stage.stage_id)?.waiver &&
          h(StageWaiverForm, { run: detail, stage, request, storage, onChanged: () => void load(false) })))),
      h(TraceView, { run: detail, request }),
      h(SessionDiagnostics, { run: detail, request, onOpenSession }),
      h('h4', null, '操作记录'),
      h('ol', null, ...events.map(event => h('li', { key: event.seq }, kinds[event.data.kind] || event.data.kind,
        event.data.at && h('span', null, ' · ', new Date(event.data.at).toLocaleString())))),
      more && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void load(true) }, '更多操作记录')))
}
