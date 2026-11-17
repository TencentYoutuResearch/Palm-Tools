import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { registerTeamConfigurationAcceptance } from '../src/team-configuration-acceptance-route.js'
test('owner facade forwards exact immutable command and read requests, never saves', async () => {
  let route, kind='agent', status, response; const calls=[]
  registerTeamConfigurationAcceptance({connection:{admit:()=>({peer:{principal:{kind}}})},webServer:{register:r=>{route=r}}},{backendClient:{call:async (...args)=>{calls.push(args);return {ok:true}}}})
  const send=async(method,body,url='/api/kode/teams/configuration-acceptance?id=team')=>{const req=Readable.from(body?[JSON.stringify(body)]:[]);Object.assign(req,{method,url,headers:{'content-type':'application/json'}});await route.handler(req,{writeHead:c=>status=c,end:s=>response=JSON.parse(s)})}
  const command={id:'team',request_id:'confirm',expected_revision:2,parent_accepted_revision:1,spec:{purpose:'Exact'}}
  await send('POST',command);assert.equal(status,403);await send('GET');assert.equal(status,403);assert.equal(calls.length,0)
  kind='owner';await send('POST',command);assert.equal(status,200);assert.deepEqual(calls[0],['/api/v1/messaging/teams/team/configuration-acceptance',{request_id:'confirm',expected_revision:2,parent_accepted_revision:1,spec:{purpose:'Exact'}}])
  await send('GET');assert.deepEqual(calls[1],['/api/v1/messaging/teams/team/configuration-acceptance',undefined])
  await send('GET',null,'/api/kode/teams/configuration-acceptance?id=team&request_id=confirm');assert.deepEqual(calls[2],['/api/v1/messaging/teams/team/configuration-acceptance-requests/confirm',undefined])
  for(const change of [{actor:{kind:'human'}},{expected_revision:1},{parent_accepted_revision:0},{id:'../other'}]){await send('POST',{...command,...change});assert.equal(status,400)}
  assert.equal(calls.length,3);assert.equal(response.code,'ACCEPTANCE_INVALID')
})
