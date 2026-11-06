import React from 'react'
import { workflowSetupKey, readWorkflowCommand, hasUpdatedWorkflow, confirmWorkflowRegistration, requestWorkflowRegistration } from './builder-workflow-command.js'
const h = React.createElement
export function BuilderWorkflowView({ draft, storage }) {
  const [slot, setSlot] = React.useState(null), [review, setReview] = React.useState(null), [ready, setReady] = React.useState(false), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void readWorkflowCommand(storage, draft).then(value => {
      if (controller.signal.aborted) return
      setSlot(value); setReady(true)
    }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取流程确认记录，请重新打开草案。') })
    return () => controller.abort()
  }, [draft.id, draft.home_hub, draft.revision])
  const confirm = async () => {
    if (running.current || (!slot && !review)) return
    running.current = true; setBusy(true); setMessage('')
    try {
      await confirmWorkflowRegistration({ draft: review ?? { ...draft, interview: { ...draft.interview, proposed_workflow: slot.proposal } }, storage, replaceRegistered: Boolean(review), request: requestWorkflowRegistration, signal: active.current.signal })
      if (!active.current.signal.aborted) { setSlot(await storage.read(workflowSetupKey(draft))); setReview(null) }
    } catch { if (!active.current.signal.aborted) { setMessage('流程登记尚未确认，部分版本可能已保存，请恢复原请求。'); try { setSlot(await storage.read(workflowSetupKey(draft))) } catch {} } }
    finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const updated = hasUpdatedWorkflow(draft, slot)
  const proposal = review?.interview.proposed_workflow ?? slot?.proposal ?? draft.interview.proposed_workflow
  if (!proposal) return null
  const pack = proposal.workflow, project = proposal.project.spec, delivery = proposal.delivery
  return h('section', { className: 'kode-collab-workflow-proposal' }, h('h3', null, '工作流方案'),
    h('p', null, '登记流程、项目绑定和交付策略供团队引用。登记本身不执行命令、不授予权限、不激活团队。'),
    h('p', null, '输入：', pack.inputs.join('、')),
    ...pack.stages.map(stage => h('article', { key: stage.id }, h('h4', null, stage.id, ' · ', stage.role), h('p', null, '依赖：', stage.requires.join('、'), '；产出：', stage.produces.join('、'), '；独立于：', stage.independent_from.join('、')),
      stage.execution && h('p', null, '能力：', stage.execution.capabilities.join('、'), '；工具：', stage.execution.tools.join('、'), '；网络：', stage.execution.network ? '允许' : '不允许'),
      ...(stage.execution?.dependencies ?? []).map(reference => h('p', { key: reference.id }, '指令资源 ', reference.id, ' · ', reference.version, ' · ', reference.hash)),
      ...(stage.execution?.escalation ?? []).map(rule => h('p', { key: rule.after_reworks }, `此阶段累计返工 ${rule.after_reworks} 次后：按「${rule.task_tag}」能力选择资源，最低质量 ${rule.minimum_quality}。仍受原预算、权限和返工上限约束；资源不足时等待处理。`)),
      stage.waiver && h('p', null, '人工豁免策略：仅你可以确认，必须说明原因并绑定当前产物。', stage.waiver.allow_delivery ? '策略允许带明确标记的豁免交付；豁免不代表验证通过。' : '策略不允许带豁免交付。'),
      stage.on_reject && h('p', null, '未通过时：', JSON.stringify(stage.on_reject)))),
    h('p', null, '完成阶段：', pack.completion_stages.join('、')),
    ...Object.entries(pack.evidence_rules).map(([id, rule]) => h('p', { key: id }, '证据 ', id, '：', JSON.stringify(rule))),
    ...Object.entries(project.repositories).map(([id, repo]) => h('p', { key: id }, '仓库 ', id, '：', repo.repository_id, ' · ', repo.workspace.host_id, ' · ', repo.workspace.root_ref)),
    ...Object.entries(project.commands ?? {}).map(([id, command]) => h('p', { key: id }, '验证命令 ', id, '：执行器 ', command.runner_id, '；场景 ', command.scenario_ids.join('、'))),
    ...Object.entries(project.connections ?? {}).map(([id, connection]) => h('p', { key: id }, '连接 ', id, '：', connection.connection_id, '；能力 ', connection.capabilities.join('、'))),
    ...delivery.targets.map((target, index) => h('p', { key: index }, '交付终点：', JSON.stringify(target))), h('p', null, '必需产物：', delivery.required_outputs.join('、')),
    h('p', null, delivery.human_acceptance ? '人工验收：流程证据通过后，仍需你确认本次交付。' : '人工验收：未设额外人工门禁，由 Hub 按流程证据判定交付。'),
    slot?.state === 'registered' && !review ? h('p', null, '流程配置已登记。创建助手可引用这些版本更新团队方案，团队仍需单独确认和激活。') :
      slot?.state === 'prepared' ? h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void confirm() }, '恢复原流程登记') :
      review ? h('div', null, h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void confirm() }, '确认登记流程配置'), h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setReview(null) }, '返回查看流程')) :
      h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready || busy, onClick: () => setReview(structuredClone(draft)) }, '核对工作流方案'),
    updated && !review && h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready || busy, onClick: () => setReview(structuredClone(draft)) }, '核对更新后的工作流方案'),
    slot?.state === 'prepared' && slot.command.expected_revision < draft.revision && h('p', null, '草案已有更新。先恢复此前确认的流程登记，再核对新方案。'),
    message && h('p', { role: 'status' }, message))
}
