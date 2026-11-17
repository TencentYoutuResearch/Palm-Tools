import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { prepareConfiguration, saveConfiguration } from '../packages/collab/team-configuration.js'
import { nativeConfigurationTarget, validateNativeCatalog, readNativeCatalog } from '../packages/collab/team-native-target.js'
const profile = { id:'native-cli', type:'codex', provider_id:'kode-agent-fixture', profile_revision:'a'.repeat(64) }
const catalog = { home_hub:'home',execution_mode:'interactive_native',eligible_for_execution:false,profiles:[profile],selected_profile:profile,models:[{id:'fixture-astra',reasoningEfforts:['high','xhigh']}] }
const team = {id:'team',home_hub:'home',revision:3,superagent_id:'super',conversation_id:'conversation',spec:{name:'Feature team',purpose:'Feature only',execution_mode:'interactive_native',workspace_refs:[{host_id:'home',workspace_id:'project',root_ref:'/example/project'}],execution_targets:[{id:'old',host_id:'home',executor_profile_id:'old-cli',executor_profile_revision:'b'.repeat(64),provider_id:'old-provider',model_id:'old-model',effort:null}],coordinator_targets:['old'],workers:[{id:'backend',role:'Backend',responsibilities:['Develop'],allowed_target_ids:['old'],max_parallel:1,required_capabilities:['code'],workspace_refs:[{host_id:'home',workspace_id:'project',root_ref:'/example/project'}]}],grant_id:'existing',budget_policy_id:null,scheduling_policy_id:'existing-policy',proactive_mode:'off'}}
const addition = {catalog,modelId:'fixture-astra',effort:'xhigh',id:'new'}
const edits = {name:'Kode development',purpose:'Develop and review Kode',additions:[addition],coordinator_targets:['old','new']}
test('versioned identity + verified native target edit preserves Team, roles, original targets, permissions and workspaces',()=>{
 const command=prepareConfiguration(team,[{...team.spec.workers[0],allowed_target_ids:['old','new']}],'request',undefined,edits)
 assert.equal(command.id,team.id);assert.equal(command.expected_revision,3);assert.equal(command.request_id,'request')
 assert.equal(command.spec.name,edits.name);assert.equal(command.spec.purpose,edits.purpose)
 assert.deepEqual(command.spec.execution_targets[0],team.spec.execution_targets[0])
 assert.deepEqual(command.spec.execution_targets[1],{id:'new',host_id:'home',executor_profile_id:profile.id,executor_profile_revision:profile.profile_revision,provider_id:profile.provider_id,model_id:'fixture-astra',effort:'xhigh'})
 for(const key of ['grant_id','budget_policy_id','scheduling_policy_id','proactive_mode','workspace_refs'])assert.deepEqual(command.spec[key],team.spec[key])
 assert.equal(command.spec.workers[0].id,'backend');assert.deepEqual(command.spec.workers[0].required_capabilities,['code']);assert.equal(team.spec.execution_targets.length,1)
})
test('catalogue is owner/home scoped, explicit, revision pinned and never accepts arbitrary model or effort',()=>{
 for(const change of [{home_hub:'other'},{execution_mode:'managed'},{eligible_for_execution:true},{selected_profile:{...profile,profile_revision:'c'.repeat(64)}},{selected_profile:{...profile,provider_id:'invented'}},{models:[{id:'m'},{id:'m'}]}]) assert.throws(()=>nativeConfigurationTarget(team,{...addition,catalog:{...catalog,...change}}))
 for(const change of [{modelId:'invented'},{effort:'invented'},{id:'../invalid'}])assert.throws(()=>nativeConfigurationTarget(team,{...addition,...change}))
 assert.throws(()=>validateNativeCatalog({...team,spec:{...team.spec,workspace_refs:[{host_id:'remote'}]}},catalog))
 assert.throws(()=>nativeConfigurationTarget({...team,spec:{...team.spec,execution_mode:undefined}},addition))
})
test('editing rejects duplicate target ids, empty identity, malformed mappings and changes outside editor scope',()=>{
 for(const change of [{name:' '},{purpose:''},{name:'界'.repeat(54)},{additions:[{...addition,id:'old'}]},{coordinator_targets:['unknown']},{coordinator_targets:['old','old']},{grant_id:'replacement'}])assert.throws(()=>prepareConfiguration(team,team.spec.workers,'r',undefined,{...edits,...change}))
 const noWorkers={...team,spec:{...team.spec,workers:[]}}
 assert.equal(prepareConfiguration(noWorkers,[],'r',undefined,{name:'Coordinator'}).spec.name,'Coordinator')
})
test('lost response reuses same versioned command and saved receipt without duplicate update',async()=>{
 let record,calls=0
 const command=prepareConfiguration(team,team.spec.workers,'request',undefined,edits)
 const storage={reserve:async(_key,value)=>record??=value,save:async(_key,value)=>{record=value}}
 const request=async value=>{calls++;if(calls===1)throw Error('lost response');return {...team,spec:value.spec,status:'draft',eligible_for_execution:false,revision:4}}
 await assert.rejects(saveConfiguration({team,command,storage,request}))
 await assert.rejects(saveConfiguration({team,command:{...command,request_id:'other'},storage,request}))
 await saveConfiguration({team,command,storage,request});await saveConfiguration({team,command,storage,request});assert.equal(calls,2)
 assert.deepEqual(record.command,command)
})
test('catalogue read is GET only with same-origin credentials and validates home before returning',async()=>{
 const original=globalThis.fetch,calls=[]
 try{globalThis.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>catalog}}
  assert.equal((await readNativeCatalog(team,'native-cli')).selected_profile.id,'native-cli')
  assert.equal(calls[0].url,'/api/kode/interactive-teams/catalog?profile_id=native-cli');assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.method,undefined)
  await assert.rejects(readNativeCatalog({...team,home_hub:'other'},'native-cli'))
 }finally{globalThis.fetch=original}
})
test('interactive settings keep common controls visible and collapse versioned management by purpose',async()=>{
 const panel=await readFile(new URL('../packages/collab/superagent-settings-panel.js',import.meta.url),'utf8')
 assert.match(panel,/controls\?\.readAgentConfiguration && h\(HubTeamAgentDefaults/)
 assert.match(panel,/h\(SuperagentRoleInstructions, \{ team, request, storage, onSaved: saved \}\)/)
 assert.equal((panel.match(/h\(TeamManagementView/g)||[]).length,1)
 for(const title of ['私信置顶与归档','工作范围','完整职责、资源与版本确认'])assert.ok(panel.includes(`h('summary', null, '${title}')`))
 assert.match(panel,/!interactive && h\('div', \{ className: 'kode-settings-group', 'aria-label': '当前会话'/)
 const instructions=await readFile(new URL('../packages/collab/superagent-role-instructions.js',import.meta.url),'utf8')
 assert.doesNotMatch(instructions,/重新读取角色指令|kode-role-instructions-refresh/)
 assert.match(instructions,/error \?[\s\S]*?'重试读取'/)
 const form=await readFile(new URL('../packages/collab/team-configuration-form.js',import.meta.url),'utf8')
 assert.doesNotMatch(form,/TeamNativeTargetPicker|CLI \/ 模型组合|并行上限|可用 CLI|type: 'checkbox'/)
 assert.match(form,/name, purpose, additions/);assert.match(form,/coordinatorTargets = team\.spec\.coordinator_targets/)
 const defaults=await readFile(new URL('../packages/collab/team-agent-defaults.js',import.meta.url),'utf8')
 const targets=await readFile(new URL('../packages/collab/team-role-targets.js',import.meta.url),'utf8')
 assert.match(defaults,/'aria-label': '执行配置'/);assert.doesNotMatch(defaults,/本机默认 Agent 与模型|团队执行配置/)
 assert.match(targets,/Reasonable 模型/);assert.match(targets,/Lite 模型/);assert.doesNotMatch(targets,/添加组合|预算|额度|调度策略/)
 const proposal=await readFile(new URL('../packages/collab/builder-proposal-view.js',import.meta.url),'utf8')
 assert.doesNotMatch(proposal,/账户|权限策略：|预算策略：|调度策略：|同时任务上限|工作分配上限|主动工作模式/)
 const panelStyles=await readFile(new URL('../packages/collab/superagent-settings-panel.js',import.meta.url),'utf8')
 const builderStyles=await readFile(new URL('../packages/collab/builder-conversation-styles.js',import.meta.url),'utf8')
 assert.match(panelStyles,/padding:24px clamp\(16px,4vw,48px\) 32px/);assert.match(panelStyles,/max-width:960px/)
 assert.match(builderStyles,/\.kode-builder-page\{[^}]*width:100%;max-width:none;margin:0;padding:24px clamp\(16px,4vw,48px\) 32px/)
 assert.match(builderStyles,/\.kode-builder-page-content\{[^}]*width:100%;max-width:960px;margin:0 auto/)
})
