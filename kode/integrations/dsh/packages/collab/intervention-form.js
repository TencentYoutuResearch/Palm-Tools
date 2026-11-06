import React from 'react'
import { confirmIntervention, interventionAllowed, readIntervention } from './intervention.js'
const h = React.createElement
export function InterventionForm({ run, storage, onChanged }) {
  const [pending, setPending] = React.useState(null), [ready, setReady] = React.useState(false)
  const [review, setReview] = React.useState(false), [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void readIntervention(storage, run).then(record => {
      if (!controller.signal.aborted) { setPending(record?.state === 'prepared' ? record : null); setReady(true) }
    }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取接管记录，请重新打开任务详情。') })
    return () => controller.abort()
  }, [run.id, run.team_id, run.home_hub])
  React.useEffect(() => { setReview(false) }, [run.revision])
  const action = run.state === 'paused' ? 'resume' : 'takeover'
  const allowed = interventionAllowed(run, action)
  const confirm = async () => {
    if (running.current || !ready || (!pending && (!review || !reason.trim()))) return
    running.current = true; setBusy(true); setMessage('')
    try {
      const result = await confirmIntervention({ storage, run, action, reason, recover: !!pending, signal: active.current.signal,
        onPrepared: record => { setPending(record); setReview(false) } })
      if (!active.current.signal.aborted) {
        setPending(null); setReview(false); setReason('')
        setMessage(result.outcome === 'obsolete' ? '原请求未提交，任务版本已改变。请核对当前任务后重新决定。'
          : result.state === 'taking_over' ? '接管请求已记录，等待执行停止与结算确认。' : '恢复请求已记录，等待重新准入与验证。')
        onChanged()
      }
    } catch {
      if (!active.current.signal.aborted) {
        setMessage('结果尚未确认，请恢复原接管或恢复请求。')
        try { const record = await readIntervention(storage, run); setPending(record?.state === 'prepared' ? record : null) } catch {}
      }
    } finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  return h('section', { className: 'kode-collab-intervention', 'aria-label': '人工接管与恢复' },
    run.state === 'taking_over' && h('p', { role: 'status' }, '正在停止受管执行。停止与结算确认后，可在已授权工作区人工处理。'),
    run.state === 'paused' && h('p', { role: 'status' }, '受管执行已停止并结算，可在已授权工作区人工处理。'),
    (allowed || pending) && (review || pending ? h('div', null,
      h('p', null, (pending?.command.action ?? action) === 'takeover'
        ? '此操作将暂停当前任务并等待所有 Worker 停止及用量结算。恢复后各阶段都会重新核验。'
        : '此操作将保留历史记录，清除当前已选证据，并从各阶段的新尝试重新执行。权限、预算与资源仍需通过准入。'),
      !pending && h('label', null, '操作原因', h('textarea', { value: reason, disabled: busy, maxLength: 2048, onChange: event => setReason(event.target.value) })),
      pending && h('p', null, pending.command.reason),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready || busy || (!pending && !reason.trim()), onClick: () => void confirm() },
        pending ? '恢复原操作请求' : action === 'takeover' ? '确认暂停并接管' : '确认恢复并重新核验'),
      !pending && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setReview(false) }, '返回任务详情'))
      : h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready || busy, onClick: () => setReview(true) }, action === 'takeover' ? '暂停并接管' : '恢复自动执行')),
    message && h('p', { role: 'status' }, message))
}
