import test from 'node:test'
import assert from 'node:assert/strict'
import { selectiveReplayLog, replayProcessFailure } from './support/live-replay-log.js'
test('replay subprocess evidence excludes rich SDK errors, model output and unknown fields',()=>{
 const secret='DO_NOT_EXPORT_SECRET'
 const text=selectiveReplayLog([
  secret,JSON.stringify({rich_sdk_error:{stderr:secret}}),
  JSON.stringify({managed_decision_summary:{stage:'implement',decisions:5,terminal_peer_closes:0,request:secret}}),
  JSON.stringify({live_evidence:{saved:true,phase:'before_cleanup',file:'001-before_cleanup.json',warning_count:0,credentials:secret}}),
 ].join('\n'))
 assert.equal(text.includes(secret),false)
 assert.equal(text.includes('implement'),true);assert.equal(text.includes('before_cleanup'),true)
 const error=replayProcessFailure({code:1,signal:'SIGTERM',stdout:secret,stderr:secret,message:secret})
 assert.equal(error.code,1);assert.equal(error.signal,'SIGTERM');assert.equal(error.stack.includes(secret),false)
 assert.equal(JSON.stringify(error).includes(secret),false)
})
