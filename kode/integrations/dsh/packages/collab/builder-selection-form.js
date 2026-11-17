import React from 'react'
import {Button} from '@deepseek-ai/dsh-client-ui-primitives'
import { selectionKey, submitSelection, requestBuilderSelection } from './builder-selection.js'
import { builderProfileEligible, builderProviderOptions, builderModelQuery, validBuilderModelScope } from './builder-resource-options.js'
import {useBuilderControls,builderPickerData,runtimeSelection,runtimeLockReason} from './builder-controls.js'
const h = React.createElement
export function BuilderSelectionForm({ draft, storage, request, initialChoice = null, compact = false, onOpenWorkspace, onSaved }) {
  const controls=useBuilderControls()
  const [binding,setBinding]=React.useState(null)
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
      setBinding(saved.runtime_binding??null); setPending(original); setRecord(saved.record); setResources(rows)
      setSuggested(false)
      if (saved.runtime_binding) { setChoice(runtimeSelection(saved.runtime_binding,null)??{profile_id:'',provider:'',model:'',effort:null,workspace:null});setMessage(runtimeLockReason(saved.runtime_binding)) }
      else if (original || saved.record) setChoice(original?.command.selection ?? saved.record.selection)
      else if(initialChoice?.profile_id&&rows.some(row=>row.profile_id===initialChoice.profile_id&&builderProfileEligible(row))&&builderProviderOptions(rows,rows.find(row=>row.profile_id===initialChoice.profile_id)).some(row=>row.id===initialChoice.provider)){setChoice({...initialChoice,workspace:null});setMessage('已带入预选 Agent 和模型，请核对工作区后保存；尚未授权执行。')}
      else {
        try {
          const proposal = await request(`/api/kode/builder/default-selection?draft_id=${encodeURIComponent(draft.id)}&revision=${draft.revision}`, { signal: controller.signal })
          if (controller.signal.aborted) return
          if (proposal.home_hub !== draft.home_hub || proposal.draft_id !== draft.id || proposal.draft_revision !== draft.revision || proposal.eligible_for_execution !== false) throw Error('Wrong default proposal')
          if (proposal.state === 'proposed') {
            const selection = proposal.selection
            if (!selection || !rows.some(row => row.profile_id === selection.profile_id && builderProfileEligible(row)) || !builderProviderOptions(rows, rows.find(row => row.profile_id === selection.profile_id)).some(row => row.id === selection.provider)
              || !draft.interview.workspace_refs.some(row => JSON.stringify(row) === JSON.stringify(selection.workspace))) throw Error('Invalid default scope')
            setChoice(selection); setSuggested(true); setMessage('已填入默认或唯一可用资源。保存后继续核对预算和启动条件。')
          } else setMessage('默认资源尚不明确，请展开高级配置补充选择。')
        } catch { if (!controller.signal.aborted) setMessage('暂时无法建议默认资源，可以在高级配置中选择。') }
      }
      if (!controller.signal.aborted) setReady(true)
    })().catch(() => { if (!controller.signal.aborted) setMessage('无法读取助手配置，请重新打开草案后重试。') })
    return () => controller.abort()
  }, [draft.id, draft.home_hub, draft.revision])
  const selectedProfile = resources.find(row => row.profile_id === choice.profile_id && builderProfileEligible(row))
  const providers = builderProviderOptions(resources, selectedProfile)
  React.useEffect(() => {
    const controller = new AbortController(); setModels([])
    const query = choice.provider && builderModelQuery(selectedProfile, choice.provider)
    if (query) void request(query, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return
      if (!validBuilderModelScope(value, selectedProfile, choice.provider, draft.home_hub) || !Array.isArray(value.items)) throw Error('Wrong models')
      setModels(value.items)
    }).catch(() => { if (!controller.signal.aborted) setMessage('模型目录暂不可用，已有选择保留。') })
    return () => controller.abort()
  }, [choice.provider, draft.home_hub, selectedProfile])
  React.useEffect(() => {
    const controller = new AbortController(); setReasoning(null)
    const query = choice.provider && choice.model && builderModelQuery(selectedProfile, choice.provider, choice.model)
    if (query) void request(query, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return
      if (!validBuilderModelScope(value, selectedProfile, choice.provider, draft.home_hub) || value.item?.id !== choice.model) throw Error('Wrong model')
      setReasoning(value.item.reasoning)
    }).catch(() => { if (!controller.signal.aborted) setMessage('推理强度暂不可用，已有选择保留。') })
    return () => controller.abort()
  }, [choice.provider, choice.model, draft.home_hub, selectedProfile])
  const submit = async event => {
    event.preventDefault(); if (!ready || submitting.current || binding) return
    if (!pending && (!selectedProfile || !providers.some(row => row.id === choice.provider))) { setMessage('执行配置或模型路由不可用于 Team Builder，请重新选择。'); return }
    submitting.current = true; setBusy(true); setMessage('')
    let attempted=false
    try {
      const latest=await request(`/api/kode/builder/selection?draft_id=${encodeURIComponent(draft.id)}`,{signal:lifetime.current.signal})
      if(latest.home_hub!==draft.home_hub||latest.draft_id!==draft.id)throw Error('Wrong latest draft')
      if(latest.runtime_binding){setBinding(latest.runtime_binding);setChoice(runtimeSelection(latest.runtime_binding,null)??{profile_id:'',provider:'',model:'',effort:null,workspace:null});setMessage(runtimeLockReason(latest.runtime_binding));return}
      attempted=true
      const result = await submitSelection({ storage, draft, revision: record?.revision ?? 0, selection: choice, request: requestBuilderSelection, signal: lifetime.current.signal })
      if (!lifetime.current.signal.aborted) { setRecord(result); setChoice(result.selection); setPending(null); setMessage('助手资源选择已保存，尚未启动。'); onSaved?.(result) }
    } catch {
      if (!lifetime.current.signal.aborted) { setMessage(attempted?'保存结果尚未确认，请重试原选择。':'无法核对运行状态，本次未提交资源选择。'); try { setPending(await storage.read(selectionKey(draft))) } catch {} }
    } finally { submitting.current = false; if (!lifetime.current.signal.aborted) setBusy(false) }
  }
  const data=builderPickerData(resources.filter(builderProfileEligible),choice,models,reasoning),locked=runtimeLockReason(binding)
  if(binding&&choice.profile_id&&!data.currentProfile)data.currentProfile={id:choice.profile_id,name:choice.profile_id}
  return h('form', { className: 'kode-collab-composer kode-collab-selection-form'+(compact?' kode-builder-selection-compact':''), onSubmit: submit },
    h('h3', null, 'Team Builder 使用的资源'),
    h('p', null, '配置 Team Builder 使用的模型和工作区。团队 Worker 的分工将在团队方案中配置。'),
    h('details', { open: !suggested && !record }, h('summary', null, '高级资源配置'),
    controls ? h(React.Fragment,null,
      h(controls.AgentPicker,{data,busy:busy||!ready||!!pending,lockedReason:locked,onSelect:profile_id=>{const profile=resources.find(row=>row.profile_id===profile_id);setChoice({profile_id,provider:profile?.executor_type==='dsh'?'':profile?.managed_provider_id??'',model:'',effort:null,workspace:choice.workspace})}}),
      selectedProfile?.executor_type==='dsh'&&h(controls.SelectField,{label:'模型提供商',value:choice.provider,disabled:!!locked||!ready||busy||!!pending,options:providers.map(row=>({value:row.id,label:row.name})),onChange:provider=>setChoice({...choice,provider,model:'',effort:null})}),
      h(controls.ModelPicker,{data,busy:busy||!ready||!!pending,lockedReason:locked,onSelect:patch=>setChoice({...choice,provider:patch.provider??choice.provider,model:patch.model,effort:patch.reasoningEffort??null})}))
      : h('p',{role:'status'},'原生 Agent 与模型控件正在加载…'),
    locked&&h('p',{role:'status'},locked),
    !draft.interview.workspace_refs.some(row=>row.host_id===draft.home_hub)&&h('div',{className:'kode-collab-note'},h('p',{role:'status'},'先在工作区配置中选择并保存此草案的工作区。已登记目录不会自动授权给草案，无需重复添加项目。'),onOpenWorkspace&&h(Button,{type:'button',variant:'outline',disabled:busy,onClick:onOpenWorkspace},'打开工作区配置')),
    h('label', null, '助手工作区', h('select', { 'aria-label': '助手工作区', value: choice.workspace ? JSON.stringify(choice.workspace) : '', disabled: !!binding || !ready || busy || !!pending, onChange: event => setChoice(previous => ({ ...previous, workspace: event.target.value ? JSON.parse(event.target.value) : null })) }, h('option', { value: '' }, '请选择'), ...draft.interview.workspace_refs.filter(row => row.host_id === draft.home_hub).map(row => h('option', { key: row.workspace_id, value: JSON.stringify(row) }, row.root_ref)))),
    ),
    record && h('p', null, record.draft_revision === draft.revision ? '已关联当前草案。' : '草案已变更，请核对并重新保存资源选择。'),
    pending && h('p', null, '待确认原选择：', pending.command.selection.provider, ' / ', pending.command.selection.model),
    h('button', { type: 'submit', className: 'kode-collab-button', disabled: !!binding || !controls || !ready || busy || (!pending && (!selectedProfile || !providers.some(row => row.id === choice.provider) || !choice.model || !choice.workspace)) }, busy ? '正在保存…' : pending ? '重试原资源选择' : '保存助手资源'),
    message && h('p', { role: 'status' }, message))
}
