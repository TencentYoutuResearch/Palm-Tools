import React from 'react'
import {builderProfileEligible,builderProviderOptions,builderModelQuery,validBuilderModelScope} from './builder-resource-options.js'
import {useBuilderControls,builderPickerData} from './builder-controls.js'
const h=React.createElement
/** Read-only preselection. Saving a goal does not save resource authority or start a model. */
export function BuilderAgentPreview({home,request,value,onChange,disabled=false}){
 const controls=useBuilderControls()
 const [resources,setResources]=React.useState([]),[models,setModels]=React.useState([]),[error,setError]=React.useState('')
 React.useEffect(()=>{const abort=new AbortController();void(async()=>{let rows=[],after='';do{const page=await request('/api/kode/resource-coverage?limit=100&after='+encodeURIComponent(after),{signal:abort.signal});if(page.host!==home||!Array.isArray(page.items)||page.items.length>100||rows.length+page.items.length>2000)throw Error();let cursor=after;for(const row of page.items){if(row.host!==home||typeof row.cursor!=='string'||row.cursor<=cursor)throw Error();cursor=row.cursor}if(page.next_cursor!==null&&(!page.items.length||page.next_cursor!==cursor))throw Error();rows.push(...page.items);after=page.next_cursor}while(after!==null);if(!abort.signal.aborted)setResources(rows)})().catch(()=>{if(!abort.signal.aborted)setError('暂时无法读取可用 Agent，可先保存目标。')});return()=>abort.abort()},[home,request])
 const profile=resources.find(row=>row.profile_id===value.profile_id&&builderProfileEligible(row)),providers=builderProviderOptions(resources,profile)
 React.useEffect(()=>{const abort=new AbortController();setModels([]);const query=profile&&value.provider&&builderModelQuery(profile,value.provider);if(query)void request(query,{signal:abort.signal}).then(result=>{if(abort.signal.aborted)return;if(!validBuilderModelScope(result,profile,value.provider,home)||!Array.isArray(result.items))throw Error();setModels(result.items);setError('')}).catch(()=>{if(!abort.signal.aborted)setError('模型目录暂不可用，请稍后重选。')});return()=>abort.abort()},[profile,value.provider,home,request])
 const eligible=resources.filter(builderProfileEligible),data=builderPickerData(eligible,value,models)
 if(!controls)return h('p',{role:'status'},'原生 Agent 与模型控件正在加载…')
 return h('div',{className:'kode-builder-agent-bar'},h('span',{className:'kode-config-note',title:'仅选择当前建队对话的 Agent 和模型；团队成员的分工与模型在方案中分别确认。'},'建队对话'),
 h(controls.AgentPicker,{data,busy:disabled,onSelect:id=>{const p=eligible.find(row=>row.profile_id===id);onChange({profile_id:id,provider:p?.executor_type==='dsh'?'':p?.managed_provider_id||'',model:'',effort:null,workspace:null})}}),
 profile?.executor_type==='dsh'&&h(controls.SelectField,{label:'提供商',value:value.provider,disabled,options:providers.map(row=>({value:row.id,label:row.name})),onChange:provider=>onChange({...value,provider,model:'',effort:null})}),
 h(controls.ModelPicker,{data,busy:disabled,error,onSelect:patch=>onChange({...value,provider:patch.provider??value.provider,model:patch.model,effort:patch.reasoningEffort??null})}))
}
