import React from 'react'
import { BudgetForm } from './budget-form.js'
const h = React.createElement
export function BudgetView({ team, request, storage }) {
  const [value, setValue] = React.useState(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const active = React.useRef(null)
  const load = async () => {
    active.current?.abort(); const controller = new AbortController(); active.current = controller
    setBusy(true); setError('')
    try {
      const result = await request(`/api/kode/collab/budgets?team_id=${encodeURIComponent(team.id)}`, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (result.home_hub !== team.home_hub || result.team_id !== team.id || !Array.isArray(result.budgets) || result.label !== '团队预算') throw Error('Wrong budget identity')
      for (const item of result.budgets) {
        const budget = item.budget
        if (!budget || !['team', 'shared'].includes(budget.scope) || (budget.scope === 'team' && budget.scope_id !== team.id)
          || !['limit', 'spent', 'reserved'].every(key => Number.isSafeInteger(budget[key]) && budget[key] >= 0) || !Number.isSafeInteger(item.available)) throw Error('Invalid accounting')
      }
      setValue(result)
    } catch { if (!controller.signal.aborted) setError('暂时无法读取团队预算，已保留上次记录。请刷新重试。') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  React.useEffect(() => { void load(); return () => active.current?.abort() }, [team.id, team.home_hub])
  return h('section', { className: 'kode-collab-process', 'aria-label': '团队预算' },
    h('div', { className: 'kode-collab-toolbar' }, h('h2', null, '团队预算'), h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void load() }, busy ? '正在读取…' : '刷新预算')),
    h('p', { className: 'kode-collab-note' }, '内部支出限额，不是供应商余额。不同单位不合并计算。'),
    error && h('p', { role: 'status' }, error),
    value?.status === 'policy_missing' && h('p', null, '此团队尚未关联预算策略。'),
    ...(value?.budgets ?? []).map(item => h('article', { key: item.budget.id, className: 'kode-collab-run' },
      h('h3', null, item.budget.scope === 'shared' ? '共享预算' : '团队预算', ' · ', item.budget.id),
      h('p', null, '单位：', item.budget.unit),
      h('dl', null, ...[['总额度', item.budget.limit], ['已扣减', item.budget.spent], ['已预留', item.budget.reserved], ['账面可用', item.available], ['估算扣减', item.estimated_charged], ['内部定价扣减', item.internal_price_charged]].flatMap(([name, amount]) => [h('dt', { key: name }, name), h('dd', { key: name + '-value' }, String(amount ?? '未记录'))])),
      h('p', null, '有效期：', new Date(item.budget.starts_at).toLocaleString(), ' — ', new Date(item.budget.ends_at).toLocaleString()),
      item.budget.scope === 'team' && h(BudgetForm, { team: { ...team, revision: value.team_revision }, budget: item.budget, storage, onSaved: () => void load() }),
      Date.now() >= item.budget.ends_at && h('p', null, '预算周期已结束；账面可用不代表可继续执行。'))))
}
