import React from 'react'
import { deactivateTeam, deactivationKey, readActivationState, verifyActivationState } from './team-deactivation.js'
import { teamActivationRequest } from './team-activation.js'
const h = React.createElement
export function TeamDeactivationView({ team, storage }) {
  const [current, setCurrent] = React.useState(null), [review, setReview] = React.useState(null), [pending, setPending] = React.useState(null)
  const [busy, setBusy] = React.useState(false), [ready, setReady] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void storage.read(deactivationKey(team)).then(value => {
      if (controller.signal.aborted) return
      if (value) {
        verifyActivationState(value.activation, team)
        if (value.home_hub !== team.home_hub || value.command?.team_id !== team.id || value.command.command?.action !== 'deactivate') throw Error('Wrong deactivation record')
      }
      setPending(value?.state === 'accepted' ? null : value); setReady(true)
    }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取停用请求，请重新打开草案。') })
    return () => controller.abort()
  }, [team.id, team.home_hub])
  const inspect = async () => {
    if (running.current) return
    running.current = true; setBusy(true); setMessage(''); setReview(null)
    try {
      const value = await readActivationState(team, { signal: active.current.signal })
      if (!active.current.signal.aborted) { setCurrent(value); if (value.active) setReview({ activation: value, requestId: crypto.randomUUID() }) }
    } catch { if (!active.current.signal.aborted) setMessage('无法读取当前激活状态，请重试。') }
    finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const confirm = async () => {
    const intent = pending ? { activation: pending.activation, requestId: pending.request_id } : review
    if (running.current || !intent) return
    running.current = true; setBusy(true); setMessage('')
    try {
      const value = await deactivateTeam({ storage, team, ...intent, request: (input, options) => teamActivationRequest('activation', input, options), signal: active.current.signal })
      if (!active.current.signal.aborted) { setCurrent(value); setPending(null); setReview(null); setMessage('停用已确认。此确认不代表在途任务已经停止；请在工作过程中查看并取消需要停止的任务。') }
    } catch {
      if (!active.current.signal.aborted) { setMessage('停用结果尚未确认，请恢复原请求。'); try { const value = await storage.read(deactivationKey(team)); if (value?.state !== 'accepted') setPending(value) } catch {} }
    } finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  return h('section', { className: 'kode-collab-team-deactivation' }, h('h4', null, '停用团队'),
    h('p', null, '停用将撤回当前激活授权。在途任务的停止情况需单独确认。'),
    pending ? h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void confirm() }, '恢复原停用请求') :
      h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready || busy, onClick: () => void inspect() }, '核对当前启用状态'),
    current && h('p', null, current.active ? '最近核对：团队已启用。' : '最近核对：团队已停用。'),
    review && !pending && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void confirm() }, '确认停用当前授权'),
    message && h('p', { role: 'status' }, message))
}
