import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmReviewedVerification,verificationReviewKey } from '../packages/collab/verification-review-command.js'
const review={host:'home',definition:{runner_id:'local',command_id:'check',revision:'1',env:{}},reference:{runner_id:'local',id:'check',revision:'1',definition_hash:'b'.repeat(64)},scope_hash:'a'.repeat(64),execution_performed:false}
const identity={host:'home',runner:'local',command:'check',revision:'1'}
test('durable browser command retains original review after response/local-save loss and rejects foreign receipts',async()=>{
 const rows=new Map();let savingFails=false,posts=[]
 const storage={async read(k){return structuredClone(rows.get(k))},async reserve(k,v){if(!rows.has(k))rows.set(k,structuredClone(v));return structuredClone(rows.get(k))},async save(k,v){if(savingFails)throw Error('local save unavailable');rows.set(k,structuredClone(v))}}
 const key=verificationReviewKey('home','local','check','1'),receipt={host:'home',reference:review.reference,execution_performed:false}
 await assert.rejects(confirmReviewedVerification({...identity,review,storage,request:async body=>{assert.equal(rows.get(key).state,'prepared');posts.push(body);throw Error('reply lost')}}))
 await assert.rejects(confirmReviewedVerification({...identity,review:{...review,scope_hash:'c'.repeat(64)},storage,request:()=>assert.fail('different review must not post')}))
 await assert.rejects(confirmReviewedVerification({...identity,storage,recover:true,request:async()=>({...receipt,host:'foreign'})}),/receipt/)
 assert.equal(rows.get(key).state,'prepared')
 savingFails=true
 await assert.rejects(confirmReviewedVerification({...identity,storage,recover:true,request:async body=>{posts.push(body);return receipt}}),/local save/)
 savingFails=false
 assert.deepEqual(await confirmReviewedVerification({...identity,storage,recover:true,request:async body=>{posts.push(body);return receipt}}),receipt)
 assert.equal(rows.get(key).state,'accepted');assert.ok(posts.every(body=>JSON.stringify(body)===JSON.stringify(posts[0])))
 assert.deepEqual(await confirmReviewedVerification({...identity,storage,recover:true,request:()=>assert.fail('confirmed local receipt needs no transport')}),receipt)
})
