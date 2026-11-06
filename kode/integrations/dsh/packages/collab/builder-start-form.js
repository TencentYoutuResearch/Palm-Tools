import { BuilderConversationView } from './builder-conversation-view.js'
import { BuilderCloseForm } from './builder-close-form.js'
import React from 'react'
import { builderStartKey, confirmBuilderStart, requestBuilderStart, verifyBuilderCreation } from './builder-start-command.js'
const h = React.createElement
async function planRequest(input, signal) {
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 15000)
  try {
    const response = await fetch('/api/kode/builder/start-plan', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    if (!response.ok) throw Error('Plan unavailable')
    return await response.json()
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
export function BuilderStartForm({ draft, storage, request, onDraftUpdated }) {
  const [slot, setSlot] = React.useState(null), [plan, setPlan] = React.useState(null), [ready, setReady] = React.useState(false)
  const [amount, setAmount] = React.useState(''), [allowUnknown, setAllowUnknown] = React.useState(false)
  const [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const [closeState,setCloseState]=React.useState('checking')
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void storage.read(builderStartKey(draft)).then(value => {
      if (controller.signal.aborted) return
      if (value && (value.home_hub !== draft.home_hub || value.command?.start?.draft_id !== draft.id)) throw Error('Wrong saved startup')
      if (value?.state === 'created') verifyBuilderCreation(value.receipt, value.command, draft.home_hub)
      setSlot(value); setReady(true)
    }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取启动记录，请重新打开草案后重试。') })
    return () => controller.abort()
  }, [draft.id, draft.home_hub])
  const prepare = async event => {
    event.preventDefault(); if (running.current || !ready) return
    running.current = true; setBusy(true); setMessage('')
    try {
      const signal = active.current.signal
      if (!/^\d+$/.test(amount) || !Number.isSafeInteger(Number(amount)) || Number(amount) < 1) throw Error('Invalid amount')
      const selected = await request(`/api/kode/builder/selection?draft_id=${encodeURIComponent(draft.id)}`, { signal })
      if (selected.home_hub !== draft.home_hub || selected.draft_id !== draft.id || selected.record?.draft_revision !== draft.revision) throw Error('Selection unavailable')
      let after = '', resource, count = 0
      do {
        const page = await request(`/api/kode/resource-coverage?limit=100&after=${encodeURIComponent(after)}`, { signal })
        if (page.host !== draft.home_hub || !Array.isArray(page.items) || page.items.length > 100 || (count += page.items.length) > 2000) throw Error('Invalid resource directory')
        let cursor = after
        for (const row of page.items) { if (typeof row.cursor !== 'string' || row.cursor <= cursor) throw Error('Invalid cursor'); cursor = row.cursor }
        if (page.next_cursor !== null && (!page.items.length || page.next_cursor !== cursor)) throw Error('Invalid continuation')
        resource = page.items.find(row => row.resource_kind === 'execution_profile' && row.profile_id === selected.record.selection.profile_id)
        after = page.next_cursor
      } while (!resource && after !== null)
      if (!resource?.account?.current) throw Error('Account unavailable')
      const limit_ids = (resource.limits ?? []).map(row => row.limit_id)
      if (!limit_ids.length && !allowUnknown) throw Error('Quota source unavailable')
      const uuid = () => crypto.randomUUID()
      const input = { draft_id: draft.id, command_id: uuid(), request_id: uuid(), owner_session: uuid(), session_id: uuid(), team_id: uuid(), amount: Number(amount), limit_ids, unknown_quota: allowUnknown ? 'team_budget' : 'require_fresh' }
      const value = await planRequest(input, signal)
      if (signal.aborted) return
      if (value.state !== 'planned' || value.dispatch_authorized !== false || value.command?.command_id !== input.command_id || value.command.team_id !== input.team_id
        || value.command.start?.draft_id !== draft.id || value.command.start.draft_revision !== draft.revision || value.command.start.operation?.worker.node_id !== draft.home_hub
        || value.command.start.operation.worker.session_id !== input.session_id || value.command.start.operation.funding.amount !== input.amount
        || value.command.start.operation.resource.unknown_quota !== input.unknown_quota) throw Error('Wrong start plan')
      setPlan(value)
    } catch { if (!active.current.signal.aborted) setMessage('无法准备启动：请检查已保存的资源、创建预算、账户绑定和额度策略。') }
    finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const confirm = async () => {
    if (running.current || (!slot && !plan)) return
    running.current = true; setBusy(true); setMessage('')
    try {
      await confirmBuilderStart({ storage, draft, command: slot?.command ?? plan.command, request: requestBuilderStart, signal: active.current.signal })
      if (!active.current.signal.aborted) { setSlot(await storage.read(builderStartKey(draft))); setPlan(null) }
    } catch { if (!active.current.signal.aborted) { setMessage('启动结果尚未确认，重试将恢复原启动命令。'); try { setSlot(await storage.read(builderStartKey(draft))) } catch {} } }
    finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const command = slot?.command ?? plan?.command
  return h('section', { className: 'kode-collab-start-form' }, h('h3', null, '启动创建助手'),
    slot?.state === 'created' ? h('p', { role: 'status' }, '助手创建已确认。此记录不代表当前在线或已完成团队配置。') :
      command ? h('div', null,
        h('p', null, '模型：', command.provider, ' / ', command.start.operation.selection_policy.model),
        h('p', null, '预留团队预算：', command.start.operation.funding.amount, ' ', command.start.operation.funding.unit),
        h('p', null, command.start.operation.resource.unknown_quota === 'team_budget' ? '供应商额度未知时允许在团队预算约束下执行；已知耗尽时仍拒绝。' : '必须具备有效的供应商额度观测。'),
        h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void confirm() }, slot ? '恢复原启动请求' : '确认启动创建助手'),
        !slot && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setPlan(null) }, '返回修改启动配置')) :
      h('form', { className: 'kode-collab-composer', onSubmit: prepare },
        h('label', null, '本次预留预算', h('input', { 'aria-label': '本次预留预算', inputMode: 'numeric', required: true, disabled: !ready || busy, value: amount, onChange: event => setAmount(event.target.value) })),
        h('label', null, h('input', { type: 'checkbox', checked: allowUnknown, disabled: !ready || busy, onChange: event => setAllowUnknown(event.target.checked) }), '供应商额度无法确认时，允许使用团队预算约束'),
        h('button', { type: 'submit', className: 'kode-collab-button', disabled: !ready || busy }, '核对启动配置')),
    slot?.state === 'created' && h(BuilderCloseForm,{key:'close:'+slot.receipt.request.operation.id,draft,startup:slot,storage,onState:setCloseState}),
    slot?.state === 'created' && h(BuilderConversationView, { key: slot.receipt.request.operation.id, draft, created: slot.receipt, storage, request, onDraftUpdated,readOnly:closeState!=='open',closed:closeState==='closed' }),
    message && h('p', { role: 'status' }, message))
}
