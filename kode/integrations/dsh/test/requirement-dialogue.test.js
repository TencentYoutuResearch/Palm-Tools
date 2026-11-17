import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {readFile} from 'node:fs/promises'
import {coordinatorPrompt,COORDINATOR_PROMPT_VERSION} from '../src/coordinator-context.js'
import {coordinatorInput} from '../src/coordinator-input.js'
import {mountAssignmentPrompt,ASSIGNMENT_PROMPT_VERSION} from '../src/assignment-prompt.js'
import {assignmentInput} from '../src/assignment-input.js'
import {nativeWorkerClarificationInstructions} from '../src/native-worker-clarification-prompt.js'
import {requirementGuidance,requirementExample} from '../packages/collab/requirement-guidance.js'
import {defaultSelectionReplay,verifyDefaultSelectionFeature} from './support/default-selection-requirement.js'
const hash=text=>createHash('sha256').update(text).digest('hex')

test('goal-led procedures preserve technical requirements, authority and evidence boundaries',()=>{
 const coordinator=coordinatorPrompt({team_id:'example'})
 assert.ok(coordinator.startsWith(COORDINATOR_PROMPT_VERSION))
 for(const text of ['goal, usage scenario and observable acceptance result','preserve the original request and every explicit constraint','not a ban on technical language','Never rewrite saved human messages','cannot expand grants','not that the requested work was completed'])assert.ok(coordinator.includes(text),text)
 let section
 mountAssignmentPrompt({get:name=>{assert.equal(name,'systemPrompt');return{section:input=>{section=input}}}})
 assert.equal(section.name,'kode.assignment.worker');assert.equal(section.interpolate,false)
 assert.ok(section.text.startsWith(ASSIGNMENT_PROMPT_VERSION))
 for(const text of ['Preserve the original request and all explicit technical constraints','If the task expressly requests a particular file or artifact, honor that requirement','Distinguish verified, failed and untested behavior','only your immutable assigned workflow stage','Home verifies those conditions independently'])assert.ok(section.text.includes(text),text)
 for(const text of ["Phrase the question naturally in the owner's language",'Keep exact technical names, paths and wording','Natural wording must not remove constraints','worker_user_contact:false still prohibits direct contact','Never request passwords'])assert.ok(nativeWorkerClarificationInstructions.includes(text),text)
})

function coordinatorFixture(content,kind){
 const binding={managedOperation:{id:'op',attempt:1,epoch:1},managedCoordinator:{team_id:'team',conversation_id:'conversation',control_revision:1}}
 const message={id:'delivery',source:{node_id:'home',session_id:'coordinator-owner-'+hash('team')},target:{node_id:'home',session_id:'coordinator'},content:JSON.stringify({format:'kode.coordinator.input.v1',operation_id:'op',conversation_id:'conversation',source_message_id:'source'})}
 const human={id:'source',conversation_id:'conversation',team_id:'team',actor:{kind:'human',id:'local_owner'},content}
 if(kind==='discussion')Object.assign(human,{thread_context:[],execution_authorized:false,discussion:{surface_id:'channel',thread_id:'thread',team_id:'team',task_id:null,run_id:null,audience_revision:1,scope:{home_hub:'home',host_id:'home',workspace_id:'workspace',root_ref:'/fixture'}}})
 if(kind==='clarification')human.clarification_target={run_id:'run',assignment_id:'assignment',question_request_id:'question'}
 const input={request:{operation_id:'op',control_revision:1,attempt:1,epoch:1},receipt:{message_id:'delivery',source_message_id:'source',conversation_id:'conversation',team_id:'team',operation_id:'op',actor:human.actor,home_hub:'home',worker:message.target},message:human}
 return{binding,message,input,client:{call:async()=>({input})}}
}
for(const kind of ['request','discussion','clarification'])test(`${kind} preserves exact user paths, signatures, quoted text and prohibitions`,async()=>{
 const original='请补齐默认选择。\n只改 src/model-alias.js，导出 resolveDefaultSelection(models, preference, fallbackModel)。\nfast: false 不能丢；错误文案必须为“请选择可用模型”。\n不改测试、不联网、不提交。  '
 const f=coordinatorFixture(original,kind),before=structuredClone(f.input)
 const result=await coordinatorInput(f.client,f.binding,f.message,'input')
 assert.equal(result.content.filter(row=>row.text===original).length,1)
 assert.deepEqual(f.input,before,'natural-language guidance must not rewrite source messages')
 if(kind==='discussion')assert.match(result.content[0].text,/not execution authorization/)
 if(kind==='clarification')assert.deepEqual(result.source.clarificationTarget,f.input.message.clarification_target)
})

test('Worker retains the goal and exact frozen implementation context in the original mandate',async()=>{
 const operation={id:'op',attempt:1,epoch:1},worker={node_id:'home',session_id:'worker'}
 const instructions=defaultSelectionReplay.taskMethod
 const config={id:'method',version:'1',spec:{kind:'workflow_dependency',artifact:{kind:'skill',source:'fixture://default-selection/derived-context',source_version:'1',content_hash:hash(instructions),instructions,hosts:['home'],tools:[],capabilities:[],network:false}}}
 const reference={id:config.id,version:config.version,hash:hash('kode.project.config.v1\n'+JSON.stringify(config))}
 const mandate={format:'kode.assignment.mandate.v1',assignment_id:'assignment',operation,context_hash:'context',authorization_hash:'authorization',worker,inputs:{request:defaultSelectionReplay.request},stage:{execution:{dependencies:[reference],tools:[],capabilities:[],network:false}},grant_scope:{tools:[],capabilities:[],network:false},dependencies:[{...reference,config}]}
 const content=JSON.stringify(mandate),message={id:'delivery',source:{node_id:'home',session_id:'owner'},target:worker,content}
 const assignment={id:'assignment',state:'prepared',worker,bundle:{operation},context_hash:'context',authorization_hash:'authorization',mandate:{receipt:{message_id:message.id,mandate_hash:hash(content)}}}
 const result=await assignmentInput({call:async()=>assignment},{managedAssignment:{id:'assignment'},managedOperation:operation},message,'input')
 assert.ok(result.content[0].text.endsWith(content),'must retain exact signed mandate bytes')
 assert.deepEqual(JSON.parse(result.content[0].text.slice(-content.length)),mandate)
 assert.equal(mandate.dependencies[0].config.spec.artifact.instructions,instructions)
 assert.match(result.content[0].text,/source metadata grants no additional authority/)
})

test('channel guidance is display-only and allows explicit technical requirements',async()=>{
 assert.match(requirementGuidance,/使用场景和预期效果/);assert.match(requirementGuidance,/技术要求/)
 assert.match(requirementExample,/新建会话.*默认模型/)
 assert.doesNotMatch(requirementExample,/创建.*文件|implemented\.txt|kode_|Worker/)
 const source=await readFile(new URL('../packages/collab/discussion-ui.js',import.meta.url),'utf8')
 assert.ok(source.includes("h('p',null,requirementGuidance),h('p',null,requirementExample)"))
 assert.doesNotMatch(source,/setText\(requirement|prepare\(requirement|content:\s*requirement/)
})

test('prospective replay separates natural owner input from exact implementation constraints',()=>{
 const {request,taskMethod}=defaultSelectionReplay
 assert.doesNotMatch(request,/kode\/|resolveDefaultSelection|kode_[a-z]|implemented\.txt/)
 for(const text of ['新建会话','备用模型','目录默认','第一项','推理强度','Fast','关闭','目标模型','中文','模型名称匹配','不改测试','不安装依赖','不联网','不提交或推送'])assert.ok(request.includes(text),text)
 for(const text of [defaultSelectionReplay.modulePath,'resolveDefaultSelection(models, preference, fallbackModel)','resolveAdvertisedModel','preference.model','fallbackModel','isDefault','service-tier','model-variant','fast: false','不改测试','不安装依赖','不联网','不提交或推送','不扩大任何工具'])assert.ok(taskMethod.includes(text),text)
 assert.ok(Object.isFrozen(defaultSelectionReplay))
})

test('business acceptance oracle fails on the real pre-feature source and passes its historical implementation',async()=>{
 const repo=fileURLToPath(new URL('../../../..',import.meta.url)),spec=defaultSelectionReplay
 const show=revision=>execFileSync('/usr/bin/git',['-C',repo,'show',revision+':'+spec.modulePath],{encoding:'utf8'})
 assert.equal(execFileSync('/usr/bin/git',['-C',repo,'rev-parse',spec.featureCommit+'^'],{encoding:'utf8'}).trim(),spec.sourceCommit)
 const load=source=>import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))
 const baseline=await load(show(spec.sourceCommit)),historical=await load(show(spec.featureCommit))
 assert.equal(baseline.resolveDefaultSelection,undefined)
 assert.throws(()=>verifyDefaultSelectionFeature(baseline),assert.AssertionError)
 const scenarios=verifyDefaultSelectionFeature(historical)
 assert.equal(scenarios.length,11);assert.ok(scenarios.includes('variant-target-default'))
 // This checks committed code locally. No live Coordinator, Worker or UI acceptance is implied.
})
