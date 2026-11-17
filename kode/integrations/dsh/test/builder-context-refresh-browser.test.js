/** Real React/Modal and IndexedDB, isolated fake owner API; no model or user data. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessBrowser } from './support/headless-browser.js'
import { collabRenderPage } from './support/collab-render-page.js'

test('latest draft confirmation cancels, withdraws drift, double-clicks once, and keeps original selection', {skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:90000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'kode-context-refresh-ui-'));let browser,server
 const draft={id:'draft',home_hub:'home',revision:2},selection={provider:'kode-agent-selected',model:'chosen-model',reasoningEffort:'high'}
 const binding={session_id:'source',initial_selection:selection,location:{kind:'private_planning'}}
 const scope={home_hub:'home',draft_id:'draft',session_id:'source',context_epoch:1,draft_revision:2,source_draft_revision:1,context_sha256:'a'.repeat(64),latest_context_sha256:'b'.repeat(64),state:'active'}
 let current={...scope};const posts=[]
 const json=(res,value)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value))}
 try{
  const result=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {PlanningContextRefresh} from './packages/collab/builder-planning-handoff-entry.js';import {createOutboxStorage} from './packages/collab/outbox-storage.js';
   const node=document.createElement('div');node.id='refresh-test';document.body.append(node);const root=createRoot(node),storage=createOutboxStorage();window.refreshTest={ready:[]};
   root.render(React.createElement(PlanningContextRefresh,{draft:${JSON.stringify(draft)},binding:${JSON.stringify(binding)},storage,controls:fixture.ctx.get('kodeAgentControls'),onReady:r=>refreshTest.ready.push(r)}));`,resolveDir:process.cwd()},bundle:true,format:'iife',platform:'browser',external:['react','react-dom','react-dom/client','@deepseek-ai/dsh-client-ui-primitives','@kode/dsh-composer'],write:false,banner:{js:'const require=name=>window.__KODE_TEST_MODULES__[name];'}})
  server=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://localhost')
   if(url.pathname==='/context-test.js'){res.setHeader('content-type','text/javascript');return res.end(result.outputFiles[0].text)}
   if(url.pathname==='/api/kode/agent-hub'){
    if(req.method!=='POST')return json(res,{planning_handoff:current})
    let body='';for await(const c of req)body+=c;const command=JSON.parse(body);posts.push(command)
    if(command.action==='prepare-handoff')return json(res,{kind:'planning',automatic_input:false,execution_authorized:false,prepared:{action:'handoff',sessionId:'source',profileId:'selected',selection:{model:'chosen-model',reasoningEffort:'high'},planning:{draft_id:'draft',source_epoch:1,draft_revision:2,source_context_sha256:current.context_sha256,target_profile_revision:'f'.repeat(64),refresh_context:{source_draft_revision:1,target_context_sha256:current.latest_context_sha256}}}})
    return json(res,{version:1,mode:'interactive_planning',kind:'planning',state:'ready',home_hub:'home',draft_id:'draft',session_id:'successor',context_epoch:2,disposition:'fresh',initial_selection:selection,source_session_id:'source',source_epoch:1,request_id:command.requestId,automatic_input:false,execution_authorized:false})
   }
   if(await collabRenderPage(req,res))return
   res.writeHead(503);res.end('{}')
  });server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,join(profile,'chrome'));const page=await browser.page(`http://127.0.0.1:${server.address().port}/`)
  await page.evaluate(`new Promise((resolve,reject)=>{const run=()=>{if(!window.fixture)return setTimeout(run,20);const s=document.createElement('script');s.src='/context-test.js';s.onload=resolve;s.onerror=reject;document.head.append(s)};run()})`)
  const button=text=>`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled)`
  const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,20))}throw Error('refresh timeout '+document.body.innerText)})()`)
  const click=async text=>{await wait(button(text));await page.evaluate(`${button(text)}.click()`)}
  await click('按最新草案继续规划');await click('取消');assert.equal(posts.length,0)
  await click('按最新草案继续规划');await click('准备交接');await wait(button('确认按最新草案继续'))
  const text=await page.evaluate(`document.querySelector('[role=dialog]').innerText`)
  assert.match(text,/确认后会保留当前 Agent 与模型/);assert.doesNotMatch(text,/更换 Agent|选择目标 Agent/);assert.match(text,/草案第 1 版更新为第 2 版/);assert.ok(text.includes(scope.context_sha256)&&text.includes(scope.latest_context_sha256));assert.match(text,/不获得团队工作区文件访问权限/)
  assert.equal(posts[0].refreshContext,true);assert.equal(posts[0].profileId,'selected');assert.deepEqual(posts[0].selection,{model:'chosen-model',reasoningEffort:'high'})
  current={...scope,latest_context_sha256:'c'.repeat(64)}
  await click('确认按最新草案继续');await wait(`document.querySelector('[role=dialog]')?.innerText.includes('确认已撤回')`)
  assert.equal(posts.filter(p=>p.action==='handoff').length,0)
  await click('取消');current={...scope}
  await click('按最新草案继续规划');await click('准备交接');await wait(button('确认按最新草案继续'))
  await page.evaluate(`{const b=${button('确认按最新草案继续')};b.click();b.click()}`)
  await wait('refreshTest.ready.length===1')
  assert.equal(posts.filter(p=>p.action==='handoff').length,1)
  assert.deepEqual(posts.at(-1).selection,{model:'chosen-model',reasoningEffort:'high'})
  assert.equal(posts.at(-1).planning.refresh_context.target_context_sha256,scope.latest_context_sha256)
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await rm(profile,{recursive:true,force:true})}
})
