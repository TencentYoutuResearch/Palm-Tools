import React from 'react'
import { authorityKey, authorityCommand, confirmTeamAuthority, requestTeamAuthority } from './team-authority.js'
const h = React.createElement
export function TeamAuthorityForm({ team, review, storage, onSaved }) {
  const [allowAnswers, setAllowAnswers] = React.useState(true)
  React.useEffect(() => { setAllowAnswers(review?.grant ? review.grant.policy.tools.includes('kode_coordinator_answer_clarification') : true) }, [team.id, team.home_hub, review?.grant?.revision])
  const [expires, setExpires] = React.useState(''), [proposal, setProposal] = React.useState(null), [pending, setPending] = React.useState(null)
  const [busy, setBusy] = React.useState(false), [ready, setReady] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void storage.read(authorityKey(team)).then(row => {
      if (controller.signal.aborted) return
      if (row && (row.home_hub !== team.home_hub || row.command?.team_id !== team.id)) throw Error('Wrong authority record')
      setPending(row?.state === 'accepted' ? null : row); setReady(true)
    }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取授权请求，请重新打开团队管理。') })
    return () => controller.abort()
  }, [team.id, team.home_hub])
  const prepare = event => {
    event.preventDefault(); setMessage('')
    try { setProposal(authorityCommand(team, review, new Date(expires).getTime(), crypto.randomUUID(), { allowClarificationAnswers: allowAnswers })) }
    catch { setMessage('请先核对团队配置，并配齐流程、项目、预算和调度策略。') }
  }
  const confirm = async () => {
    if (running.current || (!proposal && !pending)) return
    running.current = true; setBusy(true); setMessage('')
    try {
      await confirmTeamAuthority({ storage, team, command: pending?.command.command ?? proposal, request: requestTeamAuthority, signal: active.current.signal })
      if (!active.current.signal.aborted) { setProposal(null); setPending(null); setMessage('权限配置已保存，尚未执行激活。请重新核对激活条件。'); onSaved?.() }
    } catch {
      if (!active.current.signal.aborted) { setMessage('权限配置结果尚未确认，请恢复原请求。'); try { const row = await storage.read(authorityKey(team)); if (row?.state !== 'accepted') setPending(row) } catch {} }
    } finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const command = pending?.command.command ?? proposal, grant = command?.grant.policy
  return h('section', { className: 'kode-collab-authority-form' }, h('h4', null, '确认流程权限'),
    h('p', null, '按流程所需范围替换团队授权。保存会更新授权及关联策略版本，需重新核对并激活；不会自动扩大在途任务权限。'),
    command ? h('div', null,
      h('p', null, '能力：', grant.capabilities.join('、'), '；网络：', grant.network ? '允许' : '不允许'),
      ...grant.targets.map(target => h('p', { key: target.host + ':' + target.workspace }, target.host, ' · ', target.root)),
      h('p', null, '工具：', grant.tools.join('、')),
      grant.tools.includes('kode_coordinator_answer_clarification') && h('p', null, '允许 Superagent 将本对话中你对 Worker 问题的回答原样转发，继续原任务。'), h('p', null, '有效至：', new Date(grant.expires_at).toLocaleString()),
      h('p', null, '使用预算：', grant.budget_ids.join('、'), '；单次预留上限：', command.budget_policy.policy.max_assignment_charge, ' ', command.budget_policy.policy.unit),
      h('p', null, '保留已核对的调度目标、能力评价与质量/成本/时延权重。'),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void confirm() }, pending ? '恢复原权限确认' : '确认保存流程权限'),
      !pending && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setProposal(null) }, '返回修改权限期限')) :
    h('form', { onSubmit: prepare },
      team.spec.kind === 'coordinator' && h('label', null, h('input', { type: 'checkbox', checked: allowAnswers, disabled: busy, onChange: event => setAllowAnswers(event.target.checked) }), '允许 Superagent 转发我的回答以继续 Worker'),
      h('label', null, '权限到期时间', h('input', { type: 'datetime-local', 'aria-label': '团队权限到期时间', value: expires, disabled: busy, required: true, onChange: event => setExpires(event.target.value) })),
      h('button', { type: 'submit', className: 'kode-collab-button', disabled: !ready || busy || !review }, '核对流程所需权限')),
    message && h('p', { role: 'status' }, message))
}
