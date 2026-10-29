import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeContextUsage, contextUsageProjection } from '../src/context-usage.js'
const event=tokenUsage=>({type:'plugin:kode/native-event',data:{event:{method:'thread/tokenUsage/updated',params:{tokenUsage}}}})
test('context pressure uses the latest Codex window sample, not cumulative spend or twice-counted cache',()=>{
 assert.deepEqual(nativeContextUsage(event({total:{totalTokens:215183580},last:{totalTokens:730339,inputTokens:730127,cachedInputTokens:729113},modelContextWindow:950000})),{used:730339,total:950000})
 const before={used:730339,total:950000}
 assert.deepEqual(contextUsageProjection.apply(before,event({last:{totalTokens:18000},modelContextWindow:950000})),{used:18000,total:950000})
 assert.equal(contextUsageProjection.apply(before,event({total:{totalTokens:1},modelContextWindow:950000})),before)
})
test('ACP context telemetry and unknown values are handled without invented usage',()=>{
 assert.deepEqual(nativeContextUsage({type:'plugin:kode/native-event',data:{event:{method:'session/update',params:{update:{sessionUpdate:'usage_update',used:42,size:100}}}}}),{used:42,total:100})
 for(const value of [{last:{totalTokens:-1},modelContextWindow:100},{last:{totalTokens:42},modelContextWindow:0},{last:{totalTokens:NaN},modelContextWindow:100}])assert.equal(nativeContextUsage(event(value)),undefined)
 assert.deepEqual(contextUsageProjection.init(),{})
})
test('compaction invalidates the old fill ratio until the next native usage sample arrives',()=>{
 const before={used:800000,total:950000,seq:1}
 const compact={seq:2,type:'plugin:kode/native-event',data:{event:{method:'item/completed',params:{item:{type:'contextCompaction'}}}}}
 const waiting=contextUsageProjection.apply(before,compact);assert.equal(waiting.used,undefined);assert.equal(waiting.total,950000);assert.equal(waiting.awaitingSample,true)
 const after=contextUsageProjection.apply(waiting,{...event({last:{totalTokens:18000},modelContextWindow:950000}),seq:3})
 assert.deepEqual(after,{used:18000,total:950000,seq:3});assert.equal(after.awaitingSample,undefined)
})
