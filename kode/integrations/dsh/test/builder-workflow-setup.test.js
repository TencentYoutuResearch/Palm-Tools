import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { isolatedHub } from './support/isolated-hub.js'
import { registerBuilderWorkflowSetup, setupBuilderWorkflow, setupSavedBuilderWorkflow } from '../src/builder-workflow-setup.js'
test('owner workflow setup recovers partial immutable registrations and makes them discoverable to Builder',{skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
 const hub=await isolatedHub('builder-workflow-setup');let server
 try{
  const call=(p,b)=>hub.client.call(`/api/v1/messaging/${p}`,b),workspace={host_id:hub.node,workspace_id:'workspace',root_ref:'registered-root'}
  const draft=await call('superagents/drafts',{id:'draft',request_id:'create',expected_revision:0,revoked:false,interview:{purpose:'Configure this project',workspace_refs:[workspace],answers:{},questions:[],proposed_team:null}})
  const input={draft_id:'draft',expected_revision:1,request_id:'setup',workflow:{id:'flow',version:'1',inputs:['request'],stages:[{id:'make',role:'author',requires:['request'],produces:['artifact'],independent_from:[]}],completion_stages:['make'],evidence_rules:{artifact:{kind:'artifact',repository_binding:'code'}}},
   project:{id:'project',version:'1',spec:{kind:'project_bindings',repositories:{code:{repository_id:'repository',workspace}},environments:{},commands:{},connections:{}}},
   delivery:{id:'delivery',version:'1',targets:[{kind:'local',repository_binding:'code'}],required_outputs:['artifact']}}
  let route,lose=true,loseReceipt=false
  const client={call:async(p,b)=>{const result=await hub.client.call(p,b);if(lose&&b&&p.endsWith('/project-configs')){lose=false;throw Error('lost committed project reply')}if(loseReceipt&&b?.value?.result){loseReceipt=false;throw Error('lost committed final receipt')}return result}}
  registerBuilderWorkflowSetup({webServer:{register:r=>{route=r}},connection:{admit:req=>({peer:{principal:{kind:req.headers['x-fixture-principal']??'owner'}}})}},{backendClient:client})
  server=createServer((req,res)=>route.handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening')
  const send=(body,principal='owner')=>fetch(`http://127.0.0.1:${server.address().port}/api/kode/builder/configure-workflow`,{method:'POST',headers:{'content-type':'application/json','x-fixture-principal':principal},body:JSON.stringify(body)})
  assert.equal((await send(input,'agent')).status,403)
  await assert.rejects(call('workbench/documents/builder-workflow-invalid'),/unknown workbench document/)
  const worker=await call('sessions',{session_id:'worker',title:'Worker',runtime:'external'})
  await assert.rejects(hub.client.forSession(worker.owner_token).call(`/api/v1/messaging/workbench/documents/builder-workflow-${'a'.repeat(64)}`),/403/)

  const foreign=structuredClone(input);foreign.project.spec.repositories.code.workspace.root_ref='outside'
  await assert.rejects(setupBuilderWorkflow(hub.client,foreign),/selected workspaces/)
  assert.equal((await send(input)).status,409)
  assert.equal((await call('workflows/flow/events')).events.length,1)
  assert.equal((await call('project-configs/project/events')).events.length,1)
  await hub.stop('SIGKILL');await hub.start()
  loseReceipt=true
  assert.equal((await send(input)).status,409)
  const response=await send(input);assert.equal(response.status,200)
  const result=await response.json();assert.equal(result.state,'registered');assert.equal(result.activation_performed,false)
  assert.equal(result.workflow.hash.length,64);assert.equal(result.delivery_policy.hash.length,64)
  assert.deepEqual(await (await send(input)).json(),result)
  assert.equal((await call('workflows/flow/events')).events.length,1)
  assert.equal((await call('project-configs/project/events')).events.length,1)
  assert.equal((await call('project-configs/delivery/events')).events.length,1)
  assert.deepEqual(await call('superagents/drafts/draft'),draft,'setup does not replace interview or proposal')
  for(const kind of ['workflow','project','delivery']){
   const catalog=await call('superagents/drafts/draft/catalog',{expected_revision:1,team_id:'candidate',kind,after_id:'',after_version:'',limit:10})
   assert.equal(catalog.items.length,1)
  }
  await assert.rejects(setupBuilderWorkflow(hub.client,{...input,expected_revision:2}),/identity conflict/)
  const packageValue={workflow:input.workflow,project:input.project,delivery:input.delivery}
  const invalid=structuredClone(packageValue);invalid.project.spec.repositories.code.workspace.root_ref='outside'
  await assert.rejects(call('superagents/drafts',{id:'draft',request_id:'invalid-proposal',expected_revision:1,revoked:false,interview:{...draft.interview,proposed_workflow:invalid}}),/outside selected workspaces/)
  const saved=await call('superagents/drafts',{id:'draft',request_id:'save-package',expected_revision:1,revoked:false,interview:{...draft.interview,proposed_workflow:packageValue}})
  const confirmation={draft_id:'draft',expected_revision:2,request_id:'saved-confirm'}
  const accepted=await (await send(confirmation)).json()
  assert.equal(accepted.state,'registered');assert.deepEqual(accepted.workflow,result.workflow)
  assert.equal((await call('workflows/flow/events')).events.length,1)
  await assert.rejects(setupSavedBuilderWorkflow(hub.client,{...confirmation,expected_revision:1}),/identity conflict/)
  await call('superagents/drafts',{id:'draft',request_id:'revoke',expected_revision:2,revoked:true,interview:saved.interview})
  assert.deepEqual(await setupSavedBuilderWorkflow(hub.client,confirmation),accepted)

  assert.deepEqual(await setupBuilderWorkflow(hub.client,input),result,'historical receipt does not mutate revoked draft')
  assert.deepEqual((await call('teams')).items,[])
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await hub.close()}
})
test('partial saved workflow resumes after interview edits but cannot cross removed scope or revocation', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
 const hub = await isolatedHub('builder-workflow-revision')
 try {
  const call = (path, body) => hub.client.call('/api/v1/messaging/' + path, body)
  const workspace = { host_id: hub.node, workspace_id: 'workspace', root_ref: 'registered-root' }
  for (const mode of ['interview', 'scope', 'revoke']) {
   const proposal = {
    workflow: { id: 'flow-' + mode, version: '1', inputs: ['request'], stages: [{ id: 'make', role: 'author', requires: ['request'], produces: ['artifact'], independent_from: [] }], completion_stages: ['make'], evidence_rules: { artifact: { kind: 'artifact', repository_binding: 'code' } } },
    project: { id: 'project-' + mode, version: '1', spec: { kind: 'project_bindings', repositories: { code: { repository_id: 'repository', workspace } }, environments: {}, commands: {}, connections: {} } },
    delivery: { id: 'delivery-' + mode, version: '1', targets: [{ kind: 'local', repository_binding: 'code' }], required_outputs: ['artifact'] },
   }
   const draft = await call('superagents/drafts', { id: mode, request_id: 'create', expected_revision: 0, revoked: false, interview: { purpose: 'Original scope', workspace_refs: [workspace], answers: {}, questions: [], proposed_team: null, proposed_workflow: proposal } })
   const command = { draft_id: mode, expected_revision: 1, request_id: 'confirm' }
   const interrupted = { call: async (path, body) => { const result = await hub.client.call(path, body); if (body && path.endsWith('/workflows')) throw Error('lost workflow reply'); return result } }
   await assert.rejects(setupSavedBuilderWorkflow(interrupted, command), /lost workflow reply/)
   const changed = await call('superagents/drafts', { id: mode, request_id: 'edit', expected_revision: 1, revoked: mode === 'revoke', interview: { ...draft.interview, purpose: 'Updated interview', proposed_workflow: null, ...(mode === 'scope' ? { workspace_refs: [{ ...workspace, root_ref: 'different-root' }] } : {}) } })
   await hub.stop('SIGKILL'); await hub.start()
   if (mode === 'interview') {
    await assert.rejects(setupSavedBuilderWorkflow(hub.client, { ...command, request_id: 'unreviewed' }), /unavailable/)
    const result = await setupSavedBuilderWorkflow(hub.client, command)
    assert.equal(result.draft_revision, 1); assert.equal(result.state, 'registered'); assert.equal(result.activation_performed, false)
    assert.equal((await call('project-configs/project-' + mode + '/events')).events.length, 1)
    assert.deepEqual(await setupSavedBuilderWorkflow(hub.client, command), result)
   } else {
    await assert.rejects(setupSavedBuilderWorkflow(hub.client, command), mode === 'scope' ? /outside selected workspaces/ : /unavailable/)
    assert.equal((await call('project-configs/project-' + mode + '/events')).events.length, 0)
   }
   assert.equal((await call('workflows/flow-' + mode + '/events')).events.length, 1)
   assert.deepEqual(await call('superagents/drafts/' + mode), changed)
  }
  assert.deepEqual((await call('teams')).items, [])
 } finally { await hub.close() }
})

test('Builder saves explicit human acceptance in immutable policy without enabling it by default', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
 const hub = await isolatedHub('builder-human-acceptance')
 try {
  const call = (path, body) => hub.client.call('/api/v1/messaging/' + path, body)
  const workspace = { host_id: hub.node, workspace_id: 'workspace', root_ref: 'registered-root' }
  await call('superagents/drafts', { id: 'draft', request_id: 'create', expected_revision: 0, revoked: false, interview: { purpose: 'Configure acceptance', workspace_refs: [workspace], answers: {}, questions: [], proposed_team: null } })
  const input = { draft_id: 'draft', expected_revision: 1, request_id: 'configure', workflow: { id: 'flow', version: '1', inputs: ['request'], stages: [{ id: 'make', role: 'author', requires: ['request'], produces: ['artifact'], independent_from: [] }], completion_stages: ['make'], evidence_rules: { artifact: { kind: 'artifact', repository_binding: 'code' } } },
   project: { id: 'project', version: '1', spec: { kind: 'project_bindings', repositories: { code: { repository_id: 'repo', workspace } }, environments: {}, commands: {}, connections: {} } },
   delivery: { id: 'delivery', version: '1', targets: [{ kind: 'local', repository_binding: 'code' }], required_outputs: ['artifact'], human_acceptance: true } }
  let calls = 0
  await assert.rejects(setupBuilderWorkflow({ call() { calls++; throw Error('Unexpected write') } }, { ...input, delivery: { ...input.delivery, human_acceptance: 'yes' } }), /Invalid Builder/)
  assert.equal(calls, 0)
  const configured = await setupBuilderWorkflow(hub.client, input)
  const saved = await call('project-configs/delivery/versions/1')
  assert.equal(saved.config.spec.human_acceptance, true)
  assert.equal(configured.delivery_policy.hash, saved.hash)
  await hub.stop('SIGKILL'); await hub.start()
  assert.deepEqual(await setupBuilderWorkflow(hub.client, input), configured)
  const ordinary = await call('project-configs', { id: 'ordinary', version: '1', spec: { ...saved.config.spec, human_acceptance: false } })
  assert.equal('human_acceptance' in ordinary.config.spec, false)
  assert.equal(configured.activation_performed, false)
  assert.deepEqual((await call('teams')).items, [])
 } finally { await hub.close() }
})
