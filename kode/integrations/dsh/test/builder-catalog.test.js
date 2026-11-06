import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { createHash } from 'node:crypto'
test('Builder catalog pages immutable versions and hides projects outside selected workspaces', {skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
 const hub=await isolatedHub('builder-catalog')
 try{
  const call=(path,body)=>hub.client.call(`/api/v1/messaging/${path}`,body)
  const workspace={host_id:hub.node,workspace_id:'selected',root_ref:'/fixture'}
  const interview={purpose:'Configure delivery',workspace_refs:[workspace],answers:{},questions:[],proposed_team:null}
  const draft=await call('superagents/drafts',{id:'draft',request_id:'create',expected_revision:0,revoked:false,interview})
  const pack={id:'flow',version:'1',inputs:['request'],stages:[{id:'report',role:'writer',requires:['request'],produces:['report'],independent_from:[]}],completion_stages:['report'],evidence_rules:{report:{kind:'report',schema_id:'report',schema_hash:'a'.repeat(64)}}}
  const workflow=await call('workflows',pack),workflow2=await call('workflows',{...pack,version:'2'})
  const project=(id,work)=>({id,version:'1',spec:{kind:'project_bindings',repositories:{primary:{repository_id:'repo',workspace:work}},environments:{},commands:{},connections:{}}})
  const foreign=await call('project-configs',project('a-hidden',{...workspace,workspace_id:'other',root_ref:'/other'}))
  const visible=await call('project-configs',project('b-visible',workspace))
  const ref=row=>({id:row.id,version:row.version,hash:row.hash})
  const delivery=await call('project-configs',{id:'delivery',version:'1',spec:{kind:'delivery_policy',project:ref(visible),workflow:ref(workflow),targets:[{kind:'local',repository_binding:'primary'}],required_outputs:['report']}})
  await call('project-configs',{id:'a-foreign-delivery',version:'1',spec:{kind:'delivery_policy',project:ref(foreign),workflow:ref(workflow),targets:[{kind:'local',repository_binding:'primary'}],required_outputs:['report']}})
  const path='superagents/drafts/draft/catalog',query={expected_revision:1,kind:'workflow',after_id:'',after_version:'',limit:1}
  const registered=await call('sessions',{session_id:'worker',title:'Worker',runtime:'external'})
  await assert.rejects(hub.client.forSession(registered.owner_token).call(`/api/v1/messaging/${path}`,query),/403/)
  const first=await call(path,query)
  assert.deepEqual(first.items,[workflow]);assert.equal(first.has_more,true)
  const second=await call(path,{...query,...first.cursor})
  assert.deepEqual(second.items,[workflow2]);assert.equal(second.has_more,false);assert.equal(second.cursor,null)
  const hidden=await call(path,{...query,kind:'project'})
  assert.deepEqual(hidden.items,[]);assert.equal(hidden.has_more,true,'empty filtered page must retain scan cursor')
  assert.deepEqual((await call(path,{...query,kind:'project',...hidden.cursor})).items,[visible])
  assert.deepEqual((await call(path,{...query,kind:'delivery',limit:10})).items,[delivery])
  const dependency=(id,host)=>({id,version:'1',spec:{kind:'workflow_dependency',artifact:{kind:'skill',source:'fixture://reviewed-procedure',source_version:'1',instructions:'Reviewed method',content_hash:createHash('sha256').update('Reviewed method').digest('hex'),hosts:[host],tools:[],capabilities:[],network:false}}})
  await call('project-configs',dependency('foreign-method','other-host'))
  const method=await call('project-configs',dependency('local-method',hub.node))
  assert.deepEqual((await call(path,{...query,kind:'dependency',limit:10})).items,[method])
  assert.deepEqual(await call('superagents/drafts/draft'),draft,'catalog is read-only')
  assert.deepEqual((await call('teams')).items,[])
  for(const invalid of [{...query,expected_revision:2},{...query,limit:11},{...query,after_id:'flow'}])await assert.rejects(call(path,invalid),/revision conflict|invalid/)
  await hub.stop('SIGKILL');await hub.start()
  assert.deepEqual(await call(path,query),first)
  await call('superagents/drafts',{id:'draft',request_id:'revoke',expected_revision:1,revoked:true,interview})
  await assert.rejects(call(path,{...query,expected_revision:2}),/unavailable/)
 }finally{await hub.close()}
})
