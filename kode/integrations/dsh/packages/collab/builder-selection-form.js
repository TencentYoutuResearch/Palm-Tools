import React from 'react'
import { selectionKey, submitSelection, requestBuilderSelection } from './builder-selection.js'
const h = React.createElement
export function BuilderSelectionForm({ draft, storage, request }) {
  const [resources, setResources] = React.useState([]), [models, setModels] = React.useState([]), [reasoning, setReasoning] = React.useState(null)
  const [choice, setChoice] = React.useState({ profile_id: '', provider: '', model: '', effort: null, workspace: null })
  const [record, setRecord] = React.useState(null), [pending, setPending] = React.useState(null), [ready, setReady] = React.useState(false)
  const [suggested, setSuggested] = React.useState(false)
  const [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const lifetime = React.useRef(null), submitting = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller; setReady(false)
    void (async () => {
      const [saved, local] = await Promise.all([request(`/api/kode/builder/selection?draft_id=${encodeURIComponent(draft.id)}`, { signal: controller.signal }), storage.read(selectionKey(draft))])
      if (saved.home_hub !== draft.home_hub || saved.draft_id !== draft.id || saved.eligible_for_execution !== false) throw Error('Wrong draft')
      let rows = [], after = ''
      do {
        const page = await request(`/api/kode/resource-coverage?limit=100&after=${encodeURIComponent(after)}`, { signal: controller.signal })
        if (page.host !== draft.home_hub || !Array.isArray(page.items) || page.items.length > 100 || rows.length + page.items.length > 2000) throw Error('Invalid resources')
        let cursor = after
        for (const row of page.items) { if (row.host !== draft.home_hub || typeof row.cursor !== 'string' || row.cursor <= cursor) throw Error('Invalid cursor'); cursor = row.cursor }
        if (page.next_cursor !== null && (!page.items.length || page.next_cursor !== cursor)) throw Error('Invalid continuation')
        rows.push(...page.items); after = page.next_cursor
      } while (after !== null)
      if (controller.signal.aborted) return
      const original = local?.state !== 'accepted' ? local : null
      setPending(original); setRecord(saved.record); setResources(rows)
      setSuggested(false)
      if (original || saved.record) setChoice(original?.command.selection ?? saved.record.selection)
      else {
        try {
          const proposal = await request(`/api/kode/builder/default-selection?draft_id=${encodeURIComponent(draft.id)}&revision=${draft.revision}`, { signal: controller.signal })
          if (controller.signal.aborted) return
          if (proposal.home_hub !== draft.home_hub || proposal.draft_id !== draft.id || proposal.draft_revision !== draft.revision || proposal.eligible_for_execution !== false) throw Error('Wrong default proposal')
          if (proposal.state === 'proposed') {
            const selection = proposal.selection
            if (!selection || !rows.some(row => row.profile_id === selection.profile_id && row.executor_type === 'dsh' && row.runtime_available) || !rows.some(row => row.provider_id === selection.provider && row.route_registered)
              || !draft.interview.workspace_refs.some(row => JSON.stringify(row) === JSON.stringify(selection.workspace))) throw Error('Invalid default scope')
            setChoice(selection); setSuggested(true); setMessage('已填入默认或唯一可用资源。保存后继续核对预算和启动条件。')
          } else setMessage('默认资源尚不明确，请展开高级配置补充选择。')
        } catch { if (!controller.signal.aborted) setMessage('暂时无法建议默认资源，可以在高级配置中选择。') }
      }
      if (!controller.signal.aborted) setReady(true)
    })().catch(() => { if (!controller.signal.aborted) setMessage('无法读取助手配置，请重新打开草案后重试。') })
    return () => controller.abort()
  }, [draft.id, draft.home_hub, draft.revision])
  React.useEffect(() => {
    const controller = new AbortController(); setModels([])
    if (choice.provider) void request(`/api/kode/builder/models?provider=${encodeURIComponent(choice.provider)}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return
      if (value.home_hub !== draft.home_hub || value.provider !== choice.provider || !Array.isArray(value.items)) throw Error('Wrong models')
      setModels(value.items)
    }).catch(() => { if (!controller.signal.aborted) setMessage('模型目录暂不可用，已有选择保留。') })
    return () => controller.abort()
  }, [choice.provider, draft.home_hub])
  React.useEffect(() => {
    const controller = new AbortController(); setReasoning(null)
    if (choice.provider && choice.model) void request(`/api/kode/builder/models?provider=${encodeURIComponent(choice.provider)}&model=${encodeURIComponent(choice.model)}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return
      if (value.home_hub !== draft.home_hub || value.provider !== choice.provider || value.item?.id !== choice.model) throw Error('Wrong model')
      setReasoning(value.item.reasoning)
    }).catch(() => { if (!controller.signal.aborted) setMessage('推理强度暂不可用，已有选择保留。') })
    return () => controller.abort()
  }, [choice.provider, choice.model, draft.home_hub])
  const submit = async event => {
    event.preventDefault(); if (!ready || submitting.current) return
    submitting.current = true; setBusy(true); setMessage('')
    try {
      const result = await submitSelection({ storage, draft, revision: record?.revision ?? 0, selection: choice, request: requestBuilderSelection, signal: lifetime.current.signal })
      if (!lifetime.current.signal.aborted) { setRecord(result); setChoice(result.selection); setPending(null); setMessage('助手资源选择已保存，尚未启动。') }
    } catch {
      if (!lifetime.current.signal.aborted) { setMessage('保存结果尚未确认，请重试原选择。'); try { setPending(await storage.read(selectionKey(draft))) } catch {} }
    } finally { submitting.current = false; if (!lifetime.current.signal.aborted) setBusy(false) }
  }
  const select = (label, field, rows, change) => h('label', null, label, h('select', { 'aria-label': label, value: choice[field] ?? '', disabled: !ready || busy || !!pending, onChange: event => setChoice(previous => ({ ...previous, ...change(event.target.value) })) }, h('option', { value: '' }, '请选择'), ...rows.map(row => h('option', { key: row.id, value: row.id }, row.name))))
  return h('form', { className: 'kode-collab-composer kode-collab-selection-form', onSubmit: submit },
    h('h3', null, '创建助手使用的资源'),
    h('p', null, '配置创建助手使用的模型和工作区。团队 Worker 的分工将在团队方案中配置。'),
    h('details', { open: !suggested && !record }, h('summary', null, '高级资源配置'),
    select('执行配置', 'profile_id', resources.filter(row => row.resource_kind === 'execution_profile' && row.executor_type === 'dsh' && row.runtime_available).map(row => ({ id: row.profile_id, name: row.name })), profile_id => ({ profile_id })),
    select('模型提供商', 'provider', resources.filter(row => row.resource_kind === 'official_loop_provider' && row.route_registered).map(row => ({ id: row.provider_id, name: row.name })), provider => ({ provider, model: '', effort: null })),
    select('助手模型', 'model', models, model => ({ model, effort: null })),
    select('推理强度（可选）', 'effort', reasoning?.efforts ?? [], effort => ({ effort: effort || null })),
    h('label', null, '助手工作区', h('select', { 'aria-label': '助手工作区', value: choice.workspace ? JSON.stringify(choice.workspace) : '', disabled: !ready || busy || !!pending, onChange: event => setChoice(previous => ({ ...previous, workspace: event.target.value ? JSON.parse(event.target.value) : null })) }, h('option', { value: '' }, '请选择'), ...draft.interview.workspace_refs.filter(row => row.host_id === draft.home_hub).map(row => h('option', { key: row.workspace_id, value: JSON.stringify(row) }, row.root_ref)))),
    ),
    record && h('p', null, record.draft_revision === draft.revision ? '已关联当前草案。' : '草案已变更，请核对并重新保存资源选择。'),
    pending && h('p', null, '待确认原选择：', pending.command.selection.provider, ' / ', pending.command.selection.model),
    h('button', { type: 'submit', className: 'kode-collab-button', disabled: !ready || busy || (!pending && (!choice.profile_id || !choice.provider || !choice.model || !choice.workspace)) }, busy ? '正在保存…' : pending ? '重试原资源选择' : '保存助手资源'),
    message && h('p', { role: 'status' }, message))
}
