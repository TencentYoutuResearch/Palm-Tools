import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const source = readFileSync(new URL('../packages/chat/client.js', import.meta.url), 'utf8')
const region = name => { const start=source.indexOf(`//#region lib/types/client/${name}.js`); assert.ok(start>=0); return source.slice(source.indexOf('\n',start),source.indexOf('//#endregion',start)) }
function context() {
 const scope=vm.createContext({brandString:x=>x,isVisibleChatNode:n=>n.visibility!=='hidden',isAtOrOutside:(n)=>['exchange','input','turn','process'].includes(n.groupTree),hasAssistantReplyContent:blocks=>blocks.some(b=>b.kind==='text'),isRunningTool:t=>t.kind!=='tool-result',liveToolDetail:(_name,args)=>args.command??'',liveReasoningDetail:()=>''})
 const start=source.indexOf('function activity(name) {'),end=source.indexOf('const LIVE_TOOL_DETAIL_MAX_CHARS',start)
 vm.runInContext(source.slice(start,end),scope)
 const activityStart=source.indexOf('function processActivity(nodes) {')
 vm.runInContext(source.slice(activityStart,source.indexOf('//#endregion',activityStart)),scope)
 vm.runInContext(region('conversation-nodes/process-groups'),scope)
 return scope
}
const text=(key)=>({key,kind:'assistant-step',location:{kind:'step',turn:{turn:1}},data:{blocks:[{kind:'text',text:key}]}})
const tool=(key,time,running=false)=>{const call={callId:key,name:'kode_native_commandExecution',time,args:{command:key},subCalls:[],phase:'start'};return{key,kind:'tool-call',location:{kind:'step',turn:{turn:1}},data:{root:running?call:{kind:'tool-result',callId:key,call,subCalls:[]}}}}
test('actual rendered grouping keeps text outside a single consecutive three-tool group',()=>{
 const c=context(),g=new c.TurnGroups(1)
 let nodes=[text('before'),tool('pwd',1),tool('git status',2),tool('npm test',3,true)]
 const input={timeline:{turns:new Map([[1,{status:'open'}]])},readTurn:()=>nodes.map(n=>n.key),readNode:key=>nodes.find(n=>n.key===key),readPosition:key=>{const i=nodes.findIndex(n=>n.key===key);return{previous:nodes[i-1]?.key,next:nodes[i+1]?.key,turn:1}}}
 g.rebuild(input,new Set(nodes.map(n=>n.key)))
 const group=g.snapshots()[0]
 assert.equal(g.snapshots().length,1);assert.deepEqual(Array.from(group.members,m=>m.key),['pwd','git status','npm test'])
 assert.equal(group.data.summary.running,'commands');assert.equal(group.data.summary.runningDetail,'npm test')
 const key=group.key
 nodes=[...nodes.slice(0,-1),tool('npm test',3),text('after')]
 g.rebuild(input,new Set(['after']))
 assert.equal(g.snapshots().length,1);assert.equal(g.snapshots()[0].key,key);assert.equal(g.snapshots()[0].data.closed,true)
 assert.equal(g.references('before')[0].kind,'node');assert.equal(g.references('after')[0].kind,'node')
 assert.equal(g.snapshots()[0].members.length,3)
})
test('completion disclosure remains available after interleaved input, while live turns remain open',()=>{
 // Exercise the shipped expression with the exact interleaved-input case that
 // formerly forced every intermediate reply to remain visible after completion.
 const expression=/const alwaysOpen = (liveProcess[^;]+);/.exec(source)[1]
 assert.equal(vm.runInNewContext(expression,{liveProcess:false,interleavedInput:true,routedNode:{},turnProcessAlwaysOpen:()=>false}),false)
 assert.equal(vm.runInNewContext(expression,{liveProcess:true,interleavedInput:true,routedNode:{},turnProcessAlwaysOpen:()=>false}),true)
})

test('completion moves tool focus to the surviving header before folding; composer focus is untouched',()=>{
 const marker='(0, react.useLayoutEffect)(() => {\n  if (previousStatus.current === "open"'
 const start=source.indexOf(marker);assert.ok(start>=0)
 const callback=source.slice(start+'(0, react.useLayoutEffect)('.length,source.indexOf(', [turn?.status, node.data.turn, turnProcess.setOpen]);',start))
 for(const inTool of [true,false]){
  const actions=[],previousStatus={current:'open'}
  const run=vm.runInNewContext('('+callback+')',{previousStatus,turn:{status:'closed',end:{data:{reason:{kind:'completed'}}}},node:{data:{turn:4}},document:{activeElement:{closest:()=>inTool?{getAttribute:key=>key==='data-chat-turn'?'4':'tool-call'}:null}},controlRef:{current:{focus:()=>actions.push('focus header')}},turnProcess:{setOpen:value=>actions.push(value?'open':'collapse')}})
  run();assert.deepEqual(actions,inTool?['focus header','collapse']:['collapse']);assert.equal(previousStatus.current,'closed')
  run();assert.equal(actions.length,inTool?2:1)
 }
})

test('parallel-step history reuses the native assistant renderer without losing earlier replies',()=>{
 const helpers=readFileSync(new URL('../packages/chat/native-metadata.js',import.meta.url),'utf8'),definitions=[]
 const scope=vm.createContext({chatNode:(_ctx,kind,seq,data,options)=>({kind,anchorSeq:seq,data,...options}),toAssistantBlocks:blocks=>blocks.map(block=>({...block,kind:block.type}))})
 vm.runInContext(helpers,scope);scope.registerKodeAssistantHistory({uiConversation:{events:{register:definition=>definitions.push(definition)}}})
 const definition=definitions[0],event={seq:12,time:12,type:'assistant/message',surfaceOp:'append',data:{turn:1,step:1,message:{content:[{type:'text',text:'Progress before the next tool'}]}}}
 const build=latest=>definition.buildViewNode({state:event,start:{location:{kind:'step',step:{data:{get:()=>latest}}}}})
 assert.equal(build({finalNode:{seq:12}}).visibility,'hidden')
 const older=build({finalNode:{seq:20}});assert.equal(older.visibility,'visible');assert.equal(older.kind,'assistant-step');assert.equal(older.anchorSeq,12);assert.equal(older.groupTree,'process')
 const thought=definition.buildViewNode({state:{...event,data:{...event.data,message:{content:[{type:'reasoning',text:'thinking'}]}}},start:{location:{kind:'step',step:{data:{get:()=>({finalNode:{seq:20}})}}}}});assert.equal(thought.groupTree,undefined)
 assert.equal(build({status:'running',anchorSeq:18}).visibility,'visible')
 assert.equal(definition.match['assistant/message']({...event,data:{message:{content:[{type:'tool-call'}]}}}),null)
})

test('reasoning and unknown surfaces between commands remain in the same process group',()=>{
 for(const middle of [
  {key:'middle',kind:'assistant-step',location:{kind:'step',turn:{turn:1}},data:{blocks:[{kind:'reasoning',text:'checking'}]}},
  {key:'middle',kind:'unknown-surface',location:{kind:'step',turn:{turn:1}},data:{}}
 ]){
  const c=context(),g=new c.TurnGroups(1),nodes=[tool('first',1),middle,tool('latest',3,true)]
  const input={timeline:{turns:new Map([[1,{status:'open'}]])},readTurn:()=>nodes.map(n=>n.key),readNode:key=>nodes.find(n=>n.key===key),readPosition:key=>{const i=nodes.findIndex(n=>n.key===key);return{previous:nodes[i-1]?.key,next:nodes[i+1]?.key,turn:1}}}
  g.rebuild(input,new Set(nodes.map(n=>n.key)))
  assert.equal(g.snapshots().length,1)
  assert.deepEqual(Array.from(g.snapshots()[0].members,m=>m.key),['first','middle','latest'])
  assert.equal(g.snapshots()[0].data.summary.runningDetail,'latest')
 }
})
