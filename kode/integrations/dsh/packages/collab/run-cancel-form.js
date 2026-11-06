import React from 'react'
import { runCancelKey, cancelRun, requestRunCancel } from './run-cancel.js'
const h = React.createElement
export function RunCancelForm({ run, storage, onChanged }) {
  const [pending, setPending] = React.useState(null), [ready, setReady] = React.useState(false), [review, setReview] = React.useState(false)
  const [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void storage.read(runCancelKey(run)).then(value => { if (!controller.signal.aborted) { setPending(value?.state !== 'accepted' ? value : null); setReady(true) } }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取取消记录，请检查浏览器存储权限。') })
    return () => controller.abort()
  }, [run.id, run.home_hub])
  const confirm = async () => {
    if (running.current || !ready) return
    running.current = true; setBusy(true); setMessage('')
    try {
      await cancelRun({ storage, run, request: requestRunCancel, signal: active.current.signal })
      if (!active.current.signal.aborted) { setPending(null); setReview(false); setMessage('已请求取消，等待执行停止和账目确认。'); onChanged() }
    } catch {
      if (!active.current.signal.aborted) { setMessage('取消结果尚未确认，请重试原请求。'); try { setPending(await storage.read(runCancelKey(run))) } catch {} }
    } finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const eligible = ['waiting_user', 'waiting_resource', 'queued', 'running', 'paused'].includes(run.state) && !run.completion_authorized
  return h('div', { className: 'kode-collab-run-cancel' },
    (pending || eligible) && (pending || review ? h('div', null,
      h('p', null, '请求取消此任务？Hub 会阻止后续执行，已开始的工作仍需确认停止。'),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready || busy, onClick: () => void confirm() }, pending ? '重试原取消请求' : '确认请求取消'),
      !pending && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setReview(false) }, '继续任务')) : h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready, onClick: () => setReview(true) }, '取消任务')),
    message && h('p', { role: 'status' }, message),
    run.cancellation && h('p', null, run.cancellation.stop_confirmed === true ? '执行停止已确认。' : '执行停止尚未确认。', run.cancellation.resources_released === true ? '资源已释放。' : '资源释放尚未确认。'))
}
