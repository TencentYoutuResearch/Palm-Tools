import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collabRenderPage } from './support/collab-render-page.js'
import { headlessBrowser } from './support/headless-browser.js'

test('version confirmation uses native modal, read-only query, cancel, interrupted retry and exact persisted command', {skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:90000},async()=>{
 const bundle=await build({entryPoints:['packages/collab/client-source.js'],bundle:true,write:false,format:'cjs',platform:'browser',loader:{'.png':'dataurl'},external:['react','react-dom','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives','@kode/dsh-composer']})
 const client=`window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}},exports=module.exports;${bundle.outputFiles[0].text};return module.exports}})`
 const scope={home_hub:'home',host_id:'home',workspace_id:'ws-fixture',root_ref:'/fixture/project'}
 const contact={preference:{revision:0,pinned:false,archived:false,archived_through_sequence:0},archived:false,needs_attention:false,latest_sequence:0,unread_count:0,last_activity_at:0,attention:{decisions:0,resources:0,stopping:0,active_runs:0}}
 let team={id:'team',home_hub:'home',revision:2,superagent_id:'super',conversation_id:'dm',spec:{execution_mode:'interactive_native',name:'功能团队',kind:'coordinator',purpose:'旧任务',workspace_refs:[scope],workers:[{id:'backend',role:'Backend',responsibilities:['Develop'],allowed_target_ids:['old'],max_parallel:1}],coordinator_targets:['old'],execution_targets:[{id:'old',host_id:'home',executor_profile_id:'old-cli',executor_profile_revision:'b'.repeat(64),provider_id:'old-provider',model_id:'old-model',effort:null}],grant_id:'unchanged',budget_policy_id:null,proactive_mode:'off'}}
 const native={id:'fixture-codex',name:'Codex',type:'codex',provider_id:'kode-agent-fixture-codex',profile_revision:'a'.repeat(64)}
 const posts=[], confirmations=[];let stale=true,fail=true,receipt=null,browser,accepted=null
 const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost'),send=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}
  if(url.pathname==='/fixture-collab.js'){res.setHeader('content-type','text/javascript');res.end(client);return}
  if(await collabRenderPage(req,res,{workspaces:[{workspaceId:scope.workspace_id,title:'测试工作区',path:scope.root_ref,sessionIds:[],createdAt:'2026-11-10T00:00:00.000Z'}]}))return
  if(url.pathname==='/api/kode/collab/teams')return send(url.searchParams.get('team_id')?{projection:'configuration_revision',team}:{home_hub:'home',projection:'contact_directory',archived:false,order:'pinned_attention_unread_recent',items:[{...team,contact}],next_cursor:null})
  if(url.pathname==='/api/kode/conversation/messages')return send({home_hub:'home',team_id:'team',conversation_id:'dm',items:[],has_more:false,next_cursor:null})
  if(url.pathname==='/api/kode/conversation/read-state')return send({home_hub:'home',team_id:'team',conversation_id:'dm',principal_id:'local_owner',through_sequence:0,latest_sequence:0,unread_count:0})
  if(url.pathname==='/api/kode/collab/runs')return send({home_hub:'home',team_id:'team',items:[],next_cursor:null})
  if(url.pathname==='/api/kode/collaboration')return send({scope:Object.fromEntries(['home_hub','host_id','workspace_id','root_ref'].map(k=>[k,url.searchParams.get(k)])),items:[]})
  if(url.pathname==='/api/kode/agents')return send({profiles:[{...native,origin:'builtin'}],supportedTypes:['codex'],types:{codex:{name:'Codex'}},selectedProfileId:'fixture-codex'})
  if(url.pathname==='/api/kode/interactive-teams/catalog')return send({home_hub:'home',execution_mode:'interactive_native',eligible_for_execution:false,profiles:[native],...(url.searchParams.has('profile_id')?{selected_profile:{...native,profile_revision:stale?'c'.repeat(64):native.profile_revision},models:[{id:'gpt-6-astra',reasoningEfforts:['high']}]}:{})})
  if(url.pathname==='/api/kode/teams/configuration-acceptance'){
   if(req.method==='GET')return send(url.searchParams.has('request_id')?accepted:{team_id:team.id,team_revision:team.revision,accepted:!!accepted,parent_accepted_revision:1,receipt:accepted,builder_lineage:{team:{id:team.id},home_hub:'home',actor:{kind:'human'},draft_id:'builder',draft_revision:1}})
   let body='';for await(const chunk of req)body+=chunk;const {id,...command}=JSON.parse(body);assert.equal(id,team.id);confirmations.push(command)
   if(confirmations.length===1)return send({error:'response lost'},503)
   accepted={request:command,team,home_hub:'home',actor:{kind:'human',id:'local_owner'},activation_performed:false,eligible_for_execution:false,builder_lineage:{team:{id:team.id},home_hub:'home',actor:{kind:'human'},draft_id:'builder',draft_revision:1}};return send(accepted)
  }
  if(url.pathname==='/api/kode/teams/configuration'){
   let body='';for await(const chunk of req)body+=chunk;const command=JSON.parse(body);posts.push(command)
   if(fail){fail=false;return send({error:'uncertain'},503)}
   receipt={...team,revision:3,status:'draft',eligible_for_execution:false,spec:command.spec};team=receipt;return send(receipt)
  }
  return send({error:'fixture unavailable'},503)
 }catch(error){res.statusCode=500;res.end(error.message)}})
 const profile=await mkdtemp(join(tmpdir(),'kode-native-config-ui-'))
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page(`http://127.0.0.1:${server.address().port}`)
  const wait=expr=>page.evaluate(`(async()=>{for(let i=0;i<250;i++){if(${expr})return;await new Promise(r=>setTimeout(r,30))}throw Error(${JSON.stringify(expr)}+' :: '+document.body.innerText+' '+JSON.stringify(window.fixtureErrors))})()`)
  const click=async text=>{await wait(`Array.from(document.querySelectorAll('button')).some(b=>(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)})&&!b.disabled)`);await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)})&&!b.disabled).click()`)}
  const input=async(label,value,tag='input')=>page.evaluate(`(()=>{const el=Array.from(document.querySelectorAll('.kode-collab-team-configuration label')).find(e=>e.firstChild.textContent===${JSON.stringify(label)}).querySelector(${JSON.stringify(tag)});Object.getOwnPropertyDescriptor(${tag==='textarea'?'HTMLTextAreaElement':'HTMLInputElement'}.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  const select=async(label,value)=>page.evaluate(`(()=>{const el=Array.from(document.querySelectorAll('.kode-collab-team-configuration label')).find(e=>e.firstChild.textContent===${JSON.stringify(label)}).querySelector('select');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await wait(`document.querySelector('.kode-collab-mode-switch button')`)
  if(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').getAttribute('aria-label').includes('会话')`)){await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`);await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`);await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)}
  await wait(`document.querySelector('[data-sidebar-row=team] [data-row-title]')`);await page.evaluate(`document.querySelector('[data-sidebar-row=team] [data-row-title]').click()`)
  await click('SuperAgent 设置');await wait(`document.querySelector('.kode-collab-team-configuration input:not(:disabled)')`)
  await input('团队名称','Kode 开发团队');await input('团队目标','长期开发与质量协作','textarea')
  await click('读取原生 CLI / 模型目录');await click('Agent：选择 Agent');await click('Codex')
  await wait(`document.body.innerText.includes('无法核实原生 CLI')`);assert.equal(posts.length,0);assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='加入待保存资源')`),false)
  stale=false;await click('读取原生 CLI / 模型目录');await click('Agent：选择 Agent');await click('Codex');await click('模型：选择模型');await click('模型未选择');await click('gpt-6-astra');await click('加入待保存资源')
  await page.evaluate(`(()=>{const f=Array.from(document.querySelectorAll('.kode-collab-team-configuration fieldset')).find(e=>e.querySelector(':scope > legend')?.textContent==='Backend');for(const label of f.querySelectorAll('label')){const c=label.querySelector('input[type=checkbox]');if(c&&((label.textContent.includes('old-cli')&&c.checked)||(label.textContent.includes('fixture-codex')&&!c.checked)))c.click()}})()`)
  await click('核对配置变更');await wait(`document.querySelector('[aria-label=保存确认]')`)
  assert.match(await page.evaluate(`document.querySelector('[aria-label=保存确认]').innerText`),/团队编号：team/);assert.match(await page.evaluate(`document.querySelector('[aria-label=保存确认]').innerText`),/v2.*v3/)
  await click('返回编辑');assert.equal(posts.length,0)
  await click('核对配置变更');await click('确认保存草稿');await wait(`document.body.innerText.includes('恢复原保存请求')`);assert.equal(posts.length,1)
  assert.equal(posts[0].spec.grant_id,'unchanged');assert.equal(posts[0].spec.workers[0].allowed_target_ids.length,1);assert.notEqual(posts[0].spec.workers[0].allowed_target_ids[0],'old')
  await click('恢复原保存请求');await wait(`document.body.innerText.includes('当前配置 v3')`);assert.equal(posts.length,2);assert.deepEqual(posts[0],posts[1]);assert.equal(receipt.spec.name,'Kode 开发团队');assert.equal(receipt.spec.purpose,'长期开发与质量协作');assert.equal(receipt.id,'team');assert.equal(receipt.conversation_id,'dm');assert.equal(receipt.spec.execution_targets.length,2)
  await click('查询版本确认状态');assert.equal(confirmations.length,0)
  await click('核对并确认当前版本');await wait(`document.querySelector('[aria-label="完整团队配置"]')`)
  assert.equal(await page.evaluate(`document.querySelector('[aria-label="完整团队配置"]').closest('details').open`),false)
  assert.match(await page.evaluate(`document.body.innerText`),/Backend → Codex \/ gpt-6-astra/)
  assert.match(await page.evaluate(`document.body.innerText`),/工作区：\/fixture\/project/)
  assert.equal(await page.evaluate(`document.body.innerText.includes('原 Builder：builder')`),false)
  assert.deepEqual(JSON.parse(await page.evaluate(`document.querySelector('[aria-label="完整团队配置"]').textContent`)),team.spec)
  await click('取消');assert.equal(confirmations.length,0)
  await click('核对并确认当前版本');await click('确认此版本配置');await wait(`document.body.innerText.includes('确认结果尚未核实')`)
  assert.equal(confirmations.length,1)
  await page.evaluate(`location.reload()`)
  await wait(`document.querySelector('[data-sidebar-row=team] [data-row-title]')`);await page.evaluate(`document.querySelector('[data-sidebar-row=team] [data-row-title]').click()`)
  await click('SuperAgent 设置');await wait(`document.body.innerText.includes('核对原确认请求')`)
  assert.equal(confirmations.length,1)
  await click('查询版本确认状态');assert.equal(confirmations.length,1)
  await click('核对原确认请求');await click('恢复原确认请求');await wait(`document.body.innerText.includes('当前 v3 已获确认')`)
  assert.deepEqual(confirmations[0],confirmations[1]);assert.equal(confirmations[0].expected_revision,3);assert.deepEqual(confirmations[0].spec,team.spec)
 }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true})}
})
