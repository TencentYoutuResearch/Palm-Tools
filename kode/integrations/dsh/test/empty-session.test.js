import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyEmptySessions, setupOnlySession, sessionInspector } from '../src/empty-session.js'

test('cold empty setup is hidden, while unknown, forked and queued histories remain visible',async()=>{
 const items=['empty','message','queued','fork','unreadable'].map(sessionId=>({sessionId,blank:false,running:false}))
 const controller={inspect:async id=>{
  if(id==='unreadable')throw new Error('storage unavailable')
  return{inheritedEventCount:id==='fork'?10:0,events:id==='message'?[{type:'user/message'}]:id==='queued'?[{type:'agent/inbox/spliced'}]:[{type:'permission/preset'},{type:'sandbox/mode'},{type:'approval/policy'}]}
 }}
 const rows=await classifyEmptySessions(controller,items)
 assert.deepEqual(rows.map(row=>row.blank),[true,false,false,false,false])
 assert.equal(setupOnlySession({events:[]}),false,'missing inheritance metadata is unknown')
 assert.equal(setupOnlySession({inheritedEventCount:0,events:[{type:'plugin:future/work'}]}),false)
})


test('restored desktop placeholders remain empty after seed sealing without hiding branches or work', async () => {
 const events = [{type:'permission/preset'}, {type:'sandbox/mode'}, {type:'approval/policy'}, {type:'session/end-seed',data:{}}]
 assert.equal(setupOnlySession({inheritedEventCount:0,events}),true)
 assert.equal(setupOnlySession({inheritedEventCount:0,events:[...events,{type:'session/end-seed',data:{}}]}),true)
 assert.equal(setupOnlySession({inheritedEventCount:1,events}),false)
 assert.equal(setupOnlySession({inheritedEventCount:0,events:[{type:'session/end-seed',data:{inherited:true}}]}),false)
 for(const type of ['user/message','assistant/message','agent/inbox/spliced','plugin:future/work'])
  assert.equal(setupOnlySession({inheritedEventCount:0,events:[...events,{type}]}),false)
 const rows = await classifyEmptySessions({inspect:async()=>({inheritedEventCount:0,events})},[{sessionId:'desktop-placeholder',blank:false,running:false,cwd:'/srv/desktop-profile'}])
 assert.equal(rows[0].blank,true)
})


test('0.2.2 cold query observations hide sealed placeholders and release every retained observation', async () => {
 let disposed=0
 const query={async observeSession(id, options){
  assert.equal(options.projectionMode,'none')
  if(id==='unreadable')throw new Error('corrupt')
  return {inheritedEventCount:id==='branch'?1:0,events:id==='message'?[{type:'user/message'}]:[{type:'permission/preset'},{type:'session/end-seed',data:{}}],[Symbol.dispose](){disposed++}}
 }}
 const rows=await classifyEmptySessions({},['empty','branch','message','unreadable'].map(sessionId=>({sessionId,blank:false,running:false})),query)
 assert.deepEqual(rows.map(row=>row.blank),[true,false,false,false]);assert.equal(disposed,3)
 const controller=new AbortController()
 const inspect=sessionInspector({},query)
 controller.abort(new Error('cancelled'))
 await assert.rejects(inspect('empty',controller.signal),/cancelled/)
 assert.equal(disposed,4,'aborted reads release the retained observation too')
})

test('host directory applies query-based classification before exposing ungrouped histories', async () => {
 const {hostDirectory}=await import('../src/workspace-directory.js')
 const services={
  workspaceRegistry:{list:()=>[],archivedSessionIds:[]},
  sessionController:{list:async()=>({items:[{sessionId:'empty',blank:false,running:false},{sessionId:'real',blank:false,running:false}]})},
  sessionQuery:{observeSession:async id=>({inheritedEventCount:0,events:[{type:id==='empty'?'session/end-seed':'user/message',data:{}}],[Symbol.dispose](){}})},
 }
 const result=await hostDirectory({get:key=>services[key]})
 assert.deepEqual(result.hiddenSessionIds,['empty']);assert.deepEqual(result.sessions.map(row=>row.id),['real'])
})
