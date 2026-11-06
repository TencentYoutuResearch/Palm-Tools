import { TeamActivationView } from './team-activation-view.js'
import React from 'react'
import { builderStartKey } from './builder-start-command.js'
import { builderAcceptKey, acceptBuilderProposal, requestBuilderAccept } from './builder-accept-command.js'
const h = React.createElement
function Proposal({ spec }) {
  const refs = rows => rows.map(row => `${row.id} @ ${row.version}`).join('、') || '未配置'
  return h('div', null, h('h4', null, spec.name), h('p', null, spec.purpose),
    h('p', null, '类型：', spec.kind === 'coordinator' ? '任务协调者' : '创建助手'),
    spec.coordinator_startup && h('p', null, '启动工作区：', spec.coordinator_startup.workspace_id, '；任务类型：', spec.coordinator_startup.task_tag),
    h('h4', null, '工作区'), ...spec.workspace_refs.map(row => h('p', { key: `${row.host_id}:${row.workspace_id}` }, row.host_id, ' · ', row.root_ref)),
    h('h4', null, '执行资源'), ...spec.execution_targets.map(row => h('p', { key: row.id }, row.id, '：', row.host_id, ' / ', row.provider_id, ' / ', row.model_id, ' · 推理强度 ', row.effort ?? '默认', ' · 执行配置 ', row.executor_profile_id, ' · 账户 ', row.account_binding_id)),
    h('p', null, '协调者资源：', spec.coordinator_targets.join('、') || '未配置'),
    h('h4', null, 'Worker 分工'), ...spec.workers.map(row => h('article', { key: row.id }, h('strong', null, row.role),
      h('p', null, row.responsibilities.join('；')), h('p', null, '可用资源：', row.allowed_target_ids.join('、'), '；能力：', row.required_capabilities.join('、'), '；并行上限：', row.max_parallel),
      ...row.workspace_refs.map(workspace => h('p', { key: `${workspace.host_id}:${workspace.workspace_id}` }, workspace.host_id, ' · ', workspace.root_ref)))),
    h('h4', null, '流程与交付'), h('p', null, refs(spec.workflow_pack_refs)),
    ...(spec.delivery_bindings ?? []).map(row => h('p', { key: row.id }, row.id, '：流程 ', refs([row.workflow]), '；项目 ', refs([row.project]), '；交付策略 ', refs([row.delivery_policy]))),
    h('p', null, '权限策略：', spec.grant_id || '未配置', '；预算策略：', spec.budget_policy_id || '未配置', '；调度策略：', spec.scheduling_policy_id || '未配置'),
    h('p', null, '同时任务上限：', spec.limits.max_active_runs, '；工作分配上限：', spec.limits.max_active_assignments, '；主动工作模式：', spec.proactive_mode),
    h('p', null, '此处接受团队草案。策略内容与执行条件仍需在激活前核对。'))
}
export function BuilderProposalView({ draft, storage, onTeamSaved }) {
  const [slot, setSlot] = React.useState(null), [ready, setReady] = React.useState(false), [review, setReview] = React.useState(null)
  const [teamId, setTeamId] = React.useState(''), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void Promise.all([storage.read(builderAcceptKey(draft)), storage.read(builderStartKey(draft))]).then(([saved, start]) => {
      if (controller.signal.aborted) return
      if (saved && (saved.home_hub !== draft.home_hub || saved.command?.draft_id !== draft.id)) throw Error('Wrong acceptance')
      setSlot(saved); setTeamId(start?.command.team_id ?? crypto.randomUUID()); setReady(true)
    }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取方案确认记录，请重新打开草案。') })
    return () => controller.abort()
  }, [draft.id, draft.home_hub])
  const confirm = async () => {
    if (running.current || !ready || (!review && !slot)) return
    running.current = true; setBusy(true); setMessage('')
    try {
      const receipt = await acceptBuilderProposal({ storage, draft: review ?? draft, teamId, request: requestBuilderAccept, signal: active.current.signal })
      if (!active.current.signal.aborted) { setSlot(await storage.read(builderAcceptKey(draft))); setReview(null); setMessage('团队草案已保存，尚未激活。'); onTeamSaved?.(receipt.team) }
    } catch { if (!active.current.signal.aborted) { setMessage('方案接受结果尚未确认，请重试原请求。'); try { setSlot(await storage.read(builderAcceptKey(draft))) } catch {} } }
    finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const spec = slot?.proposal ?? (review ?? draft).interview.proposed_team
  return h('section', { className: 'kode-collab-proposal' }, h('h3', null, '团队方案'),
    spec ? h(Proposal, { spec }) : h('p', null, '创建助手尚未提交团队方案。收到回复后可刷新草案查看。'),
    slot?.state === 'saved' ? h('p', null, '已接受为团队草案，尚未激活。团队编号：', slot.receipt.team.id) :
      spec && h('div', null,
        h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready || busy, onClick: () => { if (slot || review) void confirm(); else setReview(structuredClone(draft)) } }, slot ? '恢复原方案确认' : review ? '确认保存团队草案' : '核对团队方案'),
        review && !slot && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setReview(null) }, '返回继续沟通')),
    slot?.state === 'saved' && h(TeamActivationView, { key: slot.receipt.team.id, team: slot.receipt.team, storage }),
    message && h('p', { role: 'status' }, message))
}
