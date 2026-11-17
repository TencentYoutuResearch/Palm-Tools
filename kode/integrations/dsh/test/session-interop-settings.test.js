import test from 'node:test'
import assert from 'node:assert/strict'
import {parseInteropSnapshot,validateInteropSettings,requestSessionInterop} from '../packages/collab/session-interop-settings-model.js'
const profiles=[{id:'managed',name:'Managed',models:['model-a'],reasoningEfforts:['high']}]
test('local snapshot is required and stale saved model is retained without permitting save',()=>{
 assert.throws(()=>parseInteropSnapshot({summary:null,grants:[],profiles}),/本机/)
 const next=parseInteropSnapshot({scope:'local_host',summary:{profile_id:'missing',model:'old'},grants:[],profiles})
 assert.equal(next.settings.summary.model,'old')
 assert.throws(()=>validateInteropSettings(next.settings,profiles),/可用/)
 assert.deepEqual(validateInteropSettings({summary:null,grants:[]},profiles),{summary:null,grants:[]})
})
test('summary selection and exact grants are validated without workflow or wildcard authority',()=>{
 const settings={summary:{profile_id:'managed',model:'model-a',reasoningEffort:'high'},grants:[{source:'a',target:'b',actions:['summary','model','direct_insert']}]}
 assert.deepEqual(validateInteropSettings(settings,profiles),settings)
 for(const grant of [{source:'*',target:'b',actions:['summary']},{source:'a',target:'b',actions:['workflow']},{source:'a',target:'',actions:['summary']}]) assert.throws(()=>validateInteropSettings({...settings,grants:[grant]},profiles))
 assert.throws(()=>validateInteropSettings({...settings,summary:{...settings.summary,model:'unlisted'}},profiles))
})
test('request stays on local origin and posts the whole replacement only on explicit save',async()=>{
 const calls=[];const fetcher=async(...args)=>{calls.push(args);return {ok:true,json:async()=>({})}}
 await requestSessionInterop(undefined,{fetcher});await requestSessionInterop({summary:null,grants:[]},{fetcher})
 assert.deepEqual(calls.map(x=>x[0]),['/api/kode/session-interop','/api/kode/session-interop'])
 assert.equal(calls[0][1].method,'GET');assert.equal(calls[0][1].body,undefined)
 assert.equal(calls[1][1].credentials,'same-origin');assert.equal(calls[1][1].redirect,'error')
 assert.deepEqual(JSON.parse(calls[1][1].body),{action:'configure',settings:{summary:null,grants:[]}})
 await assert.rejects(requestSessionInterop(undefined,{fetcher:async()=>({ok:false,status:403})}),e=>e.status===403)
})
