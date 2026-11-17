import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {validateChannelProject,requestExternalResources} from '../packages/collab/external-resources-model.js'

const scope={home_hub:'owner',host_id:'local',workspace_id:'project-a',root_ref:'/fixture/project-a'}
const binding={scope,id:'binding-a',surface_id:'anchor-channel',audience_revision:1,connection_id:'connection-a',connection_revision:'rev-1',revision:1,enabled:true,source:{provider:'tapd',instance:'https://fixture.example',resource:'project-1'}}
const payload={scope,surface_id:'current-channel',audience_revision:1,bindings:[binding],connections:[]}

test('project read validates exact current channel and allows a separately validated same-project anchor',()=>{
  assert.deepEqual(validateChannelProject(payload,scope,'current-channel'),[binding])
  for(const changes of [{surface_id:'outside-channel'},{audience_revision:0},{scope:{...scope,workspace_id:'other'}},{scope:{...scope,host_id:'remote'}},{bindings:[{...binding,scope:{...scope,root_ref:'/other'}}]}])
    assert.throws(()=>validateChannelProject({...payload,...changes},scope,'current-channel'),/Invalid/)
})
test('project query performs a credential-scoped read with the complete canonical scope and channel id',async()=>{
  await requestExternalResources('project',{...scope,surface_id:'current-channel'},{fetcher:(input,options)=>{
    const url=new URL(input,'https://local.fixture')
    assert.deepEqual(Object.fromEntries(url.searchParams),{op:'project',...scope,surface_id:'current-channel'})
    assert.equal(options.method,'GET');assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store')
    return new Response(JSON.stringify(payload))
  }})
  await assert.rejects(requestExternalResources('project',{...scope,surface_id:'current-channel',arbitrary_token:'not-sent'}),/Unsupported/)
})
test('the delivered native Session path and Channel path share a single DSH tab renderer',async()=>{
  const read=file=>readFile(new URL('../'+file,import.meta.url),'utf8')
  const [native,collab]=await Promise.all([read('packages/conversation/client.js'),read('packages/collab/client.js')])
  assert.equal((native.match(/function ConversationViewTabList\(/g)??[]).length,1)
  assert.equal((native.match(/jsx\)\(ConversationViewTabList,/g)??[]).length,2)
  assert.match(collab,/kodeChannelViewTabs/)
  assert.doesNotMatch(collab,/key: "kode-external-resources"/)
})
