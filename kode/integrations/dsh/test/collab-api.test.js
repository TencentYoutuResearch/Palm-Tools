import test from 'node:test'; import assert from 'node:assert/strict';
import {registerCollabTeams} from '../src/collab-api.js';
import {isolatedHub} from './support/isolated-hub.js';
test('owner directory uses real Hub pagination and stable identities without creating runtimes',{skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
 const hub=await isolatedHub('collab-directory-probe');
 try{
  const spec=name=>({name,purpose:'Directory probe',kind:'coordinator',workspace_refs:[],execution_targets:[],workers:[],coordinator_targets:[],workflow_pack_refs:[],grant_id:null,budget_policy_id:null,scheduling_policy_id:null,limits:{max_active_assignments:1,max_active_runs:1},proactive_mode:'off'});
  const first=await hub.client.call('/api/v1/messaging/teams',{id:'a',request_id:'a',expected_revision:0,spec:spec('A')});
  await hub.client.call('/api/v1/messaging/teams',{id:'b',request_id:'b',expected_revision:0,spec:spec('B')});
  let route,kind='agent',status,body,calls=0;
  registerCollabTeams({webServer:{register:r=>{route=r}},connection:{admit:()=>({peer:{principal:{kind}}})}}, {backendClient:{call:(...args)=>{calls++;assert.equal(args.length,1);return hub.client.call(...args)}}});
  const get=async(query='',method='GET')=>{await route.handler({method,url:route.path+query},{writeHead:s=>{status=s},end:b=>{body=JSON.parse(b)}});return body};
  await get();assert.equal(status,403);assert.equal(calls,0);kind='owner';
  for(const q of ['?limit=51','?limit=0','?limit=1&limit=2','?team_id=a&after=b','?team_id=../a','?host_id=foreign']){await get(q);assert.equal(status,400)}
  await get('','POST');assert.equal(status,405);assert.equal(calls,0);
  const page=await get('?limit=1');assert.equal(status,200);assert.equal(page.projection,'configuration_revision');assert.deepEqual(page.items,[first]);assert.equal(page.next_cursor,'a');
  const next=await get('?limit=1&after=a');assert.deepEqual(next.items.map(x=>x.id),['b']);assert.equal(next.next_cursor,null);
  assert.deepEqual((await get('?team_id=a')).team,first);
  const create = (id, name) => hub.client.call('/api/v1/messaging/teams', { id, request_id: id, expected_revision: 0, spec: spec(name) });
  await create('c', '中文 Design 100%_'); await create('d', '中文 design two');
  const found = await get('?q=' + encodeURIComponent('中文 DESIGN') + '&limit=1');
  assert.equal(status, 200); assert.deepEqual(found.items.map(row => row.id), ['c']); assert.equal(found.next_cursor, 'c');
  const continued = await get('?q=' + encodeURIComponent('中文 DESIGN') + '&limit=1&after=c');
  assert.deepEqual(continued.items.map(row => row.id), ['d']); assert.equal(continued.next_cursor, null);
  assert.deepEqual((await get('?q=' + encodeURIComponent('100%_'))).items.map(row => row.id), ['c'], 'wildcard characters are literal');
  assert.deepEqual((await get('?q=absent')).items, []);
  for (const q of ['?q=a&q=b', '?q=%00', '?q=' + 'x'.repeat(161), '?team_id=a&q=A']) { await get(q); assert.equal(status, 400); }
  await assert.rejects(hub.client.call('/api/v1/messaging/teams?q=' + 'x'.repeat(161)), /invalid team search/);

  await get('?team_id=missing');assert.equal(status,404);assert.equal(JSON.stringify(body).includes('HTTP'),false);
  await hub.stop('SIGKILL');await hub.start();assert.deepEqual((await get('?team_id=a')).team,first);
 }finally{await hub.close()}
});
test('directory bridge keeps authentication rejection and private backend failures separate',async()=>{
 let route,admission={rejection:401},status,body,headers,calls=0;
 const ctx={webServer:{register:r=>{route=r;return()=>{}}},connection:{admit:()=>admission}};
 const client={call:async()=>{calls++;throw Object.assign(Error('private backend detail'),{status:403})}};
 registerCollabTeams(ctx,{backendClient:client});
 const req={method:'GET',url:'/api/kode/collab/teams'};
 const res={writeHead:(s,h)=>{status=s;headers=h},end:b=>{body=JSON.parse(b)}};
 await route.handler(req,res);assert.equal(status,401);assert.equal(calls,0);
 admission={peer:{principal:{kind:'owner'}}};await route.handler(req,res);
 assert.equal(status,503);assert.equal(headers['cache-control'],'no-store');assert.deepEqual(body,{error:'Team directory unavailable'});assert.equal(calls,1);
 registerCollabTeams(ctx,{});await route.handler(req,res);assert.equal(status,503);assert.equal(calls,1);
});
