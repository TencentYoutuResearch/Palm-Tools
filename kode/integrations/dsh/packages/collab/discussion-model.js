/** Full scope identity and exact-request persistence; no automatic model dispatch. */
export const discussionScope=s=>({home_hub:s.home_hub,host_id:s.host_id,workspace_id:s.workspace_id,root_ref:s.root_ref})
export const discussionKey=s=>JSON.stringify([s.home_hub,s.host_id,s.workspace_id,s.root_ref])
export const sameDiscussionScope=(a,b)=>!!a&&!!b&&discussionKey(a)===discussionKey(b)
export async function requestDiscussion(path,query={},body,{signal}={}){
 const search=new URLSearchParams({path,...query})
 const response=await fetch('/api/kode/collaboration?'+search,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin',redirect:'error',cache:'no-store',signal})
 const data=await response.json()
 if(!response.ok)throw Object.assign(new Error(response.status===404?'后端尚未接入讨论串，请更新后重试。':'操作未确认，请检查权限后重试原请求。'),{status:response.status,code:data?.code})
 return data
}
export function draftKey(scope,surface,thread){return 'kode.discussion.draft.v1:'+JSON.stringify([discussionKey(scope),surface,thread??'root'])}
export const discussionContextCommand=text=>({'/clear':'clear','/resume':'resume'})[String(text).trim()]??null
export function createMessageDraft(storage,key){
 const read=()=>{const raw=storage.getItem(key);return raw?JSON.parse(raw):{text:'',pending:null}}
 return {read,edit(text){const value=read();if(value.pending)throw Error('resolve pending send first');storage.setItem(key,JSON.stringify({...value,text}))},
 prepare(surface,thread,mentions=[],interactiveSelection=null){const value=read();if(value.pending)return value.pending;const content=value.text.trim();if(!content)throw Error('empty message');const pending={request_id:crypto.randomUUID(),expected_revision:surface.revision,content,mentions,...(interactiveSelection?{interactive_selection:structuredClone(interactiveSelection)}:{}),...(thread?{thread_id:thread}:{})};storage.setItem(key,JSON.stringify({...value,pending}));return pending},
 accept(pending,receipt){const value=read();if(!receipt?.id||receipt.surface_id!==pending.surface_id||receipt.content!==pending.input.content)throw Error('receipt mismatch');if(value.pending?.request_id!==pending.input.request_id)return false;if(pending.input.interactive_selection&&Object.keys(pending.input.interactive_selection).some(key=>receipt.interactive_selection?.[key]!==pending.input.interactive_selection[key]))throw Error('interactive selection mismatch');storage.setItem(key,JSON.stringify({text:'',pending:null,...(pending.input.interactive_selection?{last_delivery:receipt}: {})}));return true}}
}
export function validateMessagePage(page,scope,surface,thread){
 if(page?.surface?.id!==surface||!sameDiscussionScope(page.surface.scope,scope)||!page.surface.enabled||!Array.isArray(page.items))throw Error('scope mismatch')
 if(page.items.some(m=>m.actor?.kind==='interactive_participant'&&!validDiscussionActor(m.actor,page.surface)))throw Error('interactive actor scope mismatch')
 if(page.items.some(m=>m.surface_id!==surface||!sameDiscussionScope(m.scope,scope)||(thread&&m.thread_id!==thread)))throw Error('message scope mismatch')
 return page
}
export function validateThreads(page,scope,surface){
 if(page?.surface?.id!==surface||!sameDiscussionScope(page.surface.scope,scope)||!page.surface.enabled||!Array.isArray(page.items))throw Error('scope mismatch')
 for(const item of page.items){if(item.thread_id!==item.root?.id||item.root.thread_id!==item.thread_id||item.root.surface_id!==surface||!sameDiscussionScope(item.root.scope,scope))throw Error('thread scope mismatch');if(!Number.isSafeInteger(item.reply_count)||item.reply_count<0)throw Error('invalid reply count');if(item.reply_actors!==undefined&&(!Array.isArray(item.reply_actors)||item.reply_actors.length>3||item.reply_actors.some(actor=>!validDiscussionActor(actor,page.surface))))throw Error('invalid reply actors')}
 return page
}

export function discussionDeliveryLabel(message){
 if(message.interactive_delivery){const state=message.interactive_delivery.state;return ({published:'消息已保存 · 团队回复已发布，请查看本消息列',not_ready:'消息已保存 · 原生会话尚未就绪，未确认模型回复',uncertain:'消息已保存 · 模型回复结果待核对，不会自动重发',stored_only:'消息已保存 · 原请求不再自动派发，请查看本消息列'})[state]||'消息已保存 · 模型回复尚未确认'}
 if(message.kind==='superagent_reply')return '团队讨论回复 · 不代表执行完成'
 if(message.delivery_state==='queued_to_coordinator')return '已进入团队收件队列 · 尚未确认接收'
 if(message.delivery_state==='consumed_by_coordinator')return '团队已接收讨论 · 不代表执行完成'
 if(message.delivery_state==='pending_coordinator')return '已排队，等待团队回复 · 尚未确认接收'
 if(message.delivery_state==='stored_only'&&message.delivery_reason==='isolated_context_required')return '消息已保存，独立对话上下文尚未就绪，尚未发送给 Superagent'
 const reasons={thread_context_compaction_required:'已留档 · 上下文过长，暂未派发',recipient_required:'已留档 · 未指定收件团队',audience_publication_approval_required:'已留档 · 此受众范围需要另行授权',team_activation_required:'已留档 · 团队尚未激活',task_settled_or_cancelled:'已留档 · 需求已结束或取消'}
 return reasons[message.delivery_reason]||(message.delivery_state==='stored_only'?'已留档':'')
}

const actorToken=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v)
export function validDiscussionActor(actor,surface){
 if(!actor)return false
 if(actor.kind!=='interactive_participant')return ['human','superagent'].includes(actor.kind)&&actorToken(actor.id)
 return Object.keys(actor).sort().join(',')==='kind,participant_id,session_id,target_id,team_id'&&actorToken(actor.team_id)&&surface?.team_ids?.includes(actor.team_id)&&actorToken(actor.target_id)&&/^session-[a-f0-9-]{36}$/.test(actor.session_id)&&typeof actor.participant_id==='string'&&(actor.participant_id==='coordinator'||/^worker:[A-Za-z0-9_.:-]{1,160}$/.test(actor.participant_id))
}
export function discussionActorTeam(actor,surface,teams){
 if(actor?.kind==='interactive_participant')return validDiscussionActor(actor,surface)?teams.find(t=>t.home_hub===surface.scope.home_hub&&t.id===actor.team_id):undefined
 if(actor?.kind==='superagent')return teams.find(t=>t.home_hub===surface.scope.home_hub&&(t.id===actor.id||t.superagent_id===actor.id))
}
export function discussionActorLabel(actor,surface,teams){
 if(actor?.kind==='human')return '你'
 const team=discussionActorTeam(actor,surface,teams)
 if(actor?.kind==='interactive_participant'&&validDiscussionActor(actor,surface)){const worker=actor.participant_id.startsWith('worker:')?actor.participant_id.slice(7):null;return (team?.spec?.name||actor.team_id)+' · '+(worker?(team?.spec?.workers?.find(w=>w.id===worker)?.role||worker):'协调者')}
 return actor?.kind==='superagent'?(team?.spec?.name||'Superagent'):'任务记录'
}
