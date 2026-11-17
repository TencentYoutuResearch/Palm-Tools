import assert from 'node:assert/strict'
/** Keep native configuration, replace only the fixture scenario. No provider output injection. */
export function nativeDiscussionSource(original){
 let source=original
 const replace=(a,b)=>{assert.equal(source.split(a).length,2,'Discussion fixture seam changed: '+a.slice(0,70));source=source.replace(a,b)}
 replace("import { liveTeamPipeline } from './support/live-team-pipeline.js'","import { liveTeamPipeline } from './support/live-team-pipeline.js'\nimport { nativeDiscussionPipeline } from './support/native-discussion-pipeline.js'")
 replace('Coordinator requests automatically execute implementation, independent review and real verification','Native discussion routes two owner threads without task execution')
 replace('timeout:slowScenario?900000:90000','timeout:Infinity')
 replace('let lostAnswer=false,answerWrites=0','let lostAnswer=true,answerWrites=0')
 replace('let lostPublication=false,publicationWrites=0,lostWorkflow=false,workflowWrites=0,lostStart=false,transferWrites=0,lostTransfer=false,lostRecovery=false','let lostPublication=true,publicationWrites=0,lostWorkflow=true,workflowWrites=0,lostStart=true,transferWrites=0,lostTransfer=true,lostRecovery=true')
 replace('   async *stream(options){',"   async *stream(options){\n    throw Error('Controlled adapter forbidden in native discussion acceptance')")
 replace("  const automatic=process.env.KODE_TEST_COORDINATOR_BOOTSTRAP==='1'",`  await nativeDiscussionPipeline({t,hub,ctx,profiles,execution,host,team,workspace,call,errors,model:fixtureModel})
  return
  const automatic=process.env.KODE_TEST_COORDINATOR_BOOTSTRAP==='1'`)
 replace('await hub.close()}}',"await hub.stop();t.diagnostic(JSON.stringify({native_discussion_retained:{root:hub.root,node:hub.node}}))}}")
 return source
}
