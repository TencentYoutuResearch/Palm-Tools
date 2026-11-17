/** Real native Composer/React, isolated HTTP and browser profile; no provider or real Hub. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {build} from 'esbuild'
import {collabRenderPage} from './support/collab-render-page.js'
import {headlessBrowser} from './support/headless-browser.js'

test('native interactive Composer chooses one target, freezes retries, isolates threads and separates stored from reply', {skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:90000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'kode-interactive-composer-'))
 const bundled=await build({entryPoints:['packages/collab/client-source.js'],bundle:true,write:false,format:'cjs',platform:'browser',loader:{'.png':'dataurl'},external:['@kode/dsh-composer','react','react-dom','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives','@deepseek-ai/dsh-client-ui-conversation']})
 const source=`window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}};const exports=module.exports;${bundled.outputFiles[0].text}\nreturn module.exports;}});`
 const scope={home_hub:'local',host_id:'local',workspace_id:'workspace',root_ref:'/example/project'}
 const contact={preference:{revision:0,pinned:false,archived:false,archived_through_sequence:0},archived:false,needs_attention:false,latest_sequence:0,unread_count:0,last_activity_at:0,attention:{decisions:0,resources:0,stopping:0,active_runs:0}}
 const team={id:'team',home_hub:'local',revision:2,superagent_id:'super',conversation_id:'conversation',contact,spec:{execution_mode:'interactive_native',name:'交互测试团队',kind:'coordinator',purpose:'隔离验证',workspace_refs:[scope],coordinator_targets:['cb-kimi','tc-hy4'],execution_targets:[{id:'cb-kimi',host_id:'local',executor_profile_id:'codebuddy',model_id:'kimi'},{id:'tc-hy4',host_id:'local',executor_profile_id:'tclaude',model_id:'hy4'}],workers:[{id:'frontend',role:'前端',workspace_refs:[scope],allowed_target_ids:['cb-kimi']},{id:'review',role:'评审',workspace_refs:[scope],allowed_target_ids:['cb-kimi','tc-hy4']}]}}
 const legacy={...team,id:'legacy',superagent_id:'legacy-super',conversation_id:'legacy-conversation',spec:{...team.spec,name:'旧团队',execution_mode:'managed'}}
 const surfaces=['channel','dm'].map(id=>({id,scope,enabled:true,kind:id==='dm'?'dm':'channel',title:id==='dm'?'隔离私信':'隔离频道',team_ids:['team','legacy'],revision:3,audience_revision:7}))
 const messages=surfaces.map(s=>({id:s.id+'-root',thread_id:s.id+'-root',surface_id:s.id,scope,kind:'discussion',actor:{kind:'human',id:'local_owner'},content:s.id==='dm'?'私信根消息':'频道根消息',mentions:[],delivery_state:'stored_only',created_at:Date.now(),sequence:1}))
 const posts=[];let loseNext=true,browser
 const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost');const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value))}
  if(url.pathname==='/fixture-collab.js'){res.setHeader('content-type','text/javascript');res.end(source);return}
  if(await collabRenderPage(req,res,{workspaces:[{workspaceId:'workspace',title:'隔离项目',path:scope.root_ref,sessionIds:[],createdAt:new Date().toISOString()}]}))return
  if(url.pathname==='/api/kode/project-hosts')return json({current:'local',hosts:[{id:'local',name:'此计算机'}]})
  if(url.pathname==='/api/kode/collab/teams')return json({home_hub:'local',projection:'contact_directory',archived:false,order:'pinned_attention_unread_recent',items:[team,legacy],next_cursor:null})
  if(url.pathname==='/api/kode/collaboration'){
   const path=url.searchParams.get('path');if(path==='surfaces')return json({scope,items:surfaces})
   const [,id,kind]=path.split('/'),surface=surfaces.find(s=>s.id===id)
   if(req.method==='POST'&&kind==='messages'){
    let text='';for await(const chunk of req)text+=chunk;const input=JSON.parse(text);posts.push({surface:id,input})
    if(loseNext){loseNext=false;res.statusCode=503;return json({error:'isolated reply loss'})}
    const message={id:'saved-'+input.request_id,thread_id:input.thread_id??'saved-'+input.request_id,surface_id:id,scope,kind:'discussion',actor:{kind:'human',id:'local_owner'},content:input.content,mentions:input.mentions,interactive_selection:input.interactive_selection,delivery_state:'stored_only',created_at:Date.now(),sequence:messages.length+1,...(input.interactive_selection?{interactive_delivery:{state:'not_ready',automatic_replay_allowed:false}}:{})}
    messages.push(message);return json(message)
   }
   if(kind==='threads')return json({surface,items:messages.filter(m=>m.surface_id===id&&m.id===m.thread_id).map(root=>({thread_id:root.id,root,reply_count:0,reply_actors:[]})),has_more:false})
   if(kind==='messages')return json({surface,items:messages.filter(m=>m.surface_id===id&&m.thread_id===url.searchParams.get('thread_id')),has_more:false})
   if(kind==='tasks')return json({scope,surface,items:[]})
  }
  res.statusCode=503;json({error:'isolated unsupported service'})
 }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}))}})
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile)
  const page=await browser.page(`http://127.0.0.1:${server.address().port}`)
  await page.call('Emulation.setDeviceMetricsOverride',{width:1360,height:960,deviceScaleFactor:1,mobile:false})
  const wait=expr=>page.evaluate(`(async()=>{for(let i=0;i<180;i++){if(${expr})return;await new Promise(r=>setTimeout(r,40))}throw Error(document.body.innerText+' '+JSON.stringify(fixtureErrors))})()`)
  const click=text=>page.evaluate(`Array.from(document.querySelectorAll('button,[data-row-title]')).find(e=>e.textContent.trim()===${JSON.stringify(text)}).click()`)
  const choose=async(label,value,area='.kode-discussion-timeline')=>page.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(area+' [aria-label="'+label+'"]')});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  const type=async(text,area='.kode-discussion-timeline')=>{await page.evaluate(`document.querySelector(${JSON.stringify(area+' textarea,'+area+' [role=textbox]')}).focus()`);await page.call('Input.insertText',{text})}
  const send=async(area='.kode-discussion-timeline')=>page.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(area+' button')})).find(e=>['发送','重试原发送'].includes(e.getAttribute('aria-label'))||['发送','重试原发送'].includes(e.textContent.trim())).click()`)
  await wait('globalThis.fixture');await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`);await wait(`document.querySelector('[role=menuitem]')`);await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(e=>e.textContent.includes('协作')).click()`)
  await wait(`Array.from(document.querySelectorAll('[data-row-title]')).some(e=>e.textContent==='隔离频道')`);await click('隔离频道');await wait(`document.querySelector('.kode-discussion-timeline [aria-label="@ 成员"]')`)
  await choose('@ 成员',JSON.stringify(['team','review']));await wait(`document.querySelector('[aria-label="CLI / 模型组合"]')`)
  assert.equal(await page.evaluate(`document.querySelector('[aria-label="CLI / 模型组合"]').value`),'')
  assert.equal(await page.evaluate(`document.querySelector('[aria-label="CLI / 模型组合"]').options.length`),3)
  await type('原请求冻结');await send();await wait(`document.body.innerText.includes('请选择当前职责')`);assert.equal(posts.length,0)
  await choose('CLI / 模型组合','tc-hy4')
  if(process.env.KODE_TEST_SCREENSHOTS){await mkdir(process.env.KODE_TEST_SCREENSHOTS,{recursive:true});await writeFile(join(process.env.KODE_TEST_SCREENSHOTS,'interactive-composer-target.png'),Buffer.from((await page.call('Page.captureScreenshot',{format:'png'})).data,'base64'))}
  await send();await wait(`document.body.innerText.includes('发送尚未确认')`);assert.equal(posts.length,1)
  assert.equal(await page.evaluate(`document.querySelector('[aria-label="CLI / 模型组合"]').disabled`),true)
  await page.evaluate(`document.querySelector('.kode-discussion-reply').click()`);await wait(`document.querySelector('.kode-discussion-detail [aria-label="@ 成员"]')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussion-detail [aria-label="@ 成员"]').value`),'')
  await choose('@ 成员',JSON.stringify(['team','frontend']),'.kode-discussion-detail');await wait(`document.querySelector('.kode-discussion-detail [aria-label="CLI / 模型组合"]')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussion-detail [aria-label="CLI / 模型组合"]').options.length`),2)
  await choose('CLI / 模型组合','cb-kimi','.kode-discussion-detail');await type('只回复当前串','.kode-discussion-detail');await send('.kode-discussion-detail');await wait(`document.querySelector('.kode-discussion-detail').innerText.includes('原生会话尚未就绪')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussion-detail .kode-discussion-native-composer>p[role=status]').getBoundingClientRect().bottom<=innerHeight`),true,'stored-only status is fully visible')
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussion-detail .kode-discussion-delivery').innerText.includes('原生会话尚未就绪')`),true)
  if(process.env.KODE_TEST_SCREENSHOTS)await writeFile(join(process.env.KODE_TEST_SCREENSHOTS,'interactive-composer-not-ready.png'),Buffer.from((await page.call('Page.captureScreenshot',{format:'png'})).data,'base64'))
  assert.equal(posts[1].input.thread_id,'channel-root');assert.equal(posts[1].input.interactive_selection.participant_id,'worker:frontend')
  await page.evaluate(`document.querySelector('[aria-label="关闭消息列"]').click()`)
  await send();await wait(`document.querySelector('.kode-discussion-timeline').innerText.includes('原生会话尚未就绪')`)
  assert.deepEqual(posts[2],posts[0]);assert.equal(posts[0].input.interactive_selection.target_id,'tc-hy4');assert.equal(posts[0].input.interactive_selection.audience_revision,7)
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussion-timeline').innerText.includes('团队回复已发布')`),false)
  await click('隔离私信');await wait(`document.querySelector('.kode-discussions').dataset.private==='true'`)
  assert.equal(await page.evaluate(`document.querySelector('[aria-label="@ 成员"]').value`),'')
  await choose('@ 成员',JSON.stringify(['legacy',null]));assert.equal(await page.evaluate(`!!document.querySelector('[aria-label="CLI / 模型组合"]')`),false)
  await type('旧路径仅讨论');await send();await wait(`document.body.innerText.includes('旧路径仅讨论')`);assert.equal(posts[3].input.interactive_selection,undefined)
  await page.evaluate(`new Promise(r=>setTimeout(r,250))`);assert.equal(posts.length,4)
  assert.equal(await page.evaluate('fixture.created()'),0)
  assert.deepEqual(await page.evaluate('fixtureErrors'),[])
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true})}
})
