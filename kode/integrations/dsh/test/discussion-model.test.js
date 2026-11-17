import test from 'node:test'
import assert from 'node:assert/strict'
import {discussionDeliveryLabel,discussionKey,createMessageDraft,draftKey,validateMessagePage,validateThreads,discussionContextCommand} from '../packages/collab/discussion-model.js'
const scope={home_hub:'home',host_id:'host',workspace_id:'w',root_ref:'/fixture'}
const storage=()=>{const m=new Map();return{getItem:k=>m.get(k),setItem:(k,v)=>m.set(k,v)}}
test('draft scope includes Home, Host, workspace, root, surface and thread',()=>{const k=draftKey(scope,'s','t');for(const field of Object.keys(scope))assert.notEqual(k,draftKey({...scope,[field]:'other'},'s','t'));assert.notEqual(k,draftKey(scope,'s','other'));assert.notEqual(k,draftKey(scope,'other','t'))})
test('uncertain send survives reload and uses exact request',()=>{const s=storage(),d=createMessageDraft(s,'key');d.edit('hello');const a=d.prepare({revision:1},'root');assert.deepEqual(createMessageDraft(s,'key').prepare({revision:2},'other'),a);assert.throws(()=>d.edit('changed'));assert.throws(()=>d.accept({surface_id:'s',input:a},{id:'id',surface_id:'wrong',content:'hello'}));assert.equal(d.accept({surface_id:'s',input:a},{id:'id',surface_id:'s',content:'hello'}),true);assert.equal(d.read().text,'')})
test('malformed storage never silently discards pending message',()=>{const s=storage();s.setItem('key','{');assert.throws(()=>createMessageDraft(s,'key').read())})
test('private discussion context commands are exact and never treat ordinary text as actions',()=>{
 assert.equal(discussionContextCommand('/clear'),'clear');assert.equal(discussionContextCommand(' /resume\n'),'resume')
 for(const text of ['/clear now','/unknown','hello /clear',''])assert.equal(discussionContextCommand(text),null)
})
test('page scope and thread identity validated before rendering',()=>{const surface={id:'s',scope,enabled:true},m={id:'root',surface_id:'s',scope,thread_id:'root'};const p={surface,items:[m]};assert.equal(validateMessagePage(p,scope,'s','root'),p);assert.throws(()=>validateMessagePage(p,{...scope,home_hub:'other'},'s'));assert.throws(()=>validateMessagePage(p,scope,'s','other'));assert.throws(()=>validateMessagePage({...p,surface:{...surface,enabled:false}},scope,'s'));assert.throws(()=>validateThreads({surface,items:[{thread_id:'wrong',root:m}]},scope,'s'))})

test('only explicitly selected discussion recipients enter durable request',()=>{const s=storage(),d=createMessageDraft(s,'selected');d.edit('discuss only');const mentions=[{team_id:'team',team_revision:2,worker_id:null}];const a=d.prepare({revision:1},null,mentions);assert.deepEqual(a.mentions,mentions);assert.deepEqual(createMessageDraft(s,'selected').prepare({revision:3},null,[]),a);const other=createMessageDraft(s,'ordinary');other.edit('ordinary');assert.deepEqual(other.prepare({revision:1},null).mentions,[])})

test('discussion labels separate queued, consumed and completion',async()=>{const {discussionDeliveryLabel:label}=await import('../packages/collab/discussion-model.js');assert.match(label({delivery_state:'pending_coordinator'}),/尚未确认接收/);assert.match(label({delivery_state:'queued_to_coordinator'}),/尚未确认接收/);assert.match(label({delivery_state:'consumed_by_coordinator'}),/不代表执行完成/);assert.match(label({delivery_state:'stored_only',delivery_reason:'recipient_required'}),/未指定收件团队/)})

test('oversized discussion context remains stored without claiming dispatch or truncation',async()=>{const {discussionDeliveryLabel:label}=await import('../packages/collab/discussion-model.js');assert.equal(label({delivery_state:'stored_only',delivery_reason:'thread_context_compaction_required'}),'已留档 · 上下文过长，暂未派发')})

test('thread summary counts are authoritative and actors bounded, never inferred from loaded replies',()=>{
 const surface={id:'s',scope,enabled:true},root={id:'root',thread_id:'root',surface_id:'s',scope};
 const item={thread_id:'root',root,reply_count:52,reply_actors:[{kind:'human',id:'owner'}]},page={surface,items:[item]};
 assert.equal(validateThreads(page,scope,'s'),page);
 for(const reply_count of [-1,1.5,'52',NaN])assert.throws(()=>validateThreads({...page,items:[{...item,reply_count}]},scope,'s'));
 assert.throws(()=>validateThreads({...page,items:[{...item,reply_actors:Array(4).fill({kind:'human',id:'owner'})}]},scope,'s'));
 assert.throws(()=>validateThreads({...page,items:[{...item,root:{...root,thread_id:'other'}}]},scope,'s'));
})

test('stored discussion without isolated context is never labelled delivered or running',()=>{
 assert.equal(discussionDeliveryLabel({delivery_state:'stored_only',delivery_reason:'isolated_context_required',context_readiness:{state:'not_ready',reason:'isolated_context_required',isolation:'unavailable',legacy_shared_session_reused:false}}),'消息已保存，独立对话上下文尚未就绪，尚未发送给 Superagent')
 assert.equal(discussionDeliveryLabel({delivery_state:'queued_to_coordinator'}),'已进入团队收件队列 · 尚未确认接收')
})

test('real interactive reply actor has no synthetic id; validates Team scope and displays role',async()=>{
 const {validDiscussionActor,discussionActorLabel,discussionActorTeam}=await import('../packages/collab/discussion-model.js')
 const actor={kind:'interactive_participant',participant_id:'worker:integration',session_id:'session-59b00000-0000-0000-0000-000000000000',target_id:'tc-hy4',team_id:'team'}
 const surface={id:'s',scope,enabled:true,team_ids:['team']},root={id:'root',thread_id:'root',surface_id:'s',scope}
 const page={surface,items:[{thread_id:'root',root,reply_count:1,reply_actors:[actor]}]}
 assert.equal(validateThreads(page,scope,'s'),page);assert.equal(Object.hasOwn(actor,'id'),false)
 const team={id:'team',home_hub:'home',spec:{name:'Kode',workers:[{id:'integration',role:'集成验证'}]}}
 assert.equal(discussionActorLabel(actor,surface,[team]),'Kode · 集成验证');assert.equal(discussionActorTeam(actor,surface,[team]),team)
 for(const change of [{team_id:'foreign'},{session_id:'invalid'},{participant_id:'unknown'},{kind:'unknown'},{id:'invented'}])assert.equal(validDiscussionActor({...actor,...change},surface),false)
 assert.equal(discussionActorTeam(actor,surface,[{...team,home_hub:'foreign'}]),undefined)
 assert.throws(()=>validateThreads({...page,items:[{...page.items[0],reply_actors:[{...actor,team_id:'foreign'}]}]},scope,'s'))
})
