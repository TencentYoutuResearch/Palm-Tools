import { TeamActivationView } from './team-activation-view.js'
import { BuilderCandidateReview } from './builder-candidate-review.js'
import React from 'react'
import { builderStartKey } from './builder-start-command.js'
import { builderAcceptKey, acceptBuilderProposal, requestBuilderAccept } from './builder-accept-command.js'
const h = React.createElement
/** Saved instruction text, folded; it is plain text and never rendered as markup. */
const Instruction = ({ label, text }) => h('details', { className: 'kode-collab-proposal-instruction' }, h('summary', null, label),
  h('p', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, text))
function Proposal({ spec }) {
  return h('div', null, h('h4', null, spec.name), h('p', null, spec.purpose),
    h('p', null, '类型：', spec.kind === 'coordinator' ? '任务协调者' : 'Team Builder'),
    spec.coordinator_startup && h('p', null, '启动工作区：', spec.coordinator_startup.workspace_id, '；任务类型：', spec.coordinator_startup.task_tag),
    h('h4', null, '工作区'), ...spec.workspace_refs.map(row => h('p', { key: `${row.host_id}:${row.workspace_id}` }, row.host_id, ' · ', row.root_ref)),
    h('h4', null, '执行配置'), ...spec.execution_targets.map(row => h('p', { key: row.id }, row.executor_profile_id, ' · ', row.model_id, row.effort ? ` · ${row.effort}` : '')),
    spec.coordinator_prompt && h(Instruction, { label: '协调者指令', text: spec.coordinator_prompt }),
    h('h4', null, 'Worker 分工'), ...spec.workers.map(row => h('article', { key: row.id }, h('strong', null, row.role),
      h('p', null, row.responsibilities.join('；')), row.role_prompt && h(Instruction, { label: '角色指令', text: row.role_prompt }),
      ...(row.workspace_refs ?? []).map(workspace => h('p', { key: `${workspace.host_id}:${workspace.workspace_id}` }, workspace.host_id, ' · ', workspace.root_ref)))),
    h('p', null, spec.execution_mode === 'interactive_native' ? '接受后通过团队频道与私信协作，不走受控执行激活流程，也不会自动开始任务。' : '此处接受团队草案。策略内容与执行条件仍需在激活前核对。'))
}
export function BuilderProposalView({ draft, storage, onTeamSaved, onDraftSaved, onRefresh, externalRequest }) {
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
  const confirm = async (candidate = null) => {
    const accepted = candidate ?? review ?? draft
    if (running.current || !ready || (!candidate && !review && !slot)) return
    running.current = true; setBusy(true); setMessage('')
    try {
      const receipt = await acceptBuilderProposal({ storage, draft: accepted, teamId, request: requestBuilderAccept, signal: active.current.signal })
      if (!active.current.signal.aborted) { setSlot(await storage.read(builderAcceptKey(draft))); setReview(null); setMessage(receipt.team.spec?.execution_mode === 'interactive_native' ? '原生交互团队已保存，可进入团队频道或私信开始协作；尚未发送任务。' : '团队草案已保存，尚未激活。'); onTeamSaved?.(receipt.team) }
    } catch { if (!active.current.signal.aborted) { setMessage('方案接受结果尚未确认，请重试原请求。'); try { setSlot(await storage.read(builderAcceptKey(draft))) } catch {} } }
    finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  React.useEffect(() => {
    const proposal=externalRequest?.proposal
    if(!ready||!proposal||proposal.format!=='kode.team-proposal.v1'||!proposal.proposed_team)return
    const candidate={...draft,interview:{...draft.interview,proposed_team:proposal.proposed_team,...(proposal.proposed_workflow?{proposed_workflow:proposal.proposed_workflow}:{})}}
    if(externalRequest.action==='accept')void confirm(candidate);else setReview(candidate)
  },[externalRequest?.nonce,ready])
  const spec = slot?.proposal ?? (review ?? draft).interview.proposed_team
  return h('section', { className: 'kode-collab-proposal' }, h('h3', null, '团队方案'),
    // Once an acceptance has started for this draft, the proposal it froze is not edited here.
    ready && !slot && !review && draft.status === 'draft' && h(BuilderCandidateReview, { draft, storage, onSaved: onDraftSaved, onRefresh }),
    spec ? h(Proposal, { spec }) : h('p', null, '草案中还没有保存的团队方案。可以在上方审核规划会话给出的候选并保存。'),
    slot?.state === 'saved' ? h('p', null, slot.receipt.team.spec?.execution_mode === 'interactive_native' ? '已接受为原生交互团队，尚未发送任务。团队编号：' : '已接受为团队草案，尚未激活。团队编号：', slot.receipt.team.id) :
      spec && h('div', null,
        h('button', { type: 'button', className: 'kode-collab-button', disabled: !ready || busy, onClick: () => { if (slot || review) void confirm(); else setReview(structuredClone(draft)) } }, slot ? '恢复原方案确认' : review ? '确认保存团队草案' : '核对团队方案'),
        review && !slot && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setReview(null) }, '返回继续沟通')),
    slot?.state === 'saved' && slot.receipt.team.spec?.execution_mode === 'interactive_native' && h(TeamActivationView, { key: slot.receipt.team.id, team: slot.receipt.team, storage }),
    message && h('p', { role: 'status' }, message))
}
