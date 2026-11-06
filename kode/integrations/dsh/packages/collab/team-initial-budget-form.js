import React from 'react'
import { createInitialBudget, initialBudgetKey } from './team-initial-budget.js'
import { requestBudgetCommand } from './budget-command.js'
const h = React.createElement
export function TeamInitialBudgetForm({ team, review, storage, onSaved }) {
  const [values, setValues] = React.useState({ unit: '', limit: '', charge: '', expires: '', internalPricing: false }), [slot, setSlot] = React.useState(null), [proposal, setProposal] = React.useState(null)
  const [ready, setReady] = React.useState(false), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void storage.read(initialBudgetKey(team)).then(row => {
      if (controller.signal.aborted) return
      if (row && (row.home_hub !== team.home_hub || row.command?.team_id !== team.id)) throw Error('Wrong budget record')
      setSlot(row); setReady(true)
    }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取初始预算请求，请重新打开团队。') })
    return () => controller.abort()
  }, [team.id, team.home_hub])
  const prepare = event => {
    event.preventDefault(); setMessage('')
    try {
      if (review?.team?.id !== team.id || review.team.home_hub !== team.home_hub || review.team.revision !== team.revision || review.configuration?.policies?.budget || !team.spec.budget_policy_id) throw Error('Current missing policy required')
      if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(values.unit) || !['limit', 'charge'].every(key => /^\d+$/.test(values[key]) && Number.isSafeInteger(Number(values[key])) && Number(values[key]) > 0 && Number(values[key]) <= 4000000000000000)) throw Error('Invalid amount')
      const ends_at = new Date(values.expires).getTime(), starts_at = Date.now()
      if (!Number.isSafeInteger(ends_at) || ends_at <= starts_at || Number(values.charge) > Number(values.limit)) throw Error('Invalid budget')
      setProposal({ request_id: crypto.randomUUID(), team_revision: team.revision, budget: { id: crypto.randomUUID(), scope: 'team', scope_id: team.id, unit: values.unit, limit: Number(values.limit), starts_at, ends_at, expected_revision: 0 }, initial_policy: { max_assignment_charge: Number(values.charge), ...(values.internalPricing ? { settlement: 'internal_price' } : {}) } })
    } catch { setMessage('请先核对团队配置，并填写有效的单位、额度、单次上限与期限。') }
  }
  const confirm = async () => {
    const command = slot?.command.command ?? proposal
    if (running.current || !command) return
    running.current = true; setBusy(true); setMessage('')
    try {
      await createInitialBudget({ team, command, storage, request: requestBudgetCommand, signal: active.current.signal })
      if (!active.current.signal.aborted) { setSlot(await storage.read(initialBudgetKey(team))); setProposal(null); setMessage('初始团队预算与策略已保存，尚未授予权限或激活。'); onSaved?.() }
    } catch {
      if (!active.current.signal.aborted) { setMessage('初始预算结果尚未确认，请恢复原请求。'); try { setSlot(await storage.read(initialBudgetKey(team))) } catch {} }
    } finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const command = slot?.command.command ?? proposal
  if (!slot && (!review || review.configuration?.policies?.budget || !team.spec.budget_policy_id)) return message ? h('p', { role: 'status' }, message) : null
  return h('section', { className: 'kode-collab-initial-budget' }, h('h4', null, '初始团队预算'),
    h('p', null, '用户录入的团队支出限额，不是供应商余额。'),
    slot?.state === 'configured' ? h('p', null, '已有初始预算确认记录。实时用量和后续调整请查看团队预算。') : command ? h('div', null,
      h('p', null, '团队预算：', command.budget.limit, ' ', command.budget.unit, '；单次工作预留上限：', command.initial_policy.max_assignment_charge),
      h('p', null, '结算方式：', command.initial_policy.settlement === 'internal_price' ? '按已配置的内部单价估算并扣减团队预算；不是供应商账单' : '尚未配置内部计价结算'),
      h('p', null, '有效至：', new Date(command.budget.ends_at).toLocaleString()),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void confirm() }, slot ? '恢复原初始预算' : '确认创建团队预算'),
      !slot && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setProposal(null) }, '返回修改初始预算')) :
    h('form', { onSubmit: prepare }, ...[['unit', '团队预算单位'], ['limit', '初始团队总额度'], ['charge', '单次工作预留上限'], ['expires', '团队预算到期时间']].map(([key, label]) => h('label', { key }, label,
      h('input', { 'aria-label': label, type: key === 'expires' ? 'datetime-local' : 'text', inputMode: ['limit', 'charge'].includes(key) ? 'numeric' : undefined, required: true, value: values[key], disabled: busy, onChange: event => setValues(previous => ({ ...previous, [key]: event.target.value })) }))),
      h('label', null, h('input', { type: 'checkbox', 'aria-label': '启用内部计价结算', checked: values.internalPricing, disabled: busy, onChange: event => setValues(previous => ({ ...previous, internalPricing: event.target.checked })) }), '按内部单价结算团队预算（还需配置各执行资源的单价，不代表供应商价格）'),
      h('button', { type: 'submit', className: 'kode-collab-button', disabled: !ready || busy }, '核对初始团队预算')),
    message && h('p', { role: 'status' }, message))
}
