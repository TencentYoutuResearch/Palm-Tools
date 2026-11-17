import test from 'node:test'
import assert from 'node:assert/strict'
import { contactPreview, contactTime } from '../packages/collab/contact-presentation.js'
test('contact preview keeps newer directory evidence over partial history and normalizes bounded unicode',()=>{
 const team={contact:{preview:{sequence:8,content:'最新消息',actor:'agent'}}}
 assert.equal(contactPreview(team,{items:[{sequence:2,content:'旧消息'}]}),'最新消息')
 assert.equal(contactPreview(team,{items:[{sequence:9,content:'  好的\n继续  ',actor:{kind:'human'}}]}),'你：好的 继续')
 assert.equal(Array.from(contactPreview({contact:{preview:{content:'掌'.repeat(500)}}})).length,160)
 assert.equal(contactPreview({}), '还没有消息')
})
test('invalid contact timestamps are absent rather than fabricated',()=>{
 for(const value of [null,0,-1,NaN,Infinity,'today',Number.MAX_SAFE_INTEGER]) assert.equal(contactTime(value),'')
 assert.ok(contactTime(Date.now()))
})
