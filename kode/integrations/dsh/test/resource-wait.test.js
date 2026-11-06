import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkRunController } from '../src/work-run-controller.js'
import { BackendClient } from '../src/backend-client.js'
const path='/api/v1/messaging/work-assignments/assignment/resources'
for(const [label,error,expected] of [
 ['account',{status:409,code:'assignment_account_capacity_exhausted',path},'waiting_resource'],
 ['workspace',{status:409,code:'assignment_workspace_busy',path},'waiting_resource'],
 ['transport',new Error('lost resource reply'),'progression_failed'],
 ['text-only',new Error('assignment account capacity exhausted'),'progression_failed'],
 ['other endpoint',{status:409,code:'assignment_account_capacity_exhausted',path:'/api/v1/messaging/operations/operation'},'progression_failed'],
 ['permission',{status:403,code:'assignment_account_capacity_exhausted',path},'progression_failed'],
 ['unknown code',{status:409,code:'execution_uncertain',path},'progression_failed'],
])test(label,async()=>{
 const host={execution:{},stop:new AbortController()}
 const controller=new WorkRunController({host},{prepare:async()=>{}})
 controller.advance=async()=>{throw error}
 try{const result=await new Promise(resolve=>controller.watch('run',{once:true,intervalMs:100,onState:resolve}));assert.equal(result.state,expected)}finally{await controller.close()}
})
test('backend preserves typed admission refusal without classifying generic errors',async()=>{
 const client=new BackendClient('http://fixture.invalid','fixture',{fetch:async()=>new Response(JSON.stringify({error:'capacity exhausted',code:'assignment_account_capacity_exhausted'}),{status:409})})
 await assert.rejects(client.call(path,{request_id:'same'}),e=>e.status===409&&e.path===path&&e.code==='assignment_account_capacity_exhausted')
})
