import React from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { fetchPlanning, planningDiagnostic } from './builder-planning.js'
import { usePlanningChoice } from './builder-planning-controls.js'
import { readHandoffScope, prepareHandoff, confirmHandoff, verifyHandoff, pendingHandoff, handoffError, handoffChoiceKey } from './builder-planning-handoff.js'
const h = React.createElement
// The confirmation shows the frozen prepared command, never the live choice.
const frozenData = (data, command) => {
  const profile = data.profiles?.find(row => row.id === command.profileId) ?? { id: command.profileId, name: command.profileId }
  const model = data.models?.find(row => row.id === command.selection.model)
  return { ...data, currentProfile: profile, selectedProfileId: profile.id, fast: command.selection.fast,
    selection: { provider: model?.provider, model: command.selection.model, reasoningEffort: command.selection.reasoningEffort } }
}
const sameContext = (a, b) => a.context_epoch === b.context_epoch && a.draft_revision === b.draft_revision && a.context_sha256 === b.context_sha256 && a.source_draft_revision === b.source_draft_revision && a.latest_context_sha256 === b.latest_context_sha256

const DESCRIPTION = '更换 Agent 并建立继任规划会话，带入当前规划上下文。原会话保留；不会自动发送任何内容，也不会创建团队、预算或执行授权。'

/**
 * The adapter the native HandoffMenu renders in planning mode. One mount per source Session;
 * a synchronous ref closes the double-click gap and the mount's signal ends every late step.
 */
export function usePlanningHandoff({ draft, sessionId, storage, controls, request = fetchPlanning, uuid, onReady, refreshChoice }) {
  const planning = usePlanningChoice({ controls, storage, home: draft.home_hub, draftId: draft.id, choiceKey: handoffChoiceKey(draft, sessionId), fast: true })
  const [state, setState] = React.useState({ open: false, phase: 'loading', scope: null, prepared: null, retry: null, error: '', busy: false })
  const inFlight = React.useRef(false), lifetime = React.useRef(null), opened = React.useRef(0)
  React.useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort() }, [])
  const patch = value => { if (!lifetime.current.signal.aborted) setState(previous => ({ ...previous, ...value })) }
  const diagnose = (error, stage) => `${handoffError(error, stage)} ${planningDiagnostic(error)}`
  // The phase follows the server state and this device's record; an unconfirmed original always wins.
  const settle = async (signal, extra = {}) => {
    const scope = await readHandoffScope({ draft, sessionId, request, signal })
    const local = await pendingHandoff(storage, draft, sessionId).catch(() => ({ unreadable: true }))
    signal.throwIfAborted()
    const phase = local?.command || scope?.retry ? 'pending' : local?.unreadable ? 'unreadable' : !scope ? 'unavailable' : scope.state === 'superseded' ? 'superseded' : scope.state === 'handoff_pending' ? 'unavailable' : 'choose'
    patch({ phase, scope, retry: scope?.retry ?? null, prepared: null, ...extra })
  }
  const run = async (stage, operation) => {
    if (inFlight.current) return
    inFlight.current = true; patch({ busy: true, error: '' })
    const signal = lifetime.current.signal
    try { await operation(signal) }
    catch (error) {
      if (signal.aborted) return
      const error_ = diagnose(error, stage)
      // After any send, the server and the stored original decide what is offered next.
      if (stage === 'send') await settle(signal, { error: error_ }).catch(() => patch({ phase: 'pending', error: error_ }))
      else patch({ error: error_, ...(stage === 'read' ? { phase: 'unavailable' } : {}) })
    } finally { inFlight.current = false; patch({ busy: false }) }
  }
  const open = () => { opened.current++; patch({ open: true, phase: 'loading', prepared: null, error: '' }); void run('read', settle) }
  const close = () => { if (!inFlight.current) patch({ open: false, prepared: null, error: '' }) }
  const prepare = () => run('prepare', async signal => {
    const prepared = await prepareHandoff({ scope: state.scope, choice: refreshChoice ?? planning.choice, refreshContext: !!refreshChoice, request, signal })
    signal.throwIfAborted(); patch({ phase: 'confirm', prepared: { command: prepared, scope: state.scope, revision: draft.revision } })
  })
  const finish = async (receipt, signal) => { signal.throwIfAborted(); patch({ open: false, prepared: null }); await onReady?.(receipt, signal) }
  const confirm = () => run('send', async signal => {
    const { command, scope, revision } = state.prepared
    // The confirmation covers exactly the context it was prepared for; any change withdraws it before storing.
    const fresh = await readHandoffScope({ draft, sessionId, request, signal }).catch(() => null)
    signal.throwIfAborted()
    if (!fresh || fresh.state !== 'active' || !sameContext(fresh, scope) || draft.revision !== revision) {
      patch({ phase: fresh ? 'choose' : 'unavailable', prepared: null, scope: fresh, error: handoffError({ code: 'handoff_scope_changed' }) }); return
    }
    await finish(await confirmHandoff({ storage, draft, prepared: command, uuid, request, signal }), signal)
  })
  const verify = () => run('send', async signal => finish(await verifyHandoff({ storage, draft, sessionId, retry: state.retry, request, signal }), signal))
  // A newer draft revision withdraws an open confirmation; nothing was stored for it yet.
  React.useEffect(() => {
    if (state.prepared && state.prepared.revision !== draft.revision && !inFlight.current) patch({ phase: 'choose', prepared: null, error: handoffError({ code: 'handoff_scope_changed' }) })
  }, [draft.revision])
  const picking = state.phase === 'choose' || state.phase === 'confirm'
  const notes = {
    loading: '正在读取交接状态…',
    choose: refreshChoice ? '保留当前 Agent 与模型，先准备最新草案上下文；准备只读取服务给出的方案，不会保存或发送请求。' : '选择目标 Agent 与模型后先准备交接：准备只读取服务给出的交接方案，不会保存或发送请求。',
    confirm: (refreshChoice ? '确认后会保留当前 Agent 与模型，按最新草案建立继任规划会话，不自动发送。' : '确认后会更换 Agent 并建立继任规划会话，不自动发送。') + '本机先保存这次请求，再只发送一次；没有收到确认时原请求继续保留，不会自动重试。',
    pending: '上次交接没有收到服务确认，原请求仍保留。核对会原样重发原请求（同一 Agent、模型与请求号），不会新建其他请求。',
    superseded: '此规划会话已交接给继任会话，不能再次交接。',
    unavailable: '当前会话没有可用的规划交接：服务未提供交接状态，或交接正在进行但没有可核对的原请求。没有发送任何请求。',
    unreadable: '本机记录的交接请求无法读取，为避免重复建立会话，没有发送任何请求。',
  }
  const actions = {
    choose: { label: '准备交接', busyLabel: '正在准备…', disabled: !(refreshChoice || planning.ready) || !state.scope, run: () => void prepare() },
    confirm: { label: '确认交接', busyLabel: '正在交接…', run: () => void confirm() },
    pending: { label: '核对原请求', busyLabel: '正在核对…', run: () => void verify() },
  }
  return {
    open: state.open, busy: state.busy, phase: state.phase, error: state.error, description: DESCRIPTION, note: notes[state.phase] + (state.prepared?.command.planning.refresh_context ? ` 将从草案第 ${state.prepared.command.planning.refresh_context.source_draft_revision} 版更新为第 ${state.prepared.command.planning.draft_revision} 版；旧会话与旧回复保留，不会改写。` : ''), scopeKey: `${sessionId}:${opened.current}`,
    preparedContext: state.prepared?.command.planning ?? null, action: actions[state.phase] ?? null, onOpen: open, onClose: close,
    picker: picking ? { data: state.phase === 'confirm' && state.prepared ? frozenData(planning.pickerData, state.prepared.command) : planning.pickerData,
      loading: planning.loading, modelError: planning.modelError || planning.error,
      lockedReason: state.phase === 'confirm' ? '已准备交接；取消后可重新选择。' : state.busy ? '正在准备交接…' : undefined,
      selectProfile: planning.selectProfile, selectModel: planning.selectModel } : null,
  }
}

/** The native session-header handoff, in Orbit's planning bar; absent when the Kode menu is not registered. */
export function PlanningHandoffEntry({ host, draft, sessionId, storage, controls, request, uuid, onReady }) {
  const planning = usePlanningHandoff({ draft, sessionId, storage, controls, request, uuid, onReady })
  return host?.Handoff ? h(host.Handoff, { sessionId, planning }) : null
}

/** Explicit fresh context with the existing Agent/model and unchanged access scope. */
export function PlanningContextRefresh({ draft, binding, storage, controls, onReady }) {
  const selection = binding.initial_selection ?? {}
  const profileId = selection.provider?.startsWith('kode-agent-') ? selection.provider.slice('kode-agent-'.length) : null
  const refreshChoice = profileId && selection.model ? { profileId, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}), ...(typeof selection.fast === 'boolean' ? { fast: selection.fast } : {}) } : null
  const planning = usePlanningHandoff({ draft, sessionId: binding.session_id, storage, controls, onReady, refreshChoice })
  if (!refreshChoice) return null
  return h(React.Fragment, null,
    h(Button, { variant: 'text', onClick: planning.onOpen }, '按最新草案继续规划'),
    h(Modal, { open: planning.open, title: '按最新草案继续规划', closeLabel: '关闭', onClose: planning.onClose,
      footer: h(React.Fragment, null, h(Button, { disabled: planning.busy, onClick: planning.onClose }, '取消'),
        planning.action && h(Button, { variant: 'primary', disabled: planning.busy || planning.action.disabled, onClick: planning.action.run }, planning.busy ? planning.action.busyLabel : planning.phase === 'confirm' ? '确认按最新草案继续' : planning.action.label)) },
      h('p', null, `保留 Agent ${profileId} 与模型 ${selection.model}，建立新一代规划会话，读取草案第 ${draft.revision} 版。原会话、旧回复和待发送输入保留，不会自动复制或发送。`),
      h('p', null, '已有规划位置不变。私有空目录规划仍使用新的私有空目录，不获得团队工作区文件访问权限。不会创建团队或执行任务。'),
      h('p', { role: 'status' }, planning.note),
      planning.preparedContext && h('div', { className: 'kode-config-note', style: { overflowWrap: 'anywhere' } },
        h('p', null, `原上下文 SHA-256：${planning.preparedContext.source_context_sha256}`),
        h('p', null, `最新草案 SHA-256：${planning.preparedContext.refresh_context?.target_context_sha256 ?? planning.preparedContext.source_context_sha256}`)), planning.error && h('p', { role: 'alert' }, planning.error)))
}
