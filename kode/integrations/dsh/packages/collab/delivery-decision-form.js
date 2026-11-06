import React from 'react'
import { decideDelivery, deliveryDecisionKey } from './delivery-decision.js'
const h = React.createElement
export function DeliveryDecisionForm({ run, storage, onChanged }) {
  const gate = run.human_acceptance
  const [pending, setPending] = React.useState(null), [ready, setReady] = React.useState(false)
  const [choice, setChoice] = React.useState('accept'), [reason, setReason] = React.useState('')
  const [review, setReview] = React.useState(false), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void storage.read(deliveryDecisionKey(run)).then(row => {
      if (controller.signal.aborted) return
      if (row && row.state !== 'accepted') { setPending(row); setChoice(row.command.choice); setReason(row.command.reason) }
      setReady(true)
    }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取验收记录，请检查浏览器存储权限后刷新详情。') })
    return () => controller.abort()
  }, [run.id, run.home_hub, gate.revision, gate.evidence_hash])
  const confirm = async () => {
    if (running.current || !ready) return
    running.current = true; setBusy(true); setMessage('')
    try {
      await decideDelivery({ storage, run, choice, reason, signal: active.current.signal })
      if (!active.current.signal.aborted) {
        setPending(null); setReview(false)
        setMessage(choice === 'accept' ? '验收决定已保存，等待 Hub 复核交付条件。' : '已记录不接受交付，任务仍等待处理。')
        onChanged()
      }
    } catch {
      if (!active.current.signal.aborted) {
        setMessage('验收结果尚未确认。请重试原决定；若任务版本已变化，请刷新详情核对。')
        try { setPending(await storage.read(deliveryDecisionKey(run))) } catch {}
      }
    } finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const available = run.state === 'waiting_user' && run.waiting_reason === 'human_delivery_acceptance_required' && gate.state === 'pending'
  const decision = gate.decision
  return h('section', { className: 'kode-collab-delivery-decision', 'aria-label': '人工交付验收' },
    h('h4', null, '人工交付验收'),
    h('p', null, available ? '流程证据已通过 Hub 检查。请查看下方阶段证据，再决定是否接受本次交付。' : gate.state === 'accepted' ? (run.completion_authorized ? '你的验收决定已纳入交付记录。' : '已接受本次证据，等待 Hub 复核交付条件。') : '本次交付未被接受，任务仍等待处理。'),
    Object.keys(gate.evidence?.waivers ?? {}).length > 0 && h('div', null,
      h('p', null, '本次交付包含人工豁免；被豁免的阶段没有被认定为通过。请一并核对豁免范围和原因。'),
      ...Object.entries(gate.evidence.waivers).map(([stage, waiver]) => h('p', { key: stage }, stage, '：', waiver.reason))),
    decision && h('p', null, decision.choice === 'accept' ? '接受理由：' : '不接受理由：', decision.reason),
    (available || pending) && h('form', { onSubmit: event => { event.preventDefault(); setReview(true) } },
      h('label', { className: 'kode-collab-input-label' }, '验收决定', h('select', { value: choice, disabled: !!pending || busy || review, onChange: event => setChoice(event.target.value) },
        h('option', { value: 'accept' }, '接受本次交付'), h('option', { value: 'reject' }, '不接受，保留待处理状态'))),
      h('label', { className: 'kode-collab-input-label' }, '验收理由', h('textarea', { rows: 3, value: reason, disabled: !!pending || busy || review, maxLength: 2048, required: true, onChange: event => setReason(event.target.value) })),
      pending || review ? h('div', null,
        h('p', null, choice === 'accept' ? '接受当前这组证据？Hub 将重新核验权限、账目和交付条件。' : '记录不接受当前交付？这不会自动增加预算或重启执行。'),
        h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready || busy, onClick: () => void confirm() }, busy ? '正在保存…' : pending ? '重试原验收决定' : '确认验收决定'),
        !pending && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setReview(false) }, '返回修改'))
        : h('button', { type: 'submit', className: 'kode-collab-button', disabled: !ready || busy || !reason.trim() || new TextEncoder().encode(reason).length > 2048 }, '核对验收决定')),
    message && h('p', { role: 'status' }, message))
}
