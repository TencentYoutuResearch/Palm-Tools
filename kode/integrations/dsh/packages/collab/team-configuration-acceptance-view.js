import React from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { readNativeCatalog } from './team-native-target.js'
import { acceptanceRequest, configurationAcceptanceKey, verifyAcceptanceStatus, prepareAcceptance, acceptConfiguration, verifyAcceptanceReceipt, verifyBuilderLineage } from './team-configuration-acceptance.js'
const h = React.createElement
export function TeamConfigurationAcceptanceView({ team, storage }) {
  const [status, setStatus] = React.useState(null), [pending, setPending] = React.useState(null), [review, setReview] = React.useState(null)
  const [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const [profiles, setProfiles] = React.useState([])
  const active = React.useRef(null), running = React.useRef(false)
  const inspect = async signal => {
    // Reads never confirm, resend, save, activate or send a model message.
    const slot = await storage.read(configurationAcceptanceKey(team))
    const value = verifyAcceptanceStatus(team, await acceptanceRequest(team, null, { signal }))
    if (value.builder_lineage) verifyBuilderLineage(team, value.builder_lineage)
    if (slot) {
      if (slot.command?.expected_revision !== team.revision) throw Error('Wrong pending revision')
      const receipt = await acceptanceRequest(team, null, { signal, requestId: slot.command.request_id })
      if (receipt) verifyAcceptanceReceipt(team, slot.command, receipt)
    }
    if (!signal.aborted) { setPending(slot); setStatus(value) }
  }
  const query = async () => {
    if (running.current) return
    const controller = active.current
    running.current = true; setBusy(true); setMessage(''); setReview(null); setStatus(null)
    try { await inspect(controller.signal) }
    catch { if (!controller.signal.aborted) setMessage('无法核实当前版本的确认状态。请刷新团队配置后重试；保存不代表已确认。') }
    finally { running.current = false; if (!controller.signal.aborted) setBusy(false) }
  }
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    setStatus(null); setPending(null); setReview(null); void query()
    setProfiles([])
    void readNativeCatalog(team, undefined, controller.signal).then(value => { if (!controller.signal.aborted) setProfiles(value.profiles) }).catch(() => {})
    return () => controller.abort()
  }, [team.id, team.home_hub, team.revision])
  const combinations = ids => (ids ?? []).map(id => {
    const target = review?.spec.execution_targets?.find(row => row.id === id)
    if (!target) return '资源待核实'
    const profile = profiles.find(row => row.id === target.executor_profile_id)
    return `${profile?.name || '已保存的 Agent'} / ${target.model_id}${target.effort ? ` · ${target.effort}` : ''}`
  }).join('、') || '尚未选择'
  const confirm = async () => {
    if (running.current || !review) return
    const controller = active.current
    running.current = true; setBusy(true); setMessage('')
    try {
      await acceptConfiguration({ team, command: review, storage, signal: controller.signal })
      if (!controller.signal.aborted) { setReview(null); await inspect(controller.signal); setMessage('版本确认已记录，未启动模型或发送消息。') }
    } catch {
      if (!controller.signal.aborted) {
        setReview(null); setStatus(null); setMessage('确认结果尚未核实。先查询状态；恢复时只重发原请求，版本冲突请刷新团队配置。')
        try { const slot = await storage.read(configurationAcceptanceKey(team)); if (!controller.signal.aborted) setPending(slot) } catch {}
      }
    } finally { running.current = false; if (!controller.signal.aborted) setBusy(false) }
  }
  return h('section', { className: 'kode-collab-team-activation', 'data-interactive-team': team.id },
    h('h3', null, '交互团队版本确认'),
    h('p', null, `已保存 v${team.revision}。保存配置与确认使用是两个步骤；均不代表模型已经执行。`),
    h('p', { role: 'status' }, status?.accepted ? `当前 v${team.revision} 已获确认。发送时仍需明确选择职责与 CLI / 模型组合，并通过就绪检查。` : '当前版本尚未核实为已确认，不能仅凭保存配置发送任务。'),
    h(Button, { disabled: busy, variant: 'outline', onClick: () => void query() }, '查询版本确认状态'),
    !status?.accepted && pending && h(Button, { disabled: busy || !status?.builder_lineage, onClick: () => setReview(pending.command) }, '核对原确认请求'),
    status && !status.accepted && !pending && status.parent_accepted_revision !== null && h(Button, { disabled: busy, onClick: () => { try { setReview(prepareAcceptance(team, status, crypto.randomUUID())) } catch { setMessage('无法准备确认，请刷新团队配置。') } } }, '核对并确认当前版本'),
    status && !status.accepted && status.parent_accepted_revision === null && h('p', null, '缺少原 Builder 确认来源，不能自动补建确认。'),
    h(Modal, { open: !!review, title: '确认使用此版本配置', closeLabel: '关闭', onClose: () => { if (!busy) setReview(null) },
      footer: h(React.Fragment, null, h(Button, { disabled: busy, onClick: () => setReview(null) }, '取消'),
        h(Button, { variant: 'primary', disabled: busy || !review, onClick: () => void confirm() }, pending ? '恢复原确认请求' : '确认此版本配置')) },
      review && h(React.Fragment, null,
        h('h3', null, `${review.spec.name || '当前团队'} · 第 ${review.expected_revision} 版`),
        h('p', null, review.spec.purpose),
        h('p', null, `协调者 → ${combinations(review.spec.coordinator_targets)}`),
        ...(review.spec.workers ?? []).map(worker => h('div', { key: worker.id },
          h('p', null, `${worker.role} → ${combinations(worker.allowed_target_ids)}`),
          h('p', null, worker.responsibilities?.join('；')))),
        h('p', null, '工作区：', (review.spec.workspace_refs ?? []).map(ref => ref.root_ref).join('、') || '尚未配置'),
        h('p', null, '沿用最初经你确认的 Builder 来源，只确认当前已保存的配置。权限不扩展，不会启动模型、发送消息或重放待发消息。'),
        h('details', null, h('summary', null, '查看完整配置'),
          h('p', null, `团队：${team.id} · 原已确认 v${review.parent_accepted_revision}`),
          h('p', null, `原 Builder：${status?.builder_lineage?.draft_id} · 草案 v${status?.builder_lineage?.draft_revision}`),
          h('p', null, `请求：${review.request_id}`),
          h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '45vh', overflow: 'auto' }, 'aria-label': '完整团队配置' }, JSON.stringify(review.spec, null, 2))))),
    message && h('p', { role: 'status' }, message))
}
