import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTeamCapabilityUpdate } from '../src/team-capability-update-route.js'
test('owner capability update bridge rejects identity expansion and preserves exact command', async () => {
  let route, kind='worker', status, result, failed=false;const calls=[]
  registerTeamCapabilityUpdate({webServer:{register:r=>route=r},connection:{admit:()=>({peer:{principal:{kind}}})}}, {backendClient:{call:async(...args)=>{calls.push(args);if(failed)throw Error('private');return {saved:true}}}})
  const res={writeHead:v=>status=v,end:v=>result=JSON.parse(v)}
  const command={request_id:'request',team_revision:2,target_id:'target',scheduling_revision:3,capability_revision:4,assessments:{},replace_pins:false}
  const send=(body,url='/')=>route.handler({method:'POST',url,headers:{'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify(body)}},res)
  const input={team_id:'team',command}
  await send(input);assert.equal(status,403);assert.equal(calls.length,0)
  kind='owner'
  for(const extra of [{actor:'owner'},{activation_performed:true},{team_revision:0},{capability_revision:1.2},{replace_pins:'true'},{target_id:'bad/id'}]){await send({...input,command:{...command,...extra}});assert.equal(status,400)}
  await send(input,'/?team_id=foreign');assert.equal(status,400);assert.equal(calls.length,0)
  await send(input);assert.equal(status,200);assert.deepEqual(calls[0],['/api/v1/messaging/teams/team/capability-update',command])
  failed=true;await send(input);assert.equal(status,409);assert.equal(result.retry,'same_request');assert.ok(!JSON.stringify(result).includes('private'))
  failed=false;await route.handler({method:'GET',url:'/?team_id=team&request_id=request'},res);assert.equal(status,200)
  assert.deepEqual(calls[2],['/api/v1/messaging/teams/team/capability-update-requests/request',undefined])
  await route.handler({method:'GET',url:'/?team_id=team&request_id=request&request_id=other'},res);assert.equal(status,400);assert.equal(calls.length,3)
})
