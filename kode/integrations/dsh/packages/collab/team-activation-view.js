import { TeamSchedulingForm } from './team-scheduling-form.js'
import { TeamInitialBudgetForm } from './team-initial-budget-form.js'
import { TeamAuthorityForm } from './team-authority-form.js'
import { verifyActivationState } from './team-deactivation.js'
import { TeamDeactivationView } from './team-deactivation-view.js'
import React from 'react'
import { WorkflowDependencyReview } from './workflow-dependency-review.js'
import { activationKey, activateReviewedTeam, activationNeedsConfirmation, verifyActivationReceipt, teamActivationRequest } from './team-activation.js'
const h = React.createElement
const reasons = { assignment_account_capacity_missing: '账号工作并发上限尚未配置，请在调度偏好中设置后重新核对。', coordinator_team_required: '团队不是任务协调者', configuration_incomplete: '流程、项目或执行策略尚未配齐', grant_missing_revoked_or_expired: '权限未配置、已撤销或已过期' }
export function TeamActivationView({ team: suppliedTeam, storage }) {
  const [updatedTeam, setUpdatedTeam] = React.useState(null)
  const team = updatedTeam?.id === suppliedTeam.id && updatedTeam.revision > suppliedTeam.revision ? updatedTeam : suppliedTeam
  const [slot, setSlot] = React.useState(null), [review, setReview] = React.useState(null), [ready, setReady] = React.useState(false)
  const [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void storage.read(activationKey(team)).then(value => {
      if (controller.signal.aborted) return
      if (value && (value.home_hub !== team.home_hub || value.command?.team_id !== team.id)) throw Error('Wrong activation record')
      if (value?.state === 'activated') verifyActivationReceipt(value.receipt, team, value.command.command)
      setSlot(value); setReady(true)
    }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取激活记录，请重新打开草案。') })
    return () => controller.abort()
  }, [team.id, team.home_hub])
  const inspect = async () => {
    if (running.current) return
    running.current = true; setBusy(true); setMessage('')
    try {
      const request_id = crypto.randomUUID()
      const value = await teamActivationRequest('activation-review', { team_id: team.id, team_revision: team.revision, request_id }, { signal: active.current.signal })
      if (value.team?.id !== team.id || value.team.home_hub !== team.home_hub || value.team.revision !== team.revision || value.activation_performed !== false || !Array.isArray(value.issues)
        || (value.prepared_command && (value.prepared_command.action !== 'activate' || value.prepared_command.team_revision !== team.revision || value.prepared_command.request_id !== request_id))) throw Error('Wrong review')
      if (value.activation) verifyActivationState(value.activation, team)
      if (!active.current.signal.aborted) setReview(value)
    } catch { if (!active.current.signal.aborted) setMessage('无法核对当前激活配置，请刷新团队配置后重试。') }
    finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const confirm = async () => {
    if (running.current || (!slot && !review)) return
    running.current = true; setBusy(true); setMessage('')
    try {
      await activateReviewedTeam({ storage, team, review: review ?? { prepared_command: slot.command.command }, request: (input, options) => teamActivationRequest('activation', input, options), signal: active.current.signal })
      if (!active.current.signal.aborted) { setSlot(await storage.read(activationKey(team))); setReview(null) }
    } catch { if (!active.current.signal.aborted) { setMessage('激活结果尚未确认，请恢复原请求。'); try { setSlot(await storage.read(activationKey(team))) } catch {} } }
    finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const grant = review?.grant?.policy, budget = review?.configuration?.policies?.budget?.policy
  return h('section', { className: 'kode-collab-team-activation' }, h('h3', null, '团队激活'),
    slot?.state === 'activated' ? h('div', null, h('p', null, '已有激活确认记录。实际执行仍受当前权限、资源和预算检查约束。'),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void inspect() }, '重新核对激活条件')) :
      slot ? h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void confirm() }, '恢复原激活请求') :
      h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready || busy, onClick: () => void inspect() }, '核对激活条件'),
    review && h('div', null,
      ...review.issues.map((issue, index) => h('p', { key: index }, reasons[issue.code] ?? issue.code)),
      grant && h('div', null, h('p', null, '权限：', grant.capabilities.join('、'), '；网络：', grant.network ? '允许' : '不允许'),
        ...grant.targets.map(target => h('p', { key: `${target.host}:${target.workspace}` }, target.host, ' · ', target.root)),
        h('p', null, '工具：', grant.tools.join('、')), h('p', null, '权限有效至：', new Date(grant.expires_at).toLocaleString())),
      budget && h('p', null, '团队预算单位：', budget.unit, '；单次工作预留上限：', budget.max_assignment_charge),
      ...(review.resources?.targets ?? []).map(target => h('p', { key: `capacity:${target.target_id}`, className: 'kode-collab-account-capacity' },
        target.target_id, '：', target.assignment_capacity?.configured === true
          ? `账号工作并发 ${target.assignment_capacity.snapshot.held} / ${target.assignment_capacity.snapshot.max_active_assignments}；跨团队共享，不代表供应商额度。`
          : '尚未配置账号工作并发上限，Worker 无法执行。需由账号所有者配置后重新核对。')),

      ...(review.configuration?.bindings ?? []).map(binding => h('div', { key: binding.id }, h('h4', null, '流程：', binding.id),
        ...(binding.workflow?.pack?.stages ?? []).map(stage => h('p', { key: stage.id }, stage.id, ' · ', stage.role, '；依赖：', stage.requires.join('、'), '；产出：', stage.produces.join('、'), '；独立于：', stage.independent_from.join('、'))),
        h('p', null, '完成阶段：', binding.workflow?.pack?.completion_stages?.join('、')),
        h(WorkflowDependencyReview, { binding }))),
      ...(review.configuration?.binding_issues ?? []).filter(issue => issue.code.startsWith('workflow_dependency_')).map((issue, index) =>
        h('p', { key: 'dependency:' + index, role: 'status' }, '阶段 ', issue.stage_id, ' 的指令资源尚未满足版本、Host 或权限要求，请补齐后重新核对。')),
      review.runtime_readiness?.default_adapter_checks_complete !== true && h('p', null, '执行器或流程适配尚未就绪，不能激活。'),
      ...(review.runtime_readiness?.stages??[]).filter(stage=>stage.artifact_repository?.status&&stage.artifact_repository.status!=='ready').map(stage=>h('p',{key:'artifact:'+stage.binding_id+':'+stage.stage_id},
        '阶段 ',stage.stage_id,'：',stage.artifact_repository.status==='artifact_repository_baseline_unavailable'?'当前 Git 产物适配器需要已有提交的仓库根目录，请选择符合条件的工作区或调整流程。':stage.artifact_repository.status==='artifact_repository_remote_unchecked'?'远端仓库条件需要在对应 Host 核对。':'项目工作区不在当前已选择的范围内。')),
      review.activation?.active === true && !activationNeedsConfirmation(review) && h('p', null, '最近核对：团队已启用，无需重复激活。'),
      activationNeedsConfirmation(review) && review.prepared_command && !review.issues.length && review.runtime_readiness?.default_adapter_checks_complete === true && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void confirm() }, '确认激活此版本团队')),
    h(TeamInitialBudgetForm, { team, review, storage, onSaved: () => setReview(null) }),
    h(TeamSchedulingForm, { team, storage, onSaved: next => { setReview(null); if (next) setUpdatedTeam(next) } }),
    h(TeamAuthorityForm, { team, review, storage, onSaved: () => setReview(null) }),
    (slot?.state === 'activated' || review?.activation) && h(TeamDeactivationView, { key: review?.activation?.revision ?? slot?.receipt?.revision, team, storage }),
    message && h('p', { role: 'status' }, message))
}
