import React from 'react'
import { confirmStageWaiver, resolveStageWaiver, stageWaiverKey } from './stage-waiver-command.js'
const h = React.createElement
export function StageWaiverForm({ run, stage, storage, request, onChanged }) {
  const [record, setRecord] = React.useState(null), [review, setReview] = React.useState(null), [reason, setReason] = React.useState('')
  const [ready, setReady] = React.useState(false), [confirming, setConfirming] = React.useState(false), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false)
  const key = stageWaiverKey(run, stage.stage_id)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void storage.read(key).then(value => { if (!controller.signal.aborted) { setRecord(value); setReady(true) } }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取豁免确认记录，请刷新后重试。') })
    return () => controller.abort()
  }, [key])
  const perform = async action => {
    if (running.current || !ready) return
    running.current = true; setBusy(true); setMessage('')
    try { await action(active.current.signal) }
    catch { if (!active.current.signal.aborted) { setMessage('操作尚未确认。已保存的决定会保留，请恢复原决定或检查它是否已失效。'); try { setRecord(await storage.read(key)) } catch {} } }
    finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const inspect = () => perform(async signal => {
    const current = await request('/api/kode/work-run?' + new URLSearchParams({ run_id: run.id }), { signal })
    const plan = await request('/api/kode/work-run/waiver?' + new URLSearchParams({ run_id: run.id, stage_id: stage.stage_id }), { signal })
    if (current.id !== run.id || current.home_hub !== run.home_hub || current.team_id !== run.team_id
      || plan.run_id !== run.id || plan.stage_id !== stage.stage_id || plan.run_revision !== current.revision
      || plan.completion_authorized !== false || typeof plan.scope?.policy?.allow_delivery !== 'boolean') throw Error('Waiver scope changed')
    if (!signal.aborted) { setReview({ run: current, plan }); setReason(''); setConfirming(false) }
  })
  const save = recover => perform(async signal => {
    await confirmStageWaiver({ run: recover ? run : review.run, stage: stage.stage_id, plan: review?.plan, reason, storage, recover, signal })
    if (!signal.aborted) { setRecord(await storage.read(key)); setReview(null); setConfirming(false); setMessage('豁免决定已保存；该阶段不会被记为验证通过。'); onChanged() }
  })
  const resolve = () => perform(async signal => {
    const saved = await resolveStageWaiver({ run, stage: stage.stage_id, storage, signal })
    if (!signal.aborted) { setRecord(saved); setReview(null); setConfirming(false); setMessage(saved.state === 'stale' ? '原决定未提交成功，且已因任务版本变化失效。请重新核对范围。' : '已找回原豁免决定。'); onChanged() }
  })
  const pending = record?.state === 'prepared'
  const eligible = ['pending', 'ready', 'rejected'].includes(stage.state) && !run.completion_authorized && !['cancelling', 'cancel_unconfirmed', 'cancelled', 'failed'].includes(run.state)
  const shown = pending ? record.plan : review?.plan
  return h('section', { className: 'kode-collab-stage-waiver', 'aria-label': `${stage.stage_id} 人工豁免` },
    pending && h('p', null, '有一个尚未确认结果的豁免决定，请先恢复或检查原决定。'),
    shown && h('div', null,
      h('p', null, '豁免阶段：', stage.stage_id, '；范围：', shown.scope.outputs?.join('、')),
      ...Object.entries(shown.scope.artifacts ?? {}).map(([name, artifact]) => h('p', { key: name }, '关联产物：', name, ' · 证据记录 ', artifact.sequence)),
      h('p', null, shown.scope.policy.allow_delivery ? '流程允许带此豁免继续交付；豁免不代表评审或验证通过。' : '此流程不允许带豁免交付，记录后任务仍需处理。'),
      pending && h('p', null, '原决定原因：', record.command.reason)),
    pending ? h('div', null,
      h('button', { type: 'button', className: 'kode-collab-button', disabled: busy || !ready, onClick: () => void save(true) }, '恢复原豁免决定'),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: busy || !ready, onClick: () => void resolve() }, '检查原决定是否失效')) :
    review ? h('form', { onSubmit: event => { event.preventDefault(); setConfirming(true) } },
      h('label', { className: 'kode-collab-input-label' }, '豁免原因', h('textarea', { rows: 3, required: true, maxLength: 2048, value: reason, disabled: busy || confirming, onChange: event => setReason(event.target.value) })),
      confirming ? h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void save(false) }, '确认豁免此阶段') :
        h('button', { type: 'submit', className: 'kode-collab-button', disabled: busy || !reason.trim() || new TextEncoder().encode(reason).length > 2048 }, '核对豁免决定'),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => { setReview(null); setConfirming(false) } }, '取消豁免')) :
    eligible && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy || !ready, onClick: () => void inspect() }, '核对阶段豁免'),
    message && h('p', { role: 'status' }, message))
}
