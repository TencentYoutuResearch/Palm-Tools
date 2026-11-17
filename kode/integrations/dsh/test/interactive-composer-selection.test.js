import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {interactiveTargets,interactiveSelection,interactiveTargetTier} from '../packages/collab/interactive-composer-selection.js'
import {createMessageDraft,discussionDeliveryLabel,draftKey} from '../packages/collab/discussion-model.js'
const scope={home_hub:'home',host_id:'host',workspace_id:'workspace',root_ref:'/example/project'}
const surface={id:'channel',enabled:true,team_ids:['team'],revision:3,audience_revision:7}
const team={id:'team',home_hub:'home',revision:2,spec:{execution_mode:'interactive_native',workspace_refs:[scope],coordinator_targets:['a','b'],execution_targets:[{id:'a',host_id:'host',executor_profile_id:'cb',model_id:'kimi'},{id:'b',host_id:'host',executor_profile_id:'tc',model_id:'hy4'},{id:'remote',host_id:'other'}],workers:[{id:'frontend',allowed_target_ids:['a']},{id:'review',allowed_target_ids:['a','b']}]}}
const storage=()=>{const m=new Map();return {getItem:k=>m.get(k),setItem:(k,v)=>m.set(k,v)}}
test('roles preserve many-to-many candidates but send requires one explicit local target',()=>{
 assert.deepEqual(interactiveTargets(team,null,scope).map(t=>t.id),['a','b'])
 assert.deepEqual(interactiveTargets(team,'frontend',scope).map(t=>t.id),['a'])
 assert.deepEqual(interactiveTargets(team,'review',scope).map(t=>t.id),['a','b'])
 for(const target of ['', 'b','remote'])assert.throws(()=>interactiveSelection(team,'frontend',target,scope,surface))
 assert.deepEqual(interactiveSelection(team,'review','b',scope,surface),{team_id:'team',team_revision:2,participant_id:'worker:review',target_id:'b',workspace_id:'workspace',audience_revision:7})
 assert.throws(()=>interactiveSelection(team,null,'a',{...scope,workspace_id:'foreign'},surface))
 assert.throws(()=>interactiveSelection(team,null,'a',scope,{...surface,audience_revision:undefined}))
 assert.deepEqual(interactiveTargets({...team,spec:{...team.spec,execution_mode:'managed'}},null,scope),[])
})
test('Reasonable/Lite labels only annotate matching authorized targets',()=>{
 const targets=interactiveTargets(team,null,scope),configuration={teamRoleTargets:{assignments:{superagent:[{profileId:'cb',model:'kimi'},{profileId:'tc',model:'hy4'}]}}}
 assert.deepEqual(targets.map(target=>interactiveTargetTier(target,configuration)),['Reasonable','Lite'])
 assert.equal(interactiveTargetTier(targets[0],{teamRoleTargets:{assignments:{superagent:[{profileId:'other',model:'kimi'}]}}}),'')
 const legacy={teamRolePreferences:{assignments:{superagent:{profileId:'cb',model:'kimi'},superagent_lite:{profileId:'tc',model:'hy4'}}}}
 assert.deepEqual(targets.map(target=>interactiveTargetTier(target,legacy)),['Reasonable','Lite'])
})
test('reload/retry freezes original command including recipient, audience and target',()=>{
 const s=storage(),d=createMessageDraft(s,'channel'),selection=interactiveSelection(team,null,'a',scope,surface)
 d.edit('Please discuss');const pending=d.prepare(surface,'thread',[{team_id:'team',team_revision:2,worker_id:null}],selection)
 selection.target_id='b'
 assert.equal(pending.interactive_selection.target_id,'a')
 assert.deepEqual(createMessageDraft(s,'channel').prepare({...surface,revision:99},'other',[],interactiveSelection(team,'review','b',scope,surface)),pending)
 assert.throws(()=>d.edit('Do something else'))
})
for(const state of ['not_ready','uncertain','published','stored_only'])test('stored '+state+' receipt clears pending without claiming a model result or allowing replay',()=>{
 const s=storage(),d=createMessageDraft(s,'dm');d.edit('private')
 const input=d.prepare(surface,null,[],interactiveSelection(team,'review','b',scope,surface))
 const receipt={id:'message',surface_id:'channel',content:'private',interactive_selection:{...input.interactive_selection},interactive_delivery:{state,automatic_replay_allowed:false}}
 assert.equal(d.accept({surface_id:'channel',input},receipt),true)
 const restored=createMessageDraft(s,'dm').read();assert.equal(restored.pending,null);assert.equal(restored.text,'');assert.equal(restored.last_delivery.interactive_delivery.state,state)
 assert.match(discussionDeliveryLabel(restored.last_delivery),/消息已保存/)
 if(state!=='published')assert.doesNotMatch(discussionDeliveryLabel(receipt),/回复已发布|已完成/)
})
test('mismatched target cannot clear a durable original send',()=>{
 const d=createMessageDraft(storage(),'key');d.edit('message');const input=d.prepare(surface,null,[],interactiveSelection(team,null,'a',scope,surface))
 assert.throws(()=>d.accept({surface_id:'channel',input},{id:'message',surface_id:'channel',content:'message',interactive_selection:{...input.interactive_selection,target_id:'b'}}));assert.ok(d.read().pending)
})
test('source keeps native Composer and separates new interactive acceptance from old activation effects',async()=>{
 const ui=await readFile(new URL('../packages/collab/discussion-ui.js',import.meta.url),'utf8')
 assert.match(ui,/h\(NativeComposer/);assert.match(ui,/tools:recipientPicker,trailing:modelPicker/);assert.doesNotMatch(ui,/aria-label':'CLI \/ 模型组合'|h\('select'/);assert.match(ui,/original=activeDraft.read\(\).pending/)
 const activation=await readFile(new URL('../packages/collab/team-activation-view.js',import.meta.url),'utf8')
 const wrapper=activation.slice(activation.indexOf('export function TeamActivationView'),activation.indexOf('function ManagedTeamActivationView'))
 assert.match(wrapper,/interactive_native/);assert.doesNotMatch(wrapper,/storage\.read|teamActivationRequest|useEffect/)
})

test('channel roots, replies and private messages never reuse another outbox command',()=>{
 const s=storage(),root=createMessageDraft(s,draftKey(scope,'channel')),reply=createMessageDraft(s,draftKey(scope,'channel','thread')),dm=createMessageDraft(s,draftKey(scope,'dm','thread'))
 root.edit('root');const command=root.prepare(surface,null,[],interactiveSelection(team,null,'a',scope,surface))
 reply.edit('reply');const replyCommand=reply.prepare(surface,'thread',[],interactiveSelection(team,'review','b',scope,surface))
 assert.notEqual(command.request_id,replyCommand.request_id);assert.equal(command.thread_id,undefined);assert.equal(replyCommand.thread_id,'thread');assert.equal(dm.read().pending,null)
 assert.equal(root.read().pending.interactive_selection.target_id,'a');assert.equal(reply.read().pending.interactive_selection.target_id,'b')
})
