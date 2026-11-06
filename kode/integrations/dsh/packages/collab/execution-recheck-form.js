import React from 'react'
import { readExecutionRecheck, confirmExecutionRecheck } from './execution-recheck.js'
const h = React.createElement
const obsoleteMessage = '原检查请求未提交，任务版本已改变。记录已保留，请查看当前任务状态。'
export function ExecutionRecheckForm({ run, observation, storage, onChanged }) {
  const [pending, setPending] = React.useState(null), [ready, setReady] = React.useState(false), [review, setReview] = React.useState(false)
  const [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void readExecutionRecheck(storage, run).then(record => { if (!controller.signal.aborted) { setPending(record?.state === 'prepared' ? record : null); if (record?.state === 'obsolete') setMessage(obsoleteMessage); setReady(true) } })
      .catch(() => { if (!controller.signal.aborted) setMessage('无法核对重新检查记录，请重新打开任务详情。') })
    return () => controller.abort()
  }, [run.id, run.home_hub, run.team_id])
  React.useEffect(() => { setReview(false) }, [run.revision])
  const confirm = async () => {
    if (running.current || !ready || (!pending && !review)) return
    running.current = true; setBusy(true); setMessage('')
    try {
      const result = await confirmExecutionRecheck({ storage, run, observation, recover: !!pending, signal: active.current.signal, onPrepared: record => { setPending(record); setReview(false) } })
      if (!active.current.signal.aborted) { setPending(null); setReview(false); setMessage(result.outcome === 'obsolete' ? obsoleteMessage : '重新检查请求已记录。后续进度以执行检查和 Hub 任务记录为准。'); onChanged() }
    } catch {
      if (!active.current.signal.aborted) { setMessage('重新检查结果尚未确认，请恢复原请求。任务版本改变时需核对操作记录。'); try { const record = await readExecutionRecheck(storage, run); setPending(record?.state === 'prepared' ? record : null) } catch {} }
    } finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const eligible = observation?.home_hub === run.home_hub && observation?.run_id === run.id && observation?.team_id === run.team_id
    && observation?.run_revision === run.revision && observation?.retry_allowed === true && run.completion_authorized === false && run.cancellation == null
    && ['queued', 'running', 'waiting_resource'].includes(run.state)
  return h('div', { className: 'kode-collab-execution-recheck' },
    (pending || eligible) && (pending || review ? h('div', null,
      h('p', null, '将为当前任务记录一次重新检查请求。系统会核对当前权限、预算、执行状态和证据；未确认的执行结果仍需核对。'),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready || busy, onClick: () => void confirm() }, pending ? '恢复原检查请求' : '确认重新检查'),
      !pending && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setReview(false) }, '返回任务详情')) :
      h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready || busy, onClick: () => setReview(true) }, '重新检查执行条件')),
    message && h('p', { role: 'status' }, message))
}
