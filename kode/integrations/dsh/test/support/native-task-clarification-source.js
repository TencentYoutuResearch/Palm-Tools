import assert from 'node:assert/strict'
/** Asserted setup seam. Existing fixture and its other scenarios remain unchanged. */
export function nativeTaskClarificationSource(original,{zeroProviderFailure=false}={}){
 let source=original
 const replace=(a,b)=>{assert.equal(source.split(a).length,2,'Native fixture seam changed: '+a.slice(0,70));source=source.replace(a,b)}
 replace("import { liveTeamPipeline } from './support/live-team-pipeline.js'","import { liveTeamPipeline } from './support/live-team-pipeline.js'\nimport { nativeTaskClarificationPipeline } from './support/native-task-clarification-pipeline.js'\nimport { withNativeTaskCleanup } from './support/native-task-failure-cleanup.js'")
 replace('timeout:slowScenario?900000:90000','timeout:Infinity')
 replace('let lostAnswer=false,answerWrites=0','let lostAnswer=true,answerWrites=0')
 replace('let lostPublication=false,publicationWrites=0,lostWorkflow=false,workflowWrites=0,lostStart=false,transferWrites=0,lostTransfer=false,lostRecovery=false','let lostPublication=true,publicationWrites=0,lostWorkflow=true,workflowWrites=0,lostStart=true,transferWrites=0,lostTransfer=true,lostRecovery=true')
 if(zeroProviderFailure){
  // Entirely separate controlled cleanup test; cannot count as native acceptance.
  replace("effort:liveCoordinatorScenario?'low':null",'effort:null')
  replace("const nativeCoordinator=process.env.KODE_TEST_NATIVE_COORDINATOR==='1'||liveCoordinatorScenario",'const nativeCoordinator=false')
  replace('   async *stream(options){',`   async *stream(options){
    yield {type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
    yield {type:'block-start',index:0,blockType:'text'}
    yield {type:'block-end',index:0,block:{type:'text',text:'Controlled idle cleanup fixture; no output publication.'}}
    yield {type:'finish',reason:{kind:'stop'}}
    return`)
 }else replace('   async *stream(options){',"   async *stream(options){\n    throw Error('Controlled adapter forbidden in native task acceptance')")
 replace("  const automatic=process.env.KODE_TEST_COORDINATOR_BOOTSTRAP==='1'",`  const nativeController=new WorkRunController(new AssignmentDispatchHost(host),{prepare:(assignment,options)=>prepareWorkRunAssignment(execution,assignment,options)})
  runService=await new WorkRunService(nativeController,{intervalMs:100}).open()
  const nativeContext={t,hub,ctx,profiles,execution,host,runService,team,workspace,call,errors,model:fixtureModel}
  await withNativeTaskCleanup(nativeContext,()=>nativeTaskClarificationPipeline(nativeContext))
  return
  const automatic=process.env.KODE_TEST_COORDINATOR_BOOTSTRAP==='1'`)
 replace('await hub.close()}}',"await hub.stop();t.diagnostic(JSON.stringify({native_task_retained:{root:hub.root,node:hub.node}}))}}")
 return source
}
