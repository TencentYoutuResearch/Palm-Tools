import React from 'react'
import { capabilityKey, capabilityCommand, confirmCapability, requestCapability } from './team-capability.js'
const h = React.createElement
export function TeamCapabilityForm({ team, target, row, storage, onSaved }) {
  const [values, setValues] = React.useState({ tag: '', score: '', confidence: '', evidence: '', expires: '', cost: '', latency: '', pinned: false })
  const [opened, setOpened] = React.useState(false), [proposal, setProposal] = React.useState(null), [pending, setPending] = React.useState(null), [ready, setReady] = React.useState(false)
  const [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void storage.read(capabilityKey(team, target)).then(value => {
      if (controller.signal.aborted) return
      if (value && (value.home_hub !== team.home_hub || value.command?.team_id !== team.id || value.command.command.target_id !== target.id)) throw Error('Wrong capability record')
      setPending(value?.state === 'accepted' ? null : value); setReady(true)
    }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取能力评价请求，请重新打开团队。') })
    return () => controller.abort()
  }, [team.id, team.home_hub, target.id])
  const prepare = () => {
    setMessage('')
    try { setProposal(capabilityCommand(team, target, row, values)) }
    catch { setMessage('请填写评价、可信度和期限，并确认当前账户与团队方案一致；此入口用于新增初始版本评价。') }
  }
  const confirm = async () => {
    if (running.current || (!proposal && !pending)) return
    running.current = true; setBusy(true); setMessage('')
    try {
      const value = await confirmCapability({ team, target, storage, command: pending?.command.command ?? proposal, request: requestCapability, signal: active.current.signal })
      if (!active.current.signal.aborted) { setPending(null); setProposal(null); setOpened(false); setMessage('用户能力评价已保存，账户绑定未改变。'); onSaved?.(value.capability_profile.id) }
    } catch {
      if (!active.current.signal.aborted) { setMessage('能力评价结果尚未确认，请恢复原请求。'); try { const value = await storage.read(capabilityKey(team, target)); if (value?.state !== 'accepted') setPending(value) } catch {} }
    } finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const command = pending?.command.command ?? proposal
  return h('section', { className: 'kode-collab-capability-form' }, h('h5', null, target.model_id, ' 的用户评价'),
    h('p', null, '用户声明的偏好，不是实测能力或供应商价格。新增评价不会修改已有固定评价。'),
    command ? h('div', null, ...Object.entries(command.capability_profile.assessments).map(([id, value]) => h('p', { key: id }, id, '：', value.evaluation.tag ?? value.evaluation.tier ?? value.evaluation.preference, value.evaluation.score === undefined ? '' : ` ${value.evaluation.score} 分`, '；可信度 ', value.confidence, value.pinned ? '；固定' : '', '；有效至 ', new Date(value.valid_until).toLocaleString())),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void confirm() }, pending ? '恢复原能力评价' : '确认保存用户评价'),
      !pending && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setProposal(null) }, '返回修改评价')) : !opened ?
    h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready || busy, onClick: () => setOpened(true) }, '新增用户能力评价') :
    h('div', null,
      ...[['tag', '任务类型'], ['score', '能力评分'], ['confidence', '评价可信度'], ['evidence', '评价依据'], ['expires', '评价到期时间']].map(([key, label]) => h('label', { key }, label, h('input', { 'aria-label': `${target.id} ${label}`, type: key === 'expires' ? 'datetime-local' : 'text', value: values[key], disabled: busy, onChange: event => setValues(previous => ({ ...previous, [key]: event.target.value })) }))),
      ...[['cost', '成本等级'], ['latency', '时延等级']].map(([key, label]) => h('label', { key }, label, h('select', { value: values[key], disabled: busy, onChange: event => setValues(previous => ({ ...previous, [key]: event.target.value })) }, h('option', { value: '' }, '不评价'), ...[['low', '低'], ['medium', '中'], ['high', '高']].map(([value, text]) => h('option', { key: value, value }, text))))),
      h('label', null, h('input', { type: 'checkbox', checked: values.pinned, disabled: busy, onChange: event => setValues(previous => ({ ...previous, pinned: event.target.checked })) }), '固定此评价，自动建议不得覆盖'),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: prepare }, '核对用户能力评价')),
    message && h('p', { role: 'status' }, message))
}
