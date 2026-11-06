import test from 'node:test'
import assert from 'node:assert/strict'
import { mountCoordinatorWorkflowTool } from '../src/coordinator-workflow-tool.js'
test('Coordinator workflow receipt recovery pins prior-run lineage without replaying tools',async()=>{
  let tool;const calls=[]
  const op={id:'operation',attempt:1,epoch:1},scope={team_id:'team',conversation_id:'conversation',control_revision:1},agent={id:'coordinator'}
  const binding={managedOperation:op,managedCoordinator:scope}
  const tools={register:value=>{tool=value;return()=>{}},get:()=>tool}
  const ctx={get:name=>name==='tools'?{forScope:()=>tools}:{register:()=>()=>{}}}
  const args={request_id:'new',source_message_id:'human',binding_id:'local',inputs:{request:'Try again'},prior_run_id:'old'}
  const run={team_id:'team',context:{binding:{id:'local'}},inputs:args.inputs,prior_run_id:'old',coordinator:{conversation_id:'conversation',source_message_id:'human',operation_id:'operation',attempt:1,epoch:1,control_revision:1}}
  const runtime={profiles:{binding:()=>binding},entry:{assertToolBody:()=>{}},client:{call:async(path,body)=>{assert.equal(body,undefined);calls.push(path);return {run}}}}
  const dispose=mountCoordinatorWorkflowTool(ctx,agent,runtime,scope)
  try{
    assert.deepEqual(await tool.execute(args),run)
    await assert.rejects(tool.execute({...args,prior_run_id:'other'}),/receipt conflict/)
    const {prior_run_id,...legacy}=args
    await assert.rejects(tool.execute(legacy),/receipt conflict/)
    run.prior_run_id=null
    assert.deepEqual(await tool.execute(legacy),run,'legacy no-prior receipts remain valid')
    for(const value of ['',null,'../other',5])await assert.rejects(tool.execute({...args,prior_run_id:value}),/Invalid Coordinator/)
    assert.equal(calls.length,4)
    assert.ok(calls.every(path=>path.endsWith('/work-runs/requests/new')))
  }finally{dispose()}
})
