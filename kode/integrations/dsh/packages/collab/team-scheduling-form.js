import { TeamCapabilityUpdateForm } from './team-capability-update-form.js'
import { TeamCapabilityForm } from './team-capability-form.js'
import React from 'react'
import { schedulingKey, schedulingCommand, confirmScheduling, requestScheduling } from './team-scheduling.js'
const h = React.createElement
function CapabilityFacts({ value }) {
  if (!value) return null
  const rows = Object.entries(value.assessments ?? {})
  return h('div', null, !rows.length && h('p', null, '尚无能力评价条目；无法据此判断质量、成本或速度。'),
    ...rows.map(([id, fact]) => {
      const evaluation = fact.evaluation ?? {}
      const description = evaluation.kind === 'task_fit' ? `${evaluation.tag}：${evaluation.score} 分` : evaluation.kind === 'cost_tier' ? `成本等级：${evaluation.tier}` : evaluation.kind === 'latency' ? `时延偏好：${evaluation.preference}` : evaluation.text ?? '未识别的评价'
      return h('div', { key: id }, h('p', null, description, '；来源：', fact.source, '；可信度：', fact.confidence, fact.pinned ? '；已固定' : ''),
        h('p', null, '有效至：', new Date(fact.valid_until).toLocaleString(), Date.now() >= fact.valid_until ? '（已过期）' : ''),
        ...(fact.evidence ?? []).map((text, index) => h('p', { key: index }, '依据：', text)))
    }))
}
export function TeamSchedulingForm({ team, storage, onSaved }) {
  const [capacities, setCapacities] = React.useState({})
  const [options, setOptions] = React.useState(null), [choices, setChoices] = React.useState({}), [proposal, setProposal] = React.useState(null), [pending, setPending] = React.useState(null)
  const [pricing, setPricing] = React.useState({})
  const [preferences, setPreferences] = React.useState({ quality: '100', cost: '50', latency: '20', minimum_quality: '0', minimum_confidence: '0', allowUnknown: false })
  const [ready, setReady] = React.useState(false), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void storage.read(schedulingKey(team)).then(row => {
      if (controller.signal.aborted) return
      if (row && (row.home_hub !== team.home_hub || row.command?.team_id !== team.id)) throw Error('Wrong scheduling record')
      setPending(row?.state === 'accepted' ? null : row); setReady(true)
    }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取调度确认记录，请重新打开团队。') })
    return () => controller.abort()
  }, [team.id, team.home_hub])
  const load = async () => {
    if (running.current) return
    running.current = true; setBusy(true); setMessage(''); setOptions(null)
    try {
      const value = await requestScheduling({ team_id: team.id, team_revision: team.revision }, { signal: active.current.signal })
      if (value.team?.id !== team.id || value.team.home_hub !== team.home_hub || value.team.revision !== team.revision || !Array.isArray(value.options) || value.options.length > 64 || value.options.some(row => !Array.isArray(row.capabilities) || row.capabilities.length > 20)) throw Error('Wrong options')
      if (!active.current.signal.aborted) {
        setOptions(value); setChoices(Object.fromEntries(value.options.map(row => [row.target_id, row.capabilities.length === 1 && !row.capabilities_truncated ? row.capabilities[0].id : ''])))
        const policy = value.policy?.policy
        if (policy) setPreferences({ ...Object.fromEntries(Object.entries(policy.weights).map(([key, value]) => [key, String(value)])), minimum_quality: String(policy.minimum_quality), minimum_confidence: String(policy.minimum_confidence), allowUnknown: Object.values(policy.targets).every(target => target.resource.unknown_quota === 'team_budget') })
      }
    } catch { if (!active.current.signal.aborted) setMessage('无法读取当前调度资源，请刷新团队配置后重试。') }
    finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const prepare = event => {
    event.preventDefault(); setMessage('')
    try { setProposal(schedulingCommand(team, options, choices, preferences, crypto.randomUUID(), pricing, undefined, capacities)) }
    catch { setMessage('请核对账户归属、能力评价、额度策略和偏好数值；缺失或不匹配的资源不能确认。') }
  }
  const confirm = async () => {
    if (running.current || (!proposal && !pending)) return
    running.current = true; setBusy(true); setMessage('')
    try {
      await confirmScheduling({ storage, team, command: pending?.command.command ?? proposal, request: requestScheduling, signal: active.current.signal })
      if (!active.current.signal.aborted) { setProposal(null); setPending(null); setOptions(null); setMessage('调度策略已保存，尚未激活。请重新核对权限与激活条件。'); onSaved?.() }
    } catch {
      if (!active.current.signal.aborted) { setMessage('调度结果尚未确认，请恢复原请求。'); try { const row = await storage.read(schedulingKey(team)); if (row?.state !== 'accepted') setPending(row) } catch {} }
    } finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const command = pending?.command.command ?? proposal
  return h('section', { className: 'kode-collab-scheduling-form' }, h('h4', null, '调度偏好'), h('p', null, '偏好用于比较已配置的候选资源，不会覆盖权限、预算和实时资源检查。'),
    command ? h('div', null,
      h('p', null, '质量 / 成本 / 速度权重：', Object.values(command.policy.policy.weights).join(' / '), '；最低质量：', command.policy.policy.minimum_quality, '；最低可信度：', command.policy.policy.minimum_confidence),
      ...Object.entries(command.policy.policy.targets).map(([id, target]) => h('p', { key: id }, id, ' · ', target.resource.host, '/', target.resource.profile, ' · 账户 ', target.resource.account_id, ' · 能力评价 ', target.capability_id, ' · ', target.resource.unknown_quota === 'team_budget' ? '额度未知时使用团队预算约束' : '要求最新额度观测')),
      ...Object.entries(command.internal_prices ?? {}).map(([id, price]) => h('p', { key: 'price:' + id }, id, ' 内部计价：每百万输入 / 缓存输入 / 输出 token 为 ', price.input_per_million, ' / ', price.cached_per_million, ' / ', price.output_per_million, ' ', price.unit, '。不是供应商价格或账单。')),
      ...Object.entries(command.account_capacities ?? {}).map(([account, value]) => h('p', { key: 'capacity:' + account }, '账号 ', account, ' 的工作并发上限设为 ', value.max_active_assignments, '。此限制跨团队共享，将影响使用该账号的所有团队。')),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void confirm() }, pending ? '恢复原调度确认' : '确认保存调度策略'),
      !pending && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setProposal(null) }, '返回修改调度偏好')) :
    h('div', null, h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready || busy, onClick: () => void load() }, '读取调度资源'),
      options && h('form', { onSubmit: prepare },
        ...options.options.map(row => h('div', { key: row.target_id }, h('label', null, row.target_id, ' 的能力评价', h('select', { 'aria-label': row.target_id + ' 的能力评价', value: choices[row.target_id] ?? '', onChange: event => setChoices(previous => ({ ...previous, [row.target_id]: event.target.value })) }, h('option', { value: '' }, '请选择评价'), ...row.capabilities.map(value => h('option', { key: value.id, value: value.id }, value.model, ' · ', value.id)))),
          h(CapabilityFacts, { value: row.capabilities.find(value => value.id === choices[row.target_id]) }),
          row.capabilities_truncated && h('p', null, '仅显示前 20 项评价，请确认所选记录。'), !row.binding.binding_current && h('p', null, '账户绑定不可用，需先修正资源。'),
          !(row.quota?.buckets?.length) && h('p', null, '没有可确认的供应商额度窗口。'))),
        ...[['quality', '质量权重'], ['cost', '成本权重'], ['latency', '速度权重'], ['minimum_quality', '最低质量评分'], ['minimum_confidence', '最低评价可信度']].map(([key, label]) => h('label', { key }, label, h('input', { 'aria-label': label, required: true, inputMode: 'decimal', value: preferences[key], onChange: event => setPreferences(previous => ({ ...previous, [key]: event.target.value })) }))),
        h('label', null, h('input', { type: 'checkbox', checked: preferences.allowUnknown, onChange: event => setPreferences(previous => ({ ...previous, allowUnknown: event.target.checked })) }), '额度未知时允许使用团队预算约束（不代表供应商余额充足）'),
        ...[...new Set(options.options.map(row => row.binding?.account_id).filter(Boolean))].map(account => {
          const snapshot = options.options.find(row => row.binding?.account_id === account).assignment_capacity
          const value = capacities[account] ?? { enabled: false, value: '' }
          const update = patch => setCapacities(previous => ({ ...previous, [account]: { ...value, ...patch } }))
          return h('fieldset', { key: 'capacity:' + account }, h('legend', null, '账号工作并发 · ', account),
            h('p', null, snapshot ? `当前占用 ${snapshot.held} / 上限 ${snapshot.max_active_assignments}` : '尚未配置并发上限，Worker 无法执行。'),
            h('label', null, h('input', { type: 'checkbox', 'aria-label': account + ' 配置工作并发', checked: value.enabled, onChange: event => update({ enabled: event.target.checked }) }), '设置账号工作并发上限'),
            value.enabled && h('div', null, h('p', null, '此限制跨团队共享，会影响使用该账号的所有团队；不是供应商额度。'),
              h('label', null, '工作并发上限（1–1024）', h('input', { 'aria-label': account + ' 工作并发上限', required: true, inputMode: 'numeric', value: value.value, onChange: event => update({ value: event.target.value }) }))))
        }),
        ...team.spec.execution_targets.map(target => {
          const value = pricing[target.id] ?? { enabled: false, unit: '', input_per_million: '', cached_per_million: '', output_per_million: '' }
          const update = patch => setPricing(previous => ({ ...previous, [target.id]: { ...value, ...patch } }))
          const existing = options.policy?.policy?.targets?.[target.id]?.internal_price_id
          return h('fieldset', { key: 'pricing:' + target.id }, h('legend', null, target.id, ' · 内部计价'),
            h('p', null, existing ? '已有计价引用。录入新版本只影响重新确认后的配置。' : '尚未配置内部单价；需要计价的执行不能启动。'),
            h('label', null, h('input', { type: 'checkbox', 'aria-label': target.id + ' 配置内部计价', checked: value.enabled, onChange: event => update({ enabled: event.target.checked }) }), '录入内部单价'),
            value.enabled && h('div', null, h('p', null, '使用团队预算的单位，填写每百万 token 的内部扣账单价。不是供应商价格或账单。预算需先启用内部计价结算。'),
              ...[['unit', '内部计价单位'], ['input_per_million', '每百万输入 token 单价'], ['cached_per_million', '每百万缓存输入 token 单价'], ['output_per_million', '每百万输出 token 单价']].map(([key, label]) => h('label', { key }, label, h('input', { 'aria-label': target.id + ' ' + label, required: true, inputMode: key === 'unit' ? 'text' : 'numeric', value: value[key], onChange: event => update({ [key]: event.target.value }) })))))
        }),
        h('button', { type: 'submit', className: 'kode-collab-button', disabled: busy }, '核对调度偏好'))),
    !command && options && options.options.map(row => { const target = team.spec.execution_targets.find(target => target.id === row.target_id); return target && h(TeamCapabilityForm, { key: target.id, team, target, row, storage, onSaved: () => void load() }) }),
    !command && options?.policy && options.options.map(row => { const target = team.spec.execution_targets.find(value => value.id === row.target_id); const selected = options.policy.policy.targets[row.target_id]; const profile = row.capabilities.find(value => value.id === selected?.capability_id && value.revision === selected?.capability_revision); return target && h(TeamCapabilityUpdateForm, { key: target.id, team, target, policy: options.policy, profile, storage, onSaved: next => { setOptions(null); setMessage('能力修改已保存为草稿，请重新核对激活条件。运行中的任务保持原配置。'); onSaved?.(next) } }) }),
    message && h('p', { role: 'status' }, message))
}
