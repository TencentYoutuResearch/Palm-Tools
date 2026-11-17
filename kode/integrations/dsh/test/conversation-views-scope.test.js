import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversationViews, conversationViewKey } from '../packages/collab/conversation-views.js'
import { createCollabViewState } from '../packages/collab/view-state.js'
const a={home_hub:'home-a',id:'team',conversation_id:'shared-conversation'},b={...a,home_hub:'home-b'}
function memory(){const values=new Map();return{values,read:async key=>structuredClone(values.get(key)??null),update:async(key,change)=>{const next=change(structuredClone(values.get(key)??null));values.set(key,structuredClone(next));return structuredClone(next)}}}
function editor(storage){let drafts,serial=0;const view=createCollabViewState({onConversationChange:(scope,value)=>drafts.update(scope,value)});drafts=createConversationViews({storage,view,uuid:()=>`scope-${++serial}`});return{drafts,view}}
test('interleaved same-ID Homes open, edit, flush, close and reload without overwriting draft, scroll or follow-up',async()=>{
 const storage=memory(),e=editor(storage),original=storage.update;let release,pending
 storage.update=async(key,change)=>{if(key===conversationViewKey(a)&&!pending){pending=new Promise(resolve=>{release=resolve});await pending}return original(key,change)}
 await e.drafts.open(a);e.view.saveConversation(a,{draft:'A first',scrollTop:12,priorRunId:'run-a'})
 await e.drafts.open(b)
 assert.notEqual(conversationViewKey(a),conversationViewKey(b));assert.equal(e.drafts.getSnapshot()[a.conversation_id],undefined)
 e.view.saveConversation(b,{draft:'B final',scrollTop:98,priorRunId:'run-b'})
 await e.drafts.flush(b);e.view.saveConversation(a,{draft:'A final',scrollTop:45});release();await e.drafts.flush(a)
 assert.equal(e.view.conversation(a).draft,'A final');assert.equal(e.view.conversation(b).draft,'B final')
 assert.throws(()=>e.view.conversation(a.conversation_id),/Ambiguous/);assert.throws(()=>e.drafts.update(a.conversation_id,{draft:'wrong',scrollTop:0}),/多个作用域/)
 assert.equal(storage.values.get(conversationViewKey(a)).value.priorRunId,'run-a');assert.equal(storage.values.get(conversationViewKey(b)).value.priorRunId,'run-b')
 e.drafts.close();await assert.rejects(e.drafts.open(a),/关闭/)
 const restored=editor(storage);await Promise.all([restored.drafts.open(b),restored.drafts.open(a)])
 assert.deepEqual(restored.view.conversation(a),{draft:'A final',scrollTop:45,priorRunId:'run-a'})
 assert.deepEqual(restored.view.conversation(b),{draft:'B final',scrollTop:98,priorRunId:'run-b'})
 assert.equal(restored.drafts.getSnapshot()[conversationViewKey(a)].value.draft,'A final');assert.equal(restored.drafts.getSnapshot()[conversationViewKey(b)].value.draft,'B final')
 assert.equal(storage.values.size,2);restored.drafts.close()
})
test('same Home and conversation also retain independent team scope and do not acknowledge a foreign draft',async()=>{
 const storage=memory(),e=editor(storage),other={...a,id:'other-team'}
 await Promise.all([e.drafts.open(a),e.drafts.open(other)]);e.view.saveConversation(a,{draft:'first team'});e.view.saveConversation(other,{draft:'second team'})
 const first=await e.drafts.flush(a);await e.drafts.flush(other)
 assert.equal(await e.drafts.acknowledge(other,{state:'accepted',home_hub:a.home_hub,team_id:a.id,conversation_id:a.conversation_id,draft_token:first.draftToken}),false)
 assert.equal(e.view.conversation(other).draft,'second team');assert.notEqual(conversationViewKey(a),conversationViewKey(other));assert.equal(JSON.parse(conversationViewKey(a))[2],'local_owner')
 e.drafts.close()
})
test('legacy persistent drafts migrate only after their Home/team/conversation identity matches',async()=>{
 const storage=memory(),legacyKey=JSON.stringify(['conversation-view-v1',a.home_hub,'local_owner',a.conversation_id]),other={...a,id:'other-team'}
 const legacy={format:'kode.conversation.view.v1',state:'draft',home_hub:a.home_hub,team_id:a.id,conversation_id:a.conversation_id,request_id:'old-request',draft_token:'old-token',revision:4,value:{draft:'old local draft',scrollTop:27,priorRunId:null}}
 storage.values.set(legacyKey,legacy)
 const e=editor(storage);await e.drafts.open(other);assert.equal(e.view.conversation(other).draft,'');assert.equal(storage.values.has(conversationViewKey(other)),false)
 await e.drafts.open(a);assert.equal(e.view.conversation(a).draft,'old local draft');assert.equal(storage.values.get(conversationViewKey(a)).revision,1);assert.deepEqual(storage.values.get(legacyKey),legacy)
 e.drafts.close();const reload=editor(storage);await reload.drafts.open(a);assert.equal(reload.view.conversation(a).scrollTop,27);reload.drafts.close()
})
test('unique bare-ID API stays compatible while all callbacks carry the complete scoped key',async()=>{
 const storage=memory(),e=editor(storage);await e.drafts.open(a)
 e.view.saveConversation(a.conversation_id,{draft:'legacy caller'});await e.drafts.flush(a)
 assert.equal(e.view.conversation(a.conversation_id).draft,'legacy caller');assert.equal(e.drafts.getSnapshot()[a.conversation_id].value.draft,'legacy caller')
 e.drafts.update(conversationViewKey(a),{draft:'explicit scoped key',scrollTop:3,priorRunId:null});await e.drafts.flush(a);assert.equal(e.drafts.getSnapshot()[conversationViewKey(a)].value.draft,'explicit scoped key');assert.equal(storage.values.get(conversationViewKey(a)).value.draft,'explicit scoped key');e.drafts.close()
})
