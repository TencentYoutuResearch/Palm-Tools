import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { toolObservation } from '../src/tool-observation.js'
test('tool observations retain exact content identity and bytes without retaining payloads',()=>{
 const value={text:'fixture 私密内容',token:'fixture-only-value'}
 const proof=toolObservation(value),raw=JSON.stringify(value)
 assert.deepEqual(proof,{encoding:'json_utf8',sha256:createHash('sha256').update(raw).digest('hex'),bytes:Buffer.byteLength(raw)})
 assert.ok(!JSON.stringify(proof).includes(value.token));assert.ok(!JSON.stringify(proof).includes(value.text))
 assert.notDeepEqual(toolObservation(undefined),toolObservation(null))
 assert.notDeepEqual(toolObservation(value),toolObservation({...value,text:'changed'}))
 assert.throws(()=>toolObservation({bad:1n}),/BigInt/)
})
