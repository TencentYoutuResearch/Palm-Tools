import test from 'node:test'
import assert from 'node:assert/strict'
import { acpApprovalDetails } from '../src/acp-approval-details.js'
import { AcpSession } from '../src/acp-session.js'
test('approval shows exact supplied tool arguments and paths instead of generic reason', () => {
 const result=acpApprovalDetails({title:'Grep',kind:'search',rawInput:{pattern:'Superpowers|superpowers',path:'/project/skills',glob:'*.json'},locations:[{path:'/project/skills',line:1}]})
 for(const text of ['Grep','Superpowers|superpowers','/project/skills','*.json','路径']) assert.ok(result.includes(text))
})
test('only same-call cached input is used and missing details are explicit', () => {
 assert.match(acpApprovalDetails({title:'Read'},{input:{path:'/project/a'}}), /同一调用已报告/)
 assert.match(acpApprovalDetails({title:'Grep'}), /参数：未知/)
 assert.match(acpApprovalDetails({title:'Read',rawInput:{path:'/new'}},{input:{path:'/old'}}), /\/new/)
 assert.doesNotMatch(acpApprovalDetails({title:'Read',rawInput:{}},{input:{path:'/old'}}), /\/old/)
})
test('nested secrets and common command credentials are redacted and display bounded', () => {
 const output=acpApprovalDetails({title:'Run',rawInput:{password:'secret-a',nested:{apiKey:'secret-b'},command:'curl -H "Authorization: Bearer secret-c" https://user:secret-d@example.test?token=secret-e',large:'x'.repeat(40000)}})
 for(const secret of ['secret-a','secret-b','secret-c','secret-d','secret-e']) assert.ok(!output.includes(secret),secret)
 assert.ok(output.length<6100)
})
test('ACP permission retains once-only decisions, abort signal and exact call identity', async () => {
 let request,signal
 const controller=new AbortController()
 const session=Object.create(AcpSession.prototype)
 session.threadId='thread';session.active={turnId:'turn',signal:controller.signal,tools:new Map([['call',{title:'Read',input:{path:'/project/file'}}],['other',{input:{path:'/wrong'}}]])}
 session.handlers={approve:async(method,r,s)=>{request=r;signal=s;return false}}
 const params={sessionId:'thread',toolCall:{toolCallId:'call'},options:[{kind:'allow_once',optionId:'allow'},{kind:'reject_once',optionId:'deny'}]}
 assert.deepEqual(await session.permission(params),{outcome:{outcome:'selected',optionId:'deny'}})
 assert.equal(signal,controller.signal);assert.equal(request.itemId,'call');assert.match(request.reason,/\/project\/file/);assert.doesNotMatch(request.reason,/\/wrong/)
 session.handlers.approve=async()=>true
 assert.equal((await session.permission(params)).outcome.optionId,'allow')
 assert.equal((await session.permission({...params,sessionId:'other'})).outcome.outcome,'cancelled')
})
