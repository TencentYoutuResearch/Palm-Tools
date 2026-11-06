import React from 'react'
import { budgetCommandKey, configureBudget, requestBudgetCommand } from './budget-command.js'
const h = React.createElement
export function BudgetForm({ team, budget, storage, onSaved }) {
  const [amount, setAmount] = React.useState(String(budget.limit)), [review, setReview] = React.useState(null), [pending, setPending] = React.useState(null)
  const [ready, setReady] = React.useState(false), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void storage.read(budgetCommandKey(team, budget)).then(row => { if (!controller.signal.aborted) { setPending(row?.state !== 'accepted' ? row : null); setReady(true) } }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取预算提交记录，请检查浏览器存储权限。') })
    return () => controller.abort()
  }, [team.id, team.home_hub, budget.id])
  const preview = event => {
    event.preventDefault(); setMessage('')
    if (!/^\d+$/.test(amount) || !Number.isSafeInteger(Number(amount)) || Number(amount) > 4000000000000000 || Number(amount) < budget.spent + budget.reserved) { setMessage('请输入整数额度，且不能小于已扣减与已预留之和。'); return }
    setReview({ limit: Number(amount), budget: { ...budget }, team: { ...team } })
  }
  const confirm = async () => {
    if (running.current || !ready || (!pending && !review)) return
    running.current = true; setBusy(true); setMessage('')
    try {
      await configureBudget({ storage, team: review?.team ?? team, budget: review?.budget ?? budget, limit: pending?.command.budget.limit ?? review.limit, request: requestBudgetCommand, signal: active.current.signal })
      if (!active.current.signal.aborted) { setReview(null); setPending(null); setMessage('团队预算已保存。'); onSaved() }
    } catch {
      if (!active.current.signal.aborted) { setMessage('修改结果尚未确认。请恢复原提交，勿重复录入新额度。'); try { setPending(await storage.read(budgetCommandKey(team, budget))) } catch {} }
    } finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const proposed = pending?.command.budget ?? (review && { ...review.budget, limit: review.limit })
  return h('form', { className: 'kode-collab-budget-form', onSubmit: preview },
    proposed ? h('div', null, h('p', null, '确认将团队预算总额度设为 ', proposed.limit, ' ', proposed.unit, '。'), h('p', null, '周期：', new Date(proposed.starts_at).toLocaleString(), ' — ', new Date(proposed.ends_at).toLocaleString()),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: busy || !ready, onClick: () => void confirm() }, pending ? '恢复原预算提交' : '确认修改团队预算'),
      !pending && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setReview(null) }, '返回编辑')) : h('div', null,
      h('label', null, '新的团队预算总额度', h('input', { inputMode: 'numeric', value: amount, onChange: event => setAmount(event.target.value) })),
      h('button', { type: 'submit', className: 'kode-collab-button', disabled: busy || !ready }, '核对预算修改')),
    message && h('p', { role: 'status' }, message))
}
