import React from 'react'
import { canonical } from './builder-accept-command.js'
import { capabilityUpdateKey, prepareCapabilityUpdate, confirmCapabilityUpdate, requestCapabilityUpdate } from './team-capability-update.js'
const h = React.createElement
const labels = { task_fit: '任务能力', cost_tier: '成本等级', latency: '时延偏好', strength: '长处', weakness: '短处' }
const localTime = value => new Date(value - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16)
const describe = fact => !fact ? '无评价' : `${fact.evaluation.kind === 'task_fit' ? `${fact.evaluation.tag}：${fact.evaluation.score} 分` : fact.evaluation.text ?? fact.evaluation.tier ?? fact.evaluation.preference}；可信度 ${fact.confidence}；${fact.pinned ? '固定' : '未固定'}；来源 ${fact.source}；有效至 ${new Date(fact.valid_until).toLocaleString()}；依据 ${fact.evidence.join('；') || '未填写'}`
export function TeamCapabilityUpdateForm({ team, target, policy, profile, storage, onSaved }) {
 const [newKind, setNewKind] = React.useState('task_fit')
 const [facts, setFacts] = React.useState(null), [replacePins, setReplacePins] = React.useState(false), [proposal, setProposal] = React.useState(null), [pending, setPending] = React.useState(null)
 const [ready, setReady] = React.useState(false), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
 const active = React.useRef(null), running = React.useRef(false)
 const identity = { home_hub: team.home_hub, team_id: team.id, target_id: target.id }
 React.useEffect(() => {
  const controller = new AbortController(); active.current = controller
  void storage.read(capabilityUpdateKey(identity)).then(value => {
   if (controller.signal.aborted) return
   if (value && (value.home_hub !== team.home_hub || value.team_id !== team.id || value.target_id !== target.id)) throw Error('Wrong update scope')
   setPending(value?.state === 'accepted' ? null : value); setReady(true)
  }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取修改记录，请重新打开团队。') })
  return () => controller.abort()
 }, [team.home_hub, team.id, target.id])
 const change = (id, patch) => setFacts(previous => ({ ...previous, [id]: { ...previous[id], ...patch, source: 'user', updated_at: Date.now() } }))
 const prepare = () => {
  try {
   const changed = Object.keys({ ...profile.assessments, ...facts }).some(id => canonical(profile.assessments[id]) !== canonical(facts[id]))
   if (!changed) throw Error('No changes')
   for (const [id, fact] of Object.entries(facts)) if (canonical(fact) !== canonical(profile.assessments[id]) && (fact.evidence.some(text => !text.trim() || text.length > 2048) || fact.evidence.length > 16 || ['strength', 'weakness'].includes(fact.evaluation.kind) && !fact.evaluation.text.trim() || !Number.isFinite(fact.confidence) || fact.confidence < 0 || fact.confidence > 1 || !Number.isSafeInteger(fact.valid_until) || fact.valid_until <= Date.now() || fact.evaluation.kind === 'task_fit' && (!fact.evaluation.tag.trim() || !Number.isInteger(fact.evaluation.score) || fact.evaluation.score < 0 || fact.evaluation.score > 100))) throw Error('Invalid assessment')
   setProposal(prepareCapabilityUpdate({ team, policy, profile, targetId: target.id, assessments: facts, replacePins, requestId: crypto.randomUUID() })); setMessage('')
  } catch { setMessage('请填写有效评价并作出修改；变更固定评价时需明确同意替换。') }
 }
 const confirm = async () => {
  if (running.current || !(pending ?? proposal)) return
  running.current = true; setBusy(true); setMessage('')
  try {
   const result = await confirmCapabilityUpdate({ storage, prepared: pending ?? proposal, request: requestCapabilityUpdate, signal: active.current.signal })
   if (!active.current.signal.aborted) { setPending(null); setProposal(null); setFacts(null); setMessage('能力修改已保存为草稿。请重新核对并激活；运行中的任务保持原配置。'); onSaved?.(result.team) }
  } catch {
   if (!active.current.signal.aborted) { setMessage('修改结果尚未确认，请恢复原修改请求。'); try { const value = await storage.read(capabilityUpdateKey(identity)); if (value?.state !== 'accepted') setPending(value) } catch {} }
  } finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
 }
 const reviewed = pending ?? proposal
 const field = (id, label, value, apply, type = 'text') => h('label', { key: label }, label, h('input', { 'aria-label': `${target.id} ${id} ${label}`, type, value, disabled: busy, onChange: e => apply(e.target.value) }))
 return h('section', { className: 'kode-collab-capability-update' }, h('h5', null, target.model_id, ' 的能力评价修改'),
  h('p', null, '修改以用户声明保存。保存草稿不会启动任务，生效前需要重新激活。'),
  reviewed ? h('div', null,
   h('p', null, `目标 ${target.id}；能力版本 ${reviewed.command.capability_revision} → ${reviewed.command.capability_revision + 1}`),
   ...Object.keys({ ...reviewed.before.profile.assessments, ...reviewed.command.assessments }).filter(id => canonical(reviewed.before.profile.assessments[id]) !== canonical(reviewed.command.assessments[id])).map(id => h('p', { key: id }, labels[(reviewed.command.assessments[id] ?? reviewed.before.profile.assessments[id]).evaluation.kind], '：', describe(reviewed.before.profile.assessments[id]), ' → ', describe(reviewed.command.assessments[id]), reviewed.before.profile.assessments[id]?.pinned ? '（原评价已固定）' : '')),
   h('p', null, reviewed.command.replace_pins ? '已同意替换本次变更涉及的固定评价。' : '保留全部固定评价。'),
   h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void confirm() }, pending ? '恢复原能力修改' : '确认保存能力修改'),
   !pending && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setProposal(null) }, '返回修改')) : facts ? h('div', null,
   ...Object.entries(facts).map(([id, fact]) => h('fieldset', { key: id }, h('legend', null, labels[fact.evaluation.kind], fact.pinned ? ' · 固定评价' : ''),
    ...(fact.evaluation.kind === 'task_fit' ? [field(id, '任务类型', fact.evaluation.tag, tag => change(id, { evaluation: { ...fact.evaluation, tag } })), field(id, '能力评分', fact.evaluation.score, score => change(id, { evaluation: { ...fact.evaluation, score: score === '' ? NaN : Number(score) } }), 'number')] : ['cost_tier', 'latency'].includes(fact.evaluation.kind) ? [h('label', { key: 'grade' }, '等级', h('select', { 'aria-label': `${target.id} ${id} 等级`, value: fact.evaluation.tier ?? fact.evaluation.preference, onChange: e => change(id, { evaluation: { ...fact.evaluation, [fact.evaluation.kind === 'cost_tier' ? 'tier' : 'preference']: e.target.value } }) }, ...[['low', '低'], ['medium', '中'], ['high', '高']].map(([value, label]) => h('option', { key: value, value }, label))))] : [field(id, '说明', fact.evaluation.text, text => change(id, { evaluation: { ...fact.evaluation, text } }))]),
    field(id, '可信度', fact.confidence, confidence => change(id, { confidence: confidence === '' ? NaN : Number(confidence) }), 'number'),
    field(id, '有效至', localTime(fact.valid_until), date => { const value = Date.parse(date); if (Number.isFinite(value)) change(id, { valid_until: value }) }, 'datetime-local'),
    h('label', null, '评价依据（每行一条）', h('textarea', { 'aria-label': `${target.id} ${id} 评价依据`, value: fact.evidence.join('\n'), onChange: e => change(id, { evidence: e.target.value ? e.target.value.split('\n') : [] }) })),
    h('label', null, h('input', { type: 'checkbox', checked: fact.pinned, onChange: e => change(id, { pinned: e.target.checked }) }), '固定此评价'),
    h('button', { type: 'button', className: 'kode-collab-button', onClick: () => setFacts(previous => { const next = { ...previous }; delete next[id]; return next }) }, '删除评价'))),
   h('label', null, '新增评价类型', h('select', { value: newKind, onChange: e => setNewKind(e.target.value) }, ...Object.entries(labels).map(([value, label]) => h('option', { key: value, value }, label)))),
   h('button', { type: 'button', className: 'kode-collab-button', onClick: () => { const at = Date.now(); setFacts(previous => ({ ...previous, [crypto.randomUUID()]: { evaluation: newKind === 'task_fit' ? { kind: newKind, tag: '', score: 50 } : newKind === 'cost_tier' ? { kind: newKind, tier: 'medium' } : newKind === 'latency' ? { kind: newKind, preference: 'medium' } : { kind: newKind, text: '' }, source: 'user', confidence: 0.5, evidence: [], updated_at: at, valid_until: at + 86400000, pinned: false } })) } }, '添加评价'),
   h('label', null, h('input', { type: 'checkbox', checked: replacePins, onChange: e => setReplacePins(e.target.checked) }), '同意替换本次修改涉及的固定评价'),
   h('button', { type: 'button', className: 'kode-collab-button', onClick: prepare }, '核对能力修改'),
   h('button', { type: 'button', className: 'kode-collab-button', onClick: () => { setFacts(null); setMessage('') } }, '取消修改')) : h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready || busy || !profile, onClick: () => { setFacts(structuredClone(profile.assessments)); setReplacePins(false) } }, '修改已有能力评价'),
  message && h('p', { role: 'status' }, message))
}
