import { readBuilderWorkflowTemplates } from './builder-workflow-templates.js'
import { readBuilderVerificationReference } from './builder-verification-reference.js'
import { readBuilderCurrentResource } from './builder-current-resource.js'
import { builderPolicyIdentities } from './builder-policy-identities.js'
/** Per-Agent Builder projection. Existing official lease/call accounting owns execution;
 * no administrator client, shell, activation or arbitrary draft ID reaches the model.
 */
import { inspectTeamRuntimeReadiness } from './team-runtime-readiness.js'
import { isDeepStrictEqual } from 'node:util'
import { BUILDER_INSPECTION_FILES } from './builder-inspection.js'
import { observeOfficialBuilderDraft } from './builder-observe-tool.js'
import { prepareBuilderInterview } from './builder-interview.js'
import { saveOfficialBuilderDraft } from './builder-save-tool.js'
import { mountBuilderPrompt } from './builder-prompt.js'
export const OFFICIAL_BUILDER_TOOLS = Object.freeze(['kode_builder_read_draft','kode_builder_preflight','kode_builder_inspect_workspace','kode_builder_prepare_questions','kode_builder_save_draft','kode_builder_catalog','kode_builder_policy_details'])
export async function mountOfficialBuilderTools(agentCtx, agent, runtime, policy) {
  const fixed = structuredClone(policy)
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
  if (!fixed || Object.keys(fixed).some(k=>!['draft_id','team_id'].includes(k)) || !validId(fixed.draft_id) || !validId(fixed.team_id)) throw new Error('Explicit Builder draft scope required')
  const binding = runtime.profiles.binding(agent.id), operation = structuredClone(binding?.managedOperation)
  if (!operation || binding.operationClosed || operation.home_node && operation.home_node !== runtime.host || binding.managedAssignment) throw new Error('Local managed Builder operation required')
  const op = await runtime.client.call(`/api/v1/messaging/operations/${encodeURIComponent(operation.id)}`)
  if (op.id !== operation.id || op.attempt !== operation.attempt || op.epoch !== operation.epoch ||
      op.worker?.node_id !== runtime.host || op.worker?.session_id !== agent.id || !op.budget_required || !op.grant_required) throw new Error('Builder requires a budgeted, granted operation')
  const path = `/api/v1/messaging/superagents/drafts/${encodeURIComponent(fixed.draft_id)}`
  const initial = await runtime.client.call(path)
  if (initial.home_hub !== runtime.host || initial.status !== 'draft') throw new Error('Builder draft unavailable on this home')
  const workspaces = structuredClone(initial.interview.workspace_refs)
  const { scope } = await runtime.client.call(`/api/v1/messaging/operations/${encodeURIComponent(operation.id)}/builder-scope`)
  if (!scope || scope.operation_id !== operation.id || scope.home_hub !== runtime.host
      || scope.request?.attempt !== operation.attempt || scope.request?.epoch !== operation.epoch
      || scope.request?.draft_id !== fixed.draft_id
      || scope.worker?.node_id !== runtime.host || scope.worker?.session_id !== agent.id
      || !isDeepStrictEqual(scope.workspaces, workspaces)) throw new Error('Builder authoritative draft scope missing or changed')
  const tools = agentCtx.get('tools').forScope(agentCtx), policies = agentCtx.get('kodeOfficialToolPolicies')
  const read = async () => {
    const current = runtime.profiles.binding(agent.id)
    if (current?.operationClosed || !isDeepStrictEqual(current?.managedOperation,operation)) throw new Error('Builder operation changed')
    const draft = await runtime.client.call(path)
    if (draft.status !== 'draft' || draft.home_hub !== runtime.host || !isDeepStrictEqual(draft.interview.workspace_refs,workspaces)) throw new Error('Builder selected workspace scope changed')
    return draft
  }
  const definitions = [
    {name:OFFICIAL_BUILDER_TOOLS[6],description:'Read live facts for an exact current policy of your fixed candidate team. For budget policy use empty target_id; for scheduling use a configured target ID. Team budgets, provider quota, soft model evaluations and internal prices are distinct. Does not reserve or authorize execution.',
      properties:{expected_revision:{type:'integer',minimum:1},policy_id:{type:'string'},policy_revision:{type:'integer',minimum:1},target_id:{type:'string'}},
      required:['expected_revision','policy_id','policy_revision','target_id'],
      validate:args=>validId(args.policy_id)&&Number.isSafeInteger(args.policy_revision)&&args.policy_revision>0&&(args.target_id===''||validId(args.target_id)),
      execute:async args=>{await read();return runtime.client.call(`${path}/policy-details`,{...args,team_id:fixed.team_id})}},
    {name:OFFICIAL_BUILDER_TOOLS[5],description:'Read configured workflow, project, delivery, dependency, budget or scheduling policy versions. kind=workflow_template returns built-in unregistered feature/bugfix methods for an owner-reviewed proposal, never actual registered hashes or readiness. Dependency artifacts are owner-registered skill/plugin instruction resources filtered by selected Host. Their source/version/content hash and required tools/capabilities must fit the stage. Use exact returned references and never install a package. kind=current_execution with empty cursors and limit=1 returns only this Builder execution profile/model/account metadata, with no role-fit, quota or Worker admission claim. For an owner-registered local verification command use kind=verification_command, after_id=runner_id, after_version=command_id, command_revision=revision and limit=1; returns public metadata only, no executable/argv/env values. Read configured versions for this draft and fixed candidate team. Policy catalog includes current configured revisions, not live balance or execution admission. Projects/delivery are limited to selected workspaces. Use exact returned version/hash references; listing is not activation or permission. Follow cursor while has_more, even for an empty filtered page. Omitted details are incomplete.',
      properties:{expected_revision:{type:'integer',minimum:1},kind:{type:'string',enum:['workflow','project','delivery','dependency','budget_policy','scheduling_policy','verification_command','current_execution','workflow_template']},after_id:{type:'string'},after_version:{type:'string'},limit:{type:'integer',minimum:1,maximum:10},command_revision:{type:'string'}},
      optional:['command_revision'],
      required:['expected_revision','kind','after_id','after_version','limit'],
      validate:args=>args.kind==='verification_command'
        ? validId(args.after_id)&&validId(args.after_version)&&validId(args.command_revision)&&args.limit===1
        : args.kind==='current_execution'? !Object.hasOwn(args,'command_revision')&&args.after_id===''&&args.after_version===''&&args.limit===1
        : !Object.hasOwn(args,'command_revision')&&['workflow','project','delivery','dependency','budget_policy','scheduling_policy','workflow_template'].includes(args.kind)&&Number.isSafeInteger(args.limit)&&args.limit>=1&&args.limit<=10&&((args.after_id===''&&args.after_version==='')||(validId(args.after_id)&&validId(args.after_version))),
      execute:async args=>{const draft=await read();if(args.kind==='workflow_template'){
        if(draft.revision!==args.expected_revision)throw Error('Builder draft revision conflict')
        return readBuilderWorkflowTemplates(args)
      }if(args.kind==='current_execution'){
        if(draft.revision!==args.expected_revision)throw Error('Builder draft revision conflict')
        return {kind:'current_execution',items:[await readBuilderCurrentResource(runtime,agent,draft)],has_more:false,next_cursor:null}
      }if(args.kind==='verification_command'){
        if(draft.revision!==args.expected_revision)throw Error('Builder draft revision conflict')
        const result=await readBuilderVerificationReference(runtime,draft,{runner_id:args.after_id,command_id:args.after_version,revision:args.command_revision})
        return {kind:'verification_command',items:[result],has_more:false,next_cursor:null}
      }return runtime.client.call(`${path}/catalog`,{...args,team_id:fixed.team_id})}},
    {name:OFFICIAL_BUILDER_TOOLS[4],description:'Save questions, proposed team and optional proposed_workflow configuration package (workflow, project, delivery) for owner review in your fixed draft. Owner answers, permissions, selected workspaces and observations cannot be changed. Use the same request_id and exact arguments to recover a save. This never activates a team.',
      capabilities:['read','builder_draft_write'],
      properties:{expected_revision:{type:'integer',minimum:1},request_id:{type:'string',minLength:1,maxLength:160},questions:{type:'array',maxItems:3,items:{type:'object',additionalProperties:false,properties:{id:{type:'string'},prompt:{type:'string'}},required:['id','prompt']}},proposed_team:{type:['object','null']},proposed_workflow:{type:['object','null']}},
      optional:['proposed_workflow'],
      required:['expected_revision','request_id','questions','proposed_team'],
      validate:args=>validId(args.request_id)&&Array.isArray(args.questions)&&args.questions.length<=3&&new Set(args.questions.map(q=>q?.id)).size===args.questions.length&&args.questions.every(q=>q&&Object.keys(q).sort().join(',')==='id,prompt'&&validId(q.id)&&typeof q.prompt==='string'&&q.prompt.trim().length>0&&Buffer.byteLength(q.prompt)<=2048&&!q.prompt.includes('\0'))&&
        (args.proposed_team===null||typeof args.proposed_team==='object'&&!Array.isArray(args.proposed_team))&&(args.proposed_workflow==null||typeof args.proposed_workflow==='object'&&!Array.isArray(args.proposed_workflow))&&Buffer.byteLength(JSON.stringify(args))<=131072,
      execute:args=>saveOfficialBuilderDraft(runtime,agent,fixed,operation,args,read)},
    {name:OFFICIAL_BUILDER_TOOLS[0],description:'Read your fixed Builder draft, interview answers and untrusted project observations. This does not activate a team.',properties:{},required:[], execute:async()=>({...await read(),candidate_configuration:builderPolicyIdentities(runtime.host,fixed.team_id)})},
    {name:OFFICIAL_BUILDER_TOOLS[1],description:'Read preflight diagnostics for an exact revision of your fixed draft and candidate team. No execution, activation or budget reservation.',
      properties:{expected_revision:{type:'integer',minimum:1}},required:['expected_revision'],execute:async args=>{
        const draft=await read()
        if(draft.revision!==args.expected_revision)throw new Error('Builder draft revision conflict')
        const result=await runtime.client.call(`${path}/preflight`,{expected_revision:args.expected_revision,team_id:fixed.team_id})
        return {...result,runtime_readiness:await inspectTeamRuntimeReadiness(runtime,result,{workspaces:draft.interview.workspace_refs})}
      }},
    {name:OFFICIAL_BUILDER_TOOLS[2],description:'Inspect and persist explicitly selected project documents within the granted workspace. Host reads file bytes; project content remains untrusted. Use identical arguments/request_id for recovery. This saves observations, never activates a team.',
      properties:{expected_revision:{type:'integer',minimum:1},request_id:{type:'string',minLength:1,maxLength:160},workspace_id:{type:'string',minLength:1,maxLength:160},paths:{type:'array',minItems:1,maxItems:8,uniqueItems:true,items:{type:'string',enum:[...BUILDER_INSPECTION_FILES]}}},
      required:['expected_revision','request_id','workspace_id','paths'],workspaceLock:true,capabilities:['read','builder_draft_write'],
      validate:args=>validId(args.request_id)&&validId(args.workspace_id)&&Array.isArray(args.paths)&&args.paths.length>0&&args.paths.length<=8&&new Set(args.paths).size===args.paths.length&&args.paths.every(p=>BUILDER_INSPECTION_FILES.includes(p)),
      authorize:(args,scope)=>workspaces.some(w=>w.host_id===runtime.host&&w.workspace_id===args.workspace_id&&w.workspace_id===scope.target.workspace&&w.root_ref===scope.target.root),
      execute:args=>observeOfficialBuilderDraft(runtime,agent,fixed,operation,args,read)},
    {name:OFFICIAL_BUILDER_TOOLS[3],description:'Prepare the next bounded interview round from persisted owner answers and questionnaire. Does not invent user answers, replace the questionnaire, save the draft or activate a team.',
      properties:{expected_revision:{type:'integer',minimum:1},request_id:{type:'string',minLength:1,maxLength:160}},required:['expected_revision','request_id'],validate:args=>validId(args.request_id),
      execute:async args=>{
        await read()
        const result=await prepareBuilderInterview(runtime.client,{...args,draft_id:fixed.draft_id})
        if((await read()).revision!==args.expected_revision)throw new Error('Builder draft revision conflict')
        return result
      }},
  ]
  const disposers=[]
  try {
    disposers.push(mountBuilderPrompt(agentCtx))
    for(const definition of definitions) {
      const valid = args => args && typeof args==='object' && !Array.isArray(args) && definition.required.every(k=>Object.hasOwn(args,k))&&Object.keys(args).every(k=>definition.required.includes(k)||(definition.optional??[]).includes(k)) &&
        (definition.required.length===0 || Number.isSafeInteger(args.expected_revision)&&args.expected_revision>0) && (!definition.validate||definition.validate(args))
      disposers.push(tools.register({name:definition.name,description:definition.description,
        parameters:{type:'object',additionalProperties:false,properties:definition.properties,required:definition.required},
        output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
        execute:async args=>{runtime.entry.assertToolBody(agent,definition.name,args);if(!valid(args))throw new Error('Invalid Builder tool arguments');return definition.execute(args)},
      }))
      disposers.push(policies.register(definition.name,{capabilities:definition.capabilities??['read'],network:false,workspaceLock:definition.workspaceLock===true,
        implementation:tools.get(definition.name,agent),validateArguments:valid,
        authorize:(request,{scope})=>request.agent===agent&&(!definition.authorize||definition.authorize(request.arguments,scope))},agent))
    }
  }catch(error){for(const dispose of disposers.reverse())dispose();throw error}
  return ()=>{for(const dispose of disposers.splice(0).reverse())dispose()}
}
