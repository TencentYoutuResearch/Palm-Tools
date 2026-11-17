import React from 'react'
import { Button, Modal, UserTextRun } from '@deepseek-ai/dsh-client-ui-primitives'
import { Icon, IconButton } from './icons.js'
import { builderConversationStyles } from './builder-conversation-styles.js'
import { useBuilderControls } from './builder-controls.js'
import { usePlanningChoice, PlanningAgentPicker, PlanningModelPicker } from './builder-planning-controls.js'
import { PlanningHandoffEntry, PlanningContextRefresh } from './builder-planning-handoff-entry.js'
import { readPlanning, pendingPlanning, startPlanning, verifyPlanning, retryPlanning, completePlanning, confirmPlanning, planningError, planningDiagnostic, planningReadError, openPlanningSession, planningChoiceKey, planningTextKey, planningGoalKey } from './builder-planning.js'
import { BuilderPrestartComposer } from './builder-prestart-composer.js'
import { BuilderCreateForm } from './builder-create-form.js'
import { BuilderWorkspaceForm } from './builder-workspace-form.js'
import { BuilderOptimizationForm } from './builder-optimization-form.js'
import { BuilderTeamLinks } from './builder-team-links.js'
import { VerificationReviewForm } from './verification-review-form.js'
import { BuilderWorkflowView } from './builder-workflow-view.js'
import { BuilderProposalView } from './builder-proposal-view.js'
import { BuilderAnswerForm } from './builder-answer-form.js'
import { BuilderLegacySession } from './builder-legacy-session.js'
import { PlanningSessionEmbed } from './planning-session-embed.js'
import { HubTeamAgentDefaults } from './team-agent-defaults.js'
import { BuilderPromptSettings } from './builder-prompt-settings.js'
import { TeamSidebarContext } from './team-sidebar.js'
const h = React.createElement
export const PlanningHostContext = React.createContext(null)

export function builderDraftTitle(purpose) {
  const first = String(purpose || '未命名团队设计').trim().split(/[。！？.!?\n]/u)[0] || '未命名团队设计'
  const chars = Array.from(first)
  return chars.length > 32 ? chars.slice(0, 32).join('') + '…' : first
}
const workspaceName = row => String(row?.root_ref ?? '').split(/[\\/]/).filter(Boolean).pop() || row?.workspace_id || '工作区'

/** The saved goal, shown once as the user's own message; long text folds with full-text disclosure. */
function GoalMessage({ purpose }) {
  const long = Array.from(purpose).length > 280 || purpose.split('\n').length > 6
  const [open, setOpen] = React.useState(false)
  return h('article', { className: 'kode-builder-message', 'data-role': 'user', 'aria-label': '团队目标' },
    h('div', { className: 'kode-builder-goal-text', 'data-collapsed': long && !open ? '' : undefined }, h(UserTextRun, { text: purpose })),
    long && h('button', { type: 'button', className: 'kode-builder-goal-toggle', 'aria-expanded': open, onClick: () => setOpen(value => !value) }, open ? '收起' : '展开全文'))
}

/** Planning lives in a real native Session; this view only links the draft to it. */
function PlanningThread({ draft, storage, controls, host, onWorkspace, onReview, visible }) {
  const planning = usePlanningChoice({ controls, storage, home: draft.home_hub, draftId: draft.id })
  const [binding, setBinding] = React.useState({ state: 'loading' }), [generation, reload] = React.useReducer(value => value + 1, 0)
  const [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState(''), [leftover, setLeftover] = React.useState('')
  const lifetime = React.useRef(null), inFlight = React.useRef(false), [completing, setCompleting] = React.useState(false)
  const [pending, setPending] = React.useState(undefined)
  React.useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller
    setBinding({ state: 'loading' }); setPending(undefined)
    // An unreadable pending record is not "nothing pending": starting stays blocked.
    pendingPlanning(storage, draft).then(row => { if (!controller.signal.aborted) setPending(row) })
      .catch(() => { if (!controller.signal.aborted) setPending({ unreadable: true }) })
    readPlanning(draft, { signal: controller.signal })
      .then(value => {
        // A failure notice stays next to the server's state: it ends only with a success or the user's next action.
        if (!controller.signal.aborted) setBinding(value)
      })
      .catch(error => { if (!controller.signal.aborted) setBinding({ state: 'error', message: planningReadError(error) }) })
    return () => controller.abort()
  }, [draft.id, draft.home_hub, generation])
  React.useEffect(() => {
    if (binding.state !== 'ready' && binding.state !== 'uncertain') return
    let alive = true
    storage.read(planningTextKey(draft)).then(row => { if (alive) setLeftover(typeof row?.content === 'string' ? row.content : '') }).catch(() => {})
    return () => { alive = false }
  }, [binding.state, draft.id])
  const refs = draft.interview.workspace_refs ?? []
  // Planning needs no project. Without a workspace the service opens it in a private
  // empty directory, never the home directory or Host cwd. An explicit choice, or a
  // draft's only workspace, is still honoured; an unreadable choice fails closed.
  const [workspaceChoice, setWorkspaceChoice] = React.useState(undefined)
  React.useEffect(() => { setWorkspaceChoice(undefined); readPlanningWorkspace(storage, draft).then(setWorkspaceChoice).catch(() => setWorkspaceChoice({ unreadable: true })) }, [draft.id, visible])
  const workspace = planningWorkspace(refs, workspaceChoice)
  const blockedReason = draft.status !== 'draft' ? '此草案已撤销。' : workspaceChoice === undefined ? '正在读取规划位置'
    : workspaceChoice.unreadable ? '无法读取之前选择的规划位置。为避免改用其它目录，暂不能开始。'
      : workspaceChoice.workspace_id && !workspace ? '之前选择的工作区已不在此草案中。' : ''
  // Only a confirmed ready receipt opens the Session. The goal is offered to its
  // input once (until the user's own handoff succeeds); nothing is ever sent.
  const [embedded, setEmbedded] = React.useState(null), shown = React.useRef(null)
  shown.current = visible ? embedded ?? (binding.state === 'ready' ? { sessionId: binding.value.session_id } : null) : null
  const settle = async (result, text, clear) => {
    if (result === 'applied') {
      // The native draft already holds the text; a failed local record keeps the leftover and never re-fills.
      try { await storage.save(planningGoalKey(draft), { offered: true }); if (text) { await clear(); setLeftover('') } }
      catch { setNotice('目标已填入规划会话的输入框，但本地记录未能保存；补充内容仍保留在团队目标中，再次打开不会覆盖输入框里的内容。') }
    } else if (result !== 'opened') setNotice(result === 'preserved' ? '规划会话的输入框已有未发送内容，没有覆盖；目标与补充仍保留在这里。' : '规划会话已打开，但输入框暂不可用；补充内容仍保留在这里。')
  }
  // Every step re-checks the view's lifetime: once it is closed, a late receipt opens and fills nothing.
  const handoff = async (receipt, text, clear, signal) => {
    signal.throwIfAborted()
    setBinding({ state: 'ready', value: receipt })
    const offered = await storage.read(planningGoalKey(draft)).then(row => row?.offered === true).catch(() => true)
    signal.throwIfAborted()
    const prompt = [offered ? '' : draft.interview.purpose, text].filter(Boolean).join('\n\n')
    // Orbit hosts the real Session in place; without an embedding host, fall back to session mode.
    if (host?.renderSession) setEmbedded({ sessionId: receipt.session_id, prompt, onOffered: async result => { setEmbedded(value => value && { ...value, prompt: '' }); await settle(result, text, clear) } })
    else await settle(await openPlanningSession(host, receipt.session_id, prompt, signal), text, clear)
  }
  const openInSessionMode = async () => {
    const sessionId = embedded?.sessionId
    if (!sessionId) return
    // Unmount (and release) the embedded composer first: one writer per Session.
    setEmbedded(null)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    try { await openPlanningSession(host, sessionId, '') } catch { setNotice('无法在会话模式打开，请刷新会话列表后重试。') }
  }
  // A confirmed handoff receipt opens only its successor, in place, and only while this view still shows
  // the source it was issued for. No text is offered to it; the Builder binding is re-read from the server.
  const successor = async (receipt, signal) => {
    signal.throwIfAborted(); if (!lifetime.current || lifetime.current.signal.aborted) return
    if (shown.current?.sessionId !== receipt.source_session_id) return
    setBinding({ state: 'ready', value: receipt })
    if (host?.renderSession) setEmbedded({ sessionId: receipt.session_id, prompt: '', onOffered: async () => {} })
    else await openPlanningSession(host, receipt.session_id, '', signal)
    reload()
  }
  if (embedded) return h('div', { className: 'kode-builder-native-session-frame' },
    h('div', { className: 'kode-builder-session-bar' },
      h('span', null, '规划会话 · ', bindingPlace(binding.value)),
      h(Button, { variant: 'text', onClick: () => setEmbedded(null) }, '团队目标'),
      h(Button, { variant: 'text', onClick: onWorkspace }, '团队工作区'),
      binding.value && h(PlanningContextRefresh, { key: `refresh:${binding.value.session_id}`, draft, binding: binding.value, storage, controls, onReady: successor }),
      h(Button, { variant: 'text', onClick: onReview }, '审核方案候选'),
      h(Button, { variant: 'text', onClick: () => void openInSessionMode() }, '在会话模式打开'),
      h(PlanningHandoffEntry, { key: `handoff:${embedded.sessionId}`, host, draft, sessionId: embedded.sessionId, storage, controls, onReady: successor })),
    notice && h('p', { className: 'kode-builder-event', role: 'status' }, notice),
    h(PlanningSessionEmbed, { host, sessionId: embedded.sessionId, text: embedded.prompt, onOffered: embedded.onOffered }))
  const clearLeftover = () => storage.save(planningTextKey(draft), { content: '' })
  // Asking for the state again is the user's next action, so the previous failure notice ends with it.
  const requery = () => { setNotice(''); reload() }
  const run = async operation => {
    // The ref closes the gap before `busy` re-renders: a double click never sends twice.
    if (busy || inFlight.current) return
    inFlight.current = true; setBusy(true); setNotice('')
    const signal = lifetime.current.signal
    try { await operation(signal) }
    catch (error) {
      if (signal.aborted) return
      setNotice(`${planningError(error)} ${planningDiagnostic(error)}`)
      // Server truth decides the next step after any failure, including timeouts and
      // mismatched receipts: an uncertain record offers its own original request.
      reload()
    } finally { inFlight.current = false; if (!signal.aborted) setBusy(false) }
  }
  const start = ({ text, clear }) => run(async signal => {
    const receipt = await startPlanning({ storage, draft, choice: planning.choice, workspaceId: workspace?.workspace_id, signal })
    await handoff(receipt, text, clear, signal)
  })
  // GET ready is only navigation metadata; confirm with the minimal request before opening.
  const reopen = () => run(async signal => handoff(await confirmPlanning({ draft, signal }), leftover, clearLeftover, signal))
  const recover = () => run(async signal => handoff(await retryPlanning({ draft, retry: binding.retry, signal }), leftover, clearLeftover, signal))
  // Owner-confirmed: finish the original Session's initialization. One exact request per confirmation, never repeated automatically.
  const complete = () => { setCompleting(false); return run(async signal => handoff(await completePlanning({ draft, binding: binding.value, retry: binding.retry, signal }), leftover, clearLeftover, signal)) }
  // An unconfirmed start of an older revision: only that original is resent, never a new command.
  const earlier = pending?.command && pending.draft_revision !== draft.revision ? pending : null
  const verify = () => run(async signal => handoff(await verifyPlanning({ storage, draft, signal }), leftover, clearLeftover, signal))
  const place = bindingPlace
  return h(React.Fragment, null,
    h('div', { className: 'kode-builder-messages', 'aria-label': '团队规划' },
      h(GoalMessage, { purpose: draft.interview.purpose }),
      binding.state === 'loading' && h('p', { className: 'kode-builder-event', role: 'status' }, '正在核对规划会话…'),
      binding.state === 'error' && h('p', { className: 'kode-builder-event', role: 'status', 'data-planning-state': 'read_failed' }, binding.message, ' ', h(IconButton, { icon: 'refresh', label: '重新读取状态', onClick: requery })),
      binding.state === 'not_created' && h('p', { className: 'kode-builder-event' }, '开始后会打开一个原生规划会话，目标放进它的输入框，由你确认发送。不会创建团队、预算或执行授权。'),
      binding.state === 'ready' && h('div', { className: 'kode-builder-session-link', 'data-planning-state': 'ready' },
        h(Icon, { name: 'chat', size: 16 }),
        h('div', null, h('strong', null, binding.value.disposition === 'fresh' ? '规划会话已创建' : '已有规划会话'),
          h('span', null, place(binding.value), leftover ? ' · 有未交给会话的补充' : '')),
        h(Button, { variant: 'text', onClick: onWorkspace }, '团队工作区'),
        h(PlanningContextRefresh, { key: `refresh:${binding.value.session_id}`, draft, binding: binding.value, storage, controls, onReady: successor }),
        h(Button, { variant: 'text', onClick: onReview }, '审核方案候选'),
        h(Button, { variant: 'primary', disabled: busy, onClick: () => void reopen() }, leftover ? '打开并填入补充' : '打开规划会话')),
      binding.state === 'uncertain' && h('div', { className: 'kode-builder-session-link', 'data-planning-state': 'uncertain' },
        h(Icon, { name: 'clock', size: 16 }),
        h('div', null, h('strong', null, '上次开始规划时没有收到确认'),
          h('span', null, binding.retry
            ? place(binding.value) + ' · 可能已创建，也可能没有。恢复会原样重发上次的请求（同一 Agent、模型和规划位置），服务只核对这次请求留下的原会话：核实后打开它；证据不足时仍保持未确认，不会新建替代会话。'
            : '服务记录了这次未确认的创建，但没有提供可重发的原请求。为避免重复创建，这里不会新建会话；重新查询只读取最新状态。')),
        binding.retry ? h(React.Fragment, null, h(Button, { variant: 'primary', disabled: busy, onClick: () => void recover() }, '恢复上次请求'),
          h(Button, { variant: 'outline', disabled: busy, onClick: () => setCompleting(true) }, '完成原会话初始化'))
          : h(Button, { variant: 'text', disabled: busy, onClick: requery }, '重新查询状态')),
      binding.state === 'uncertain' && binding.retry && h(Modal, { open: completing, title: '完成原会话初始化', closeLabel: '关闭', onClose: () => { if (!busy) setCompleting(false) },
        footer: h(React.Fragment, null, h(Button, { disabled: busy, onClick: () => setCompleting(false) }, '取消'),
          h(Button, { variant: 'primary', disabled: busy, onClick: () => void complete() }, '确认完成初始化')) },
        h('p', null, `服务保留了原规划会话 ID ${binding.value.session_id}。确认后会把上次的开始请求原样再发一次，并注明只补完初始化：服务会核查证据，仅在符合条件时补完这个原会话的初始化。`),
        h('p', null, '只可能补完这个原会话（同一 ID、同一 Agent、模型和规划位置）。不会向模型发送任何消息，不会新建替代会话，也不会创建团队、预算或执行授权。'),
        h('p', null, '如果仍未得到确认，原请求会继续保留，可以再次核对；不会自动重试。')),
      binding.state === 'not_created' && earlier && h('div', { className: 'kode-builder-session-link', 'data-planning-state': 'earlier_unconfirmed' },
        h(Icon, { name: 'clock', size: 16 }),
        h('div', null, h('strong', null, `草案第 ${earlier.draft_revision} 版的开始请求没有收到确认`),
          h('span', null, `草案现在是第 ${draft.revision} 版，但这不代表原请求没有创建会话。为避免重复创建，先核对原请求：会原样重发它（同一 Agent、模型和规划位置），已创建就打开原会话；服务明确拒绝后才能按新版本开始。`)),
        h(Button, { variant: 'primary', disabled: busy, onClick: () => void verify() }, '核对原请求')),
      notice && h('p', { className: 'kode-builder-event', role: 'status' }, notice)),
    binding.state === 'not_created' && draft.status === 'draft' && h(BuilderPrestartComposer, { key: 'prestart:' + draft.id, draft, storage, controls, planning, busy,
      blockedReason: pending === undefined ? '正在核对上次请求' : pending?.unreadable ? '无法读取上次开始请求，为避免重复创建暂不能开始。'
        : earlier ? `请先核对草案第 ${earlier.draft_revision} 版未确认的开始请求，之后才能开始新的规划对话。` : blockedReason,
      pendingReason: pending?.command && !earlier ? '上次开始规划时没有收到服务确认（可能是网络中断）。恢复会原样重发上次的请求（同一 Agent、模型和规划位置），不会重复创建会话。' : undefined, onStart: start }),
    binding.state === 'not_created' && draft.status === 'draft' && !pending?.command && workspaceChoice !== undefined && h('div', { className: 'kode-builder-composer-note kode-builder-location-note', 'data-planning-location': workspace ? 'workspace' : blockedReason ? 'blocked' : 'private' },
      h('span', null, blockedReason || (workspace ? `规划会话会在工作区「${workspaceName(workspace)}」中打开，Agent 可以读取其中的文件。` : '规划会话在 Kode 的私有空目录中打开，不使用你的主目录，也不读取项目文件。需要让 Agent 查看现有项目时再添加工作区。')),
      h(Button, { variant: 'text', onClick: onWorkspace }, workspace || blockedReason ? '更改规划位置' : '添加工作区')),
    (planning.error || planning.modelError) && binding.state === 'not_created' && h('p', { className: 'kode-builder-composer-note', role: 'status' }, planning.error || planning.modelError))
}

export function BuilderView({ request, storage, onTeamSaved, initialTeam = null, onScope, appearance, TabList }) {
  const controls = useBuilderControls(), host = React.useContext(PlanningHostContext), sidebar = React.useContext(TeamSidebarContext)
  const [filterTeam, setFilterTeam] = React.useState(initialTeam)
  React.useEffect(() => { setFilterTeam(initialTeam); setPanel(value => value === 'team-defaults' ? 'conversation' : value) }, [initialTeam?.id, initialTeam?.home_hub])
  const [list, setList] = React.useState({ items: [], next: null, home: null }), [draft, setDraft] = React.useState(null)
  const [panel, setPanel] = React.useState('conversation'), [detailsTab, setDetailsTab] = React.useState('answers')
  const [viewTab, setViewTab] = React.useState('conversation'), [proposalRequest, setProposalRequest] = React.useState(null)
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const active = React.useRef(null)
  const newPlanning = usePlanningChoice({ controls, storage, home: list.home ?? '', draftId: null })
  React.useEffect(() => { setPanel('conversation'); setViewTab('conversation'); setProposalRequest(null) }, [draft?.id])
  React.useEffect(() => {
    const select = event => { if (['conversation','proposal','settings'].includes(event.detail)) { setPanel('conversation'); setViewTab(event.detail) } }
    const proposal = event => { const detail=event.detail;if(!detail?.proposal||detail.proposal.format!=='kode.team-proposal.v1')return;if(draft&&(detail.proposal.draft_id&&detail.proposal.draft_id!==draft.id||detail.proposal.home_hub&&detail.proposal.home_hub!==draft.home_hub))return;setProposalRequest({...detail,nonce:Date.now()});setPanel('conversation');setViewTab('proposal') }
    window.addEventListener('kode-builder-tab',select);window.addEventListener('kode-builder-proposal',proposal)
    return()=>{window.removeEventListener('kode-builder-tab',select);window.removeEventListener('kode-builder-proposal',proposal)}
  },[draft?.id,draft?.home_hub])
  // The right Sidebar scope is what this view really shows: the selected draft, else the related team, else Builder itself.
  React.useLayoutEffect(() => { onScope?.({ team: filterTeam, draft, home: list.home }) }, [filterTeam?.id, filterTeam?.home_hub, draft?.id, draft?.home_hub, list.home])
  // The settings tab renders this draft's design settings with the same state and callbacks as this view.
  React.useLayoutEffect(() => sidebar?.publishBuilder?.(draft ? { draft, storage, request, onTeamSaved, onDraftSaved: setDraft, onRefresh: () => void read(draft.id), tab: detailsTab, onTab: setDetailsTab } : null))
  React.useLayoutEffect(() => () => onScope?.(undefined), [])
  const read = async (id, more = false, expectedHome = null) => {
    active.current?.abort(); const controller = new AbortController(); active.current = controller
    setBusy(true); setError('')
    try {
      const value = await request(id ? `/api/kode/builder/drafts?draft_id=${encodeURIComponent(id)}` : `/api/kode/builder/drafts?after=${encodeURIComponent(more ? list.next : '')}&limit=25${filterTeam ? '&team_id=' + encodeURIComponent(filterTeam.id) : ''}`, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (id) {
        if (value.id !== id || value.home_hub !== (expectedHome ?? list.home) || !value.interview || !Array.isArray(value.interview.questions)) throw Error('Invalid draft')
        setDraft(value)
      } else {
        if (!Array.isArray(value.items) || value.items.length > 25 || typeof value.home_hub !== 'string' || (filterTeam && value.home_hub !== filterTeam.home_hub) || (list.home && value.home_hub !== list.home)) throw Error('Invalid directory')
        let cursor = more ? list.next : ''
        for (const row of value.items) { if (typeof row.id !== 'string' || row.id <= cursor || !Number.isSafeInteger(row.revision)) throw Error('Invalid draft identity'); cursor = row.id }
        if (value.next_cursor !== null && (!value.items.length || value.next_cursor !== cursor)) throw Error('Invalid draft cursor')
        setList(previous => ({ items: more ? [...previous.items, ...value.items] : value.items, next: value.next_cursor, home: value.home_hub }))
        if (!more && !draft && value.items.length) { const latest=value.items.at(-1);queueMicrotask(()=>{if(!controller.signal.aborted)void read(latest.id,false,value.home_hub)}) }
      }
    } catch { if (!controller.signal.aborted) setError('暂时无法读取团队草案，请重试。') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  React.useEffect(() => { setDraft(null); setList(previous => ({ ...previous, items: [], next: null })); void read(null); return () => active.current?.abort() }, [filterTeam?.id, filterTeam?.home_hub])
  const selectDraft = value => { setDraft(value); setList(previous => ({ ...previous, items: [...previous.items.filter(row => row.id !== value.id), { id: value.id, revision: value.revision, purpose: value.interview.purpose, status: value.status, optimization_target: value.optimization_target }] })) }
  const created = async value => {
    // Carry the Agent/model chosen before the draft existed; a failed copy falls back to native defaults.
    try { await storage.save(planningChoiceKey(value.home_hub, value.id), newPlanning.choice) } catch {}
    selectDraft(value)
  }
  const page = (title, body) => h('div', { className: 'kode-settings-main kode-builder-page' },
    h('div', { className: 'kode-settings-page kode-builder-page-content' }, h('header', { className: 'kode-builder-page-heading' }, h(Button, { variant: 'text', onClick: () => {setPanel('conversation');setViewTab('conversation')} }, '返回对话'), h('h2', null, title)), body))
  return h('section', { className: 'kode-collab-builder kode-builder-conversation-layout', 'aria-label': 'Team Builder', 'data-builder-panel': panel },
    h('style', null, builderConversationStyles),
    h('header', { className: 'kode-builder-topbar' + (TabList ? ' kode-builder-topbar-with-tabs' : '') },
      h('h1', { className: 'kode-builder-title', title: draft?.interview.purpose }, draft ? builderDraftTitle(draft.interview.purpose) : 'Team Builder'),
      h('div', { className: 'kode-builder-header-actions' },
        h(IconButton, { icon: 'settings', label: draft ? '团队设计设置' : filterTeam ? 'SuperAgent 设置' : 'Team Builder 设置', 'aria-pressed': viewTab==='settings' ? true : undefined,
          onClick: () => { setPanel('conversation');setViewTab('settings') } }))),
    TabList && h('div',{className:'kode-builder-view-tabs'},h(TabList,{tabs:[{id:'conversation',label:'对话'},{id:'proposal',label:'团队方案'},{id:'settings',label:'设置'}],value:viewTab,onSelect:value=>{setPanel('conversation');setViewTab(value)}})),
    filterTeam && h('div', { className: 'kode-builder-filter-bar' }, h('span', null, '关联团队：', filterTeam.spec?.name || filterTeam.id), h(Button, { variant: 'text', onClick: () => { setFilterTeam(null); setPanel('conversation') } }, '查看全部'),
      h(BuilderOptimizationForm, { key: JSON.stringify([filterTeam.home_hub, filterTeam.id]), team: initialTeam?.id === filterTeam.id ? initialTeam : filterTeam, storage, onCreated: selectDraft })),
    error && h('p', { role: 'status', className: 'kode-builder-inline-error' }, error, ' ', h(IconButton, { icon: 'refresh', label: '重新读取草案', onClick: () => void read(draft?.id ?? null) })),
    h('div', { className: 'kode-builder-thread', hidden: panel !== 'conversation' || viewTab !== 'conversation' },
      !draft ? h(React.Fragment, null,
        h('div', { className: 'kode-builder-welcome' }, h('h2', null, '想让团队完成什么？'), h('p', null, '先写下目标并保存。之后在原生会话里和 Agent 一起规划成员与分工。')),
        list.home && h(BuilderCreateForm, { home: list.home, storage, controls, planning: newPlanning, onCreated: value => void created(value) }))
        : h(PlanningThread, { key: draft.id, draft, storage, controls, host, visible: panel === 'conversation' && viewTab === 'conversation', onWorkspace: () => setPanel('workspace'), onReview: () => { setDetailsTab('proposal'); setViewTab('proposal') } })),
    draft && viewTab==='proposal' && page('团队方案',h(BuilderProposalView,{key:'main-proposal:'+draft.id,draft,storage,onTeamSaved,onDraftSaved:setDraft,onRefresh:()=>void read(draft.id),externalRequest:proposalRequest})),
    !draft && viewTab==='proposal' && page('团队方案',h('p',{className:'kode-config-note'},'保存目标并完成规划后，团队方案会显示在这里。')),
    viewTab==='settings' && page('设置',draft?h(BuilderDraftSettings,{draft,storage,request,onTeamSaved,onDraftSaved:setDraft,onRefresh:()=>void read(draft.id),tab:detailsTab==='proposal'?'answers':detailsTab,onTab:setDetailsTab,showProposal:false}):filterTeam?h(HubTeamAgentDefaults,{controls,request,team:filterTeam}):h(BuilderHomeSettings,{controls,planning:newPlanning,appearance})),
    filterTeam && panel === 'team-defaults' && page(`${filterTeam.spec?.name || filterTeam.id} · 默认 Agent 与模型`,
      h(HubTeamAgentDefaults, { key: JSON.stringify([filterTeam.home_hub, filterTeam.id]), controls, request, team: filterTeam })),
    draft && panel === 'workspace' && page('团队工作区与规划位置', h(React.Fragment, null,
      h(PlanningWorkspaceChoice, { draft, storage }),
      h(BuilderWorkspaceForm, { draft, storage, request, onSaved: value => { setDraft(value); setPanel('conversation') }, onRefresh: () => void read(draft.id) }))),
    !draft && !filterTeam && panel === 'details' && page('Team Builder 设置', h(BuilderHomeSettings, { controls, planning: newPlanning, appearance })),
    draft && !sidebar?.available && h('div', { className: 'kode-settings-main kode-builder-page', hidden: panel !== 'details' },
      h('div', { className: 'kode-settings-page kode-builder-page-content' }, h('header', { className: 'kode-builder-page-heading' }, h(Button, { variant: 'text', onClick: () => {setPanel('conversation');setViewTab('conversation')} }, '返回对话'), h('h2', null, '团队设计设置')),
      h(BuilderDraftSettings, { draft, storage, request, onTeamSaved, onDraftSaved: setDraft, onRefresh: () => void read(draft.id), tab: detailsTab, onTab: setDetailsTab }))))
}

/** Team Builder's own settings before a draft exists: the Agent and model new planning starts
 * with, how planning Sessions look (the Kode session-mode appearance of that Agent, unchanged)
 * and the local planning instruction. Nothing here starts a model or changes a started Session. */
export function BuilderHomeSettings({ controls, planning, appearance }) {
  const profile = planning.pickerData?.currentProfile
  return h(React.Fragment, null,
    h('div', { className: 'kode-settings-group', 'aria-label': '规划 Agent 与模型' },
      h('h3', { className: 'kode-settings-group-title' }, '规划 Agent 与模型'),
      h('div', { className: 'kode-settings-card' },
      h('div', { className: 'kode-integration-row kode-team-role-row' },
        h('span', null, h('strong', null, '新规划使用'), h('span', { className: 'kode-config-note' }, planning.error || planning.storageError || '保存目标后，规划会话用这里的 Agent 与模型在原生会话中打开。只保存在这台电脑；已开始的规划不会改变。Agent 与模型的列表来自 Kode 设置 · Agent。')),
        h('span', { className: 'kode-team-role-pickers' }, h(PlanningAgentPicker, { controls, planning }), h(PlanningModelPicker, { controls, planning }))),
      appearance?.Avatar && profile && h('div', { className: 'kode-integration-row kode-builder-appearance', 'data-builder-appearance': profile.id },
        h('span', { className: 'kode-builder-appearance-avatar', 'aria-hidden': true }, h(appearance.Avatar, { profile, host: 'local', size: 40, status: 'idle' })),
        h('span', null, h('strong', null, '头像与背景'),
          h('span', { className: 'kode-config-note' }, `规划会话和会话模式一样，显示 ${profile.name} 的头像与配套背景；在规划会话里可以只为这一个会话更换。这里修改的是 ${profile.name} 的默认外观，会用于它之后的所有会话。`)),
        h(Button, { variant: 'outline', onClick: () => window.dispatchEvent(new CustomEvent('kode-avatar-dialog', { detail: { profile, host: 'local' } })) }, '设置默认外观')))),
    h(BuilderPromptSettings, null))
}

/** A draft's design settings: needs confirmation, team proposal and advanced. Rendered in the
 * native right Sidebar's settings tab for the draft scope, or in place without that Sidebar. */
export function BuilderDraftSettings({ draft, storage, request, onTeamSaved, onDraftSaved, onRefresh, tab: wanted, onTab, showProposal = true }) {
  const [own, setOwn] = React.useState('answers')
  const tab = wanted ?? own, select = onTab ?? setOwn
  return h(React.Fragment, null,
    h('nav', { className: 'kode-builder-tabs', 'aria-label': '团队设计设置分区' }, ...[['answers', '需求确认'], ...(showProposal?[['proposal', '团队方案']]:[]), ['advanced', '高级']].map(([id, label]) => h('button', { type: 'button', key: id, 'aria-current': tab === id ? 'page' : undefined, onClick: () => select(id) }, label))),
    h('section', { className: 'kode-settings-section', hidden: tab !== 'answers' }, h('p', { className: 'kode-config-note' }, '系统整理的待确认信息，不是模型回复；聊天内容不会自动成为确认答案。'), h(BuilderAnswerForm, { key: 'answers:' + draft.id, draft, storage, onRefresh, onSaved: onDraftSaved })),
    showProposal && h('section', { className: 'kode-settings-section', hidden: tab !== 'proposal' }, h(BuilderProposalView, { key: 'proposal:' + draft.id, draft, storage, onTeamSaved, onDraftSaved, onRefresh })),
    h('section', { className: 'kode-settings-section', hidden: tab !== 'advanced' },
      h(BuilderTeamLinks, { value: draft }),
      draft.optimization_target && h('p', { role: 'status' }, '优化目标：', draft.optimization_target.team_id, ' · 版本 ', draft.optimization_target.team_revision, draft.optimization_target.status === 'stale' ? '。团队已更新，需要重新确认目标；不会自动改绑。' : '。不包含执行授权。'),
      h('details', null, h('summary', null, '自动执行的工作流与权限'), h(BuilderWorkflowView, { key: 'workflow:' + draft.id + ':' + draft.revision, draft, storage })),
      h('details', null, h('summary', null, '本机验证命令'), h(VerificationReviewForm, { host: draft.home_hub, storage })),
      h(BuilderLegacySession, { key: 'legacy:' + draft.id, draft, storage, request, onDraftUpdated: onDraftSaved })))
}

const planningWorkspaceKey = draft => JSON.stringify(['builder-planning-workspace', draft.home_hub, draft.id])
/** {} no choice yet · { private: true } · { workspace_id }. Reading never falls back silently. */
const readPlanningWorkspace = async (storage, draft) => {
  const row = await storage.read(planningWorkspaceKey(draft))
  return row?.private === true ? { private: true } : typeof row?.workspace_id === 'string' ? { workspace_id: row.workspace_id } : {}
}
const planningWorkspace = (refs, choice) => !choice || choice.unreadable || choice.private ? undefined
  : choice.workspace_id ? refs.find(row => row.workspace_id === choice.workspace_id) : refs.length === 1 ? refs[0] : undefined
const bindingPlace = value => value?.workspace_id ? workspaceName({ root_ref: value.cwd, workspace_id: value.workspace_id }) : '私有规划目录'

/** Where the planning Session opens. Only changes future starts; an existing Session is never rebound. */
function PlanningWorkspaceChoice({ draft, storage }) {
  const refs = draft.interview.workspace_refs ?? [], key = planningWorkspaceKey(draft)
  const [choice, setChoice] = React.useState(undefined), [error, setError] = React.useState('')
  React.useEffect(() => { readPlanningWorkspace(storage, draft).then(setChoice).catch(() => setError('无法读取之前选择的规划位置；重新选择会覆盖它。')) }, [key])
  if (!refs.length) return null
  const current = planningWorkspace(refs, choice)?.workspace_id ?? (choice ? 'private' : null)
  const save = row => { setChoice(row); setError(''); storage.save(key, row).catch(() => setError('选择未能保存到本机，规划位置没有改变。')) }
  return h('fieldset', { className: 'kode-builder-radio-group', 'aria-label': '规划会话位置' }, h('legend', null, '规划会话在哪里打开'),
    h('label', null, h('input', { type: 'radio', name: key, checked: current === 'private', onChange: () => save({ private: true }) }),
      '私有规划目录', h('span', { className: 'kode-config-note' }, 'Kode 专用的空目录，不读取项目文件')),
    ...refs.map(row => h('label', { key: row.workspace_id }, h('input', { type: 'radio', name: key, checked: current === row.workspace_id,
      onChange: () => save({ workspace_id: row.workspace_id }) }), workspaceName(row), h('span', { className: 'kode-config-note' }, row.root_ref))),
    h('p', { className: 'kode-config-note' }, '只影响之后开始的规划会话；已有会话不会改绑。'),
    error && h('p', { role: 'status' }, error))
}
