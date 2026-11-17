export const optimizationDraftKey=(home,team)=>JSON.stringify(['builder-optimization-create',home,team])
export async function createOptimizationDraft({storage,home,command,request,signal}) {
 if(typeof command.purpose!=='string'||!command.purpose.trim()||new TextEncoder().encode(command.purpose).length>8192||command.purpose.includes('\0'))throw Error('优化目标需为非空文字，最多 8192 字节。')
 const key=optimizationDraftKey(home,command.team_id)
 const row=await storage.reserve(key,{state:'prepared',home_hub:home,command},old=>old.state==='accepted')
 if(signal?.aborted)throw Error('Disposed')
 if(row.home_hub!==home||['team_id','team_revision','draft_id','request_id','purpose'].some(key=>row.command?.[key]!==command[key]))throw Error('Wrong optimization scope')
 const result=await request(row.command,{signal}),draft=result.draft,target=result.optimization_target??draft?.optimization_target
 if(draft?.id!==row.command.draft_id||draft.home_hub!==home||draft.request_id!==row.command.request_id||draft.interview?.purpose!==row.command.purpose||target?.team_id!==row.command.team_id||target.team_revision!==row.command.team_revision||target.source!=='owner_confirmed_optimization'||result.model_started!==false||result.activation_performed!==false||result.eligible_for_execution!==false)throw Error('Invalid optimization receipt')
 await storage.save(key,{...row,state:'accepted'})
 return {...draft,optimization_target:target}
}
export async function requestOptimizationDraft(command,{signal}={}) {
 const response=await fetch('/api/kode/builder/optimization-draft',{method:'POST',credentials:'same-origin',redirect:'error',signal,headers:{'content-type':'application/json'},body:JSON.stringify(command)})
 if(!response.ok)throw Error(response.status===409?'请求未确认，可能存在版本或请求冲突。请精确重试原请求，不会自动改绑。':'创建结果尚未确认，请重试原请求。')
 return response.json()
}
