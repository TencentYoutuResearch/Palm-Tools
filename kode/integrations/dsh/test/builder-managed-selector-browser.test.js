import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {headlessBrowser} from './support/headless-browser.js'
import {collabRenderPage} from './support/collab-render-page.js'
test('builder selector admits only explicit eligible profiles and binds managed model requests to the profile revision',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:60000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'kode-builder-selector-'));let browser,server;const posts=[]
 try{
 const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {BuilderSelectionForm} from './packages/collab/builder-selection-form.js';import {BuilderControlsContext} from './packages/collab/builder-controls.js';
 const revision='a'.repeat(64),otherRevision='b'.repeat(64),draft={id:'draft-safe',home_hub:'local-home',revision:1,interview:{workspace_refs:[{host_id:'local-home',workspace_id:'project',root_ref:'/fixture'}]}};
 const base={host:'local-home',resource_kind:'execution_profile',runtime_available:true,executor_type:'codex'};
 const safe={...base,builder_selection_eligible:true,managed_roles:['builder'],managed_route_registered:true};
 const rows=[{...base,profile_id:'ordinary',name:'Ordinary native'},{...safe,profile_id:'worker',name:'Worker only',managed_roles:['worker'],managed_provider_id:'worker-route',profile_revision:revision},{...safe,profile_id:'codex-safe',name:'Safe Codex',managed_provider_id:'codex-route',profile_revision:revision},{...safe,executor_type:'claude',profile_id:'claude-safe',name:'Safe Claude',managed_provider_id:'claude-route',profile_revision:otherRevision},{...base,executor_type:'dsh',profile_id:'dsh-unapproved',name:'Unapproved DSH'},{...base,executor_type:'dsh',profile_id:'dsh-safe',name:'Approved DSH',builder_selection_eligible:true},{host:'local-home',resource_kind:'official_loop_provider',provider_id:'official-route',name:'Official',route_registered:true}].map((r,i)=>({...r,cursor:String(i+1).padStart(2,'0')}));
 window.builderSelector={requests:[],badScope:false,binding:null};const request=async path=>{builderSelector.requests.push(path);const url=new URL(path,location.origin);if(url.pathname.endsWith('/selection'))return {home_hub:draft.home_hub,draft_id:draft.id,eligible_for_execution:false,record:null,runtime_binding:builderSelector.binding};if(url.pathname.endsWith('/resource-coverage'))return {host:draft.home_hub,items:rows,next_cursor:null};if(url.pathname.endsWith('/default-selection'))return {home_hub:draft.home_hub,draft_id:draft.id,draft_revision:1,eligible_for_execution:false,state:'unavailable'};if(url.pathname.endsWith('/models')){const p=url.searchParams.get('profile_id'),model=url.searchParams.get('model');const scope={home_hub:draft.home_hub,provider:url.searchParams.get('provider'),profile_id:p,profile_revision:builderSelector.badScope?'c'.repeat(64):url.searchParams.get('profile_revision'),eligible_for_dispatch:false};return model?{...scope,item:{id:model,reasoning:{efforts:[{id:'high',name:'High'}]}}}:{...scope,items:[{id:p+'-model',name:p+' model'}]}}throw Error('Unexpected request')};
 const root=document.createElement('div');root.id='builder-selector-test';root.style='position:fixed;inset:0;background:white;z-index:99999';document.body.append(root);const mounted=createRoot(root);let generation=0;builderSelector.remount=()=>mounted.render(React.createElement(BuilderControlsContext.Provider,{value:fixture.ctx.get('kodeAgentControls')},React.createElement(BuilderSelectionForm,{key:++generation,draft,request,storage:{read:async()=>null}})));builderSelector.remount();`,resolveDir:process.cwd()},bundle:true,format:'iife',platform:'browser',external:['react','react-dom/client','@deepseek-ai/dsh-client-ui-primitives'],write:false,banner:{js:'const require=name=>window.__KODE_TEST_MODULES__[name];'}})
 server=createServer(async(req,res)=>{if(req.method==='POST')posts.push(req.url);if(req.url==='/selector.js'){res.setHeader('content-type','text/javascript');res.end(bundle.outputFiles[0].text);return}if(await collabRenderPage(req,res))return;res.writeHead(404);res.end()});server.listen(0,'127.0.0.1');await once(server,'listening')
 browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page(`http://127.0.0.1:${server.address().port}/`)
 await page.evaluate(`new Promise((resolve,reject)=>{const run=()=>{if(!window.fixture)return setTimeout(run,20);const s=document.createElement('script');s.src='/selector.js';s.onload=resolve;s.onerror=reject;document.head.append(s)};run()})`)
 const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,20))}throw Error('Builder selector timeout: '+document.querySelector('#builder-selector-test')?.textContent)})()`)
 const menu = async text => {await wait(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).some(e=>e.textContent.includes(${JSON.stringify(text)}))`);await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).find(e=>e.textContent.includes(${JSON.stringify(text)})).click()`)}
 const close=async()=>{await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'})}
 const agent=async name=>{await close();await page.evaluate(`document.querySelector('#builder-selector-test button[aria-label^="Agent："]').click()`);await menu(name)}
 const model=async name=>{await close();await page.evaluate(`document.querySelector('#builder-selector-test button[aria-label^="模型："]').click()`);await menu('模型');await menu(name);await close()}
 await wait(`document.querySelector('#builder-selector-test button[aria-label^="Agent："]')?.disabled===false`)
 await page.evaluate(`document.querySelector('#builder-selector-test button[aria-label^="Agent："]').click()`)
 await wait(`document.querySelector('[role=menuitem]')`)
 const labels=await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).map(e=>e.textContent)`)
 assert.ok(labels.some(s=>s.includes('Safe Codex')));assert.ok(labels.some(s=>s.includes('Safe Claude')));assert.ok(!labels.some(s=>/Ordinary|Worker only|Unapproved/.test(s)))
 await menu('Safe Codex');await wait(`builderSelector.requests.some(s=>s.includes('profile_id=codex-safe'))`)
 await model('codex-safe model')
 await wait(`builderSelector.requests.some(s=>s.includes('model=codex-safe-model'))`)
 await agent('Safe Claude');await wait(`builderSelector.requests.some(s=>s.includes('profile_id=claude-safe'))`)
 assert.ok(await page.evaluate(`document.querySelector('#builder-selector-test button[aria-label^="模型："]').textContent.includes('选择模型')`))
 const queries=await page.evaluate(`builderSelector.requests.filter(path=>path.startsWith('/api/kode/builder/models?'))`)
 assert.ok(queries.length>=3)
 for(const path of queries){const q=new URL(path,'http://fixture').searchParams;const id=q.get('profile_id');assert.ok(['codex-safe','claude-safe'].includes(id));assert.equal(q.get('provider'),id==='codex-safe'?'codex-route':'claude-route');assert.equal(q.get('profile_revision'),(id==='codex-safe'?'a':'b').repeat(64))}
 await page.evaluate(`builderSelector.badScope=true`)
 await agent('Safe Codex')
 await wait(`document.querySelector('#builder-selector-test [role=status]')?.textContent.includes('模型目录暂不可用')`)
 assert.equal(await page.evaluate(`document.querySelector('#builder-selector-test button[type=submit]').disabled`),true)
 await page.evaluate(`builderSelector.binding={state:'started_or_occupied',profile_id:'codex-safe',selection_snapshot:{selection:{profile_id:'codex-safe',provider:'codex-route',model:'recorded-model',workspace:null}}};builderSelector.remount()`)
 await wait(`document.querySelector('#builder-selector-test button[aria-label^="Agent："]')?.disabled===true`)
 assert.ok(await page.evaluate(`document.querySelector('#builder-selector-test button[aria-label^="模型："]').textContent.includes('recorded-model')`))
 assert.ok(await page.evaluate(`document.querySelector('#builder-selector-test').textContent.includes('不支持运行中切换模型')`))
 await page.evaluate(`builderSelector.binding={state:'legacy_conflict',binding_count:2};builderSelector.remount()`)
 await wait(`document.querySelector('#builder-selector-test').textContent.includes('多个旧运行绑定')`)
 assert.ok(!(await page.evaluate(`document.querySelector('#builder-selector-test').textContent`)).includes('recorded-model'))
 assert.equal(posts.length,0,'shared picker never mutates an ordinary or fake session')
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await rm(profile,{recursive:true,force:true})}
})
