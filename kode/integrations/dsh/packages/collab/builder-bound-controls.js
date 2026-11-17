import React from 'react'
import {useBuilderControls,builderPickerData,runtimeSelection,runtimeLockReason} from './builder-controls.js'
const h=React.createElement
/** Display only: running Builder has no model-change API. Never invoke ordinary session controls. */
export function BuilderBoundControls({draft,created,request}) {
 const controls=useBuilderControls(),[binding,setBinding]=React.useState(null),[error,setError]=React.useState('')
 React.useEffect(()=>{const abort=new AbortController();request(`/api/kode/builder/selection?draft_id=${encodeURIComponent(draft.id)}`,{signal:abort.signal}).then(row=>{if(abort.signal.aborted)return;if(row.home_hub!==draft.home_hub||row.draft_id!==draft.id)throw Error('Wrong binding');setBinding(row.runtime_binding??null)}).catch(()=>{if(!abort.signal.aborted)setError('无法重新核对运行绑定，保留已确认启动记录。')});return()=>abort.abort()},[draft.home_hub,draft.id,request])
 const receipt=created.request
 const conflict=binding?.state==='legacy_conflict'
 const choice=conflict?{profile_id:'',provider:'',model:''}:runtimeSelection(binding,null)??{profile_id:binding?.profile_id??'',provider:receipt.provider,model:receipt.model}
 const data=builderPickerData([],choice,[...(choice.model?[{id:choice.model,provider:choice.provider,name:choice.model}]:[])])
 data.currentProfile={id:choice.profile_id,name:conflict?'运行绑定冲突':choice.profile_id||'已绑定 Agent'}
 const reason=runtimeLockReason(binding)||'Agent 已由确认的启动记录锁定；此流程尚不支持运行中切换模型。'
 return controls?h('div',{className:'kode-builder-agent-bar'},h('span',{className:'kode-config-note',title:'仅选择当前建队对话的 Agent 和模型；团队成员的分工与模型在方案中分别确认。'},'建队对话'),h(controls.AgentPicker,{data,lockedReason:reason}),h(controls.ModelPicker,{data,lockedReason:reason}),h('span',{className:'kode-config-note',role:'status'},error||reason)):h('span',{role:'status'},'原生控件正在加载…')
}
