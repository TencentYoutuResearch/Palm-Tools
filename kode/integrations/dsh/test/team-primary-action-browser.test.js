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
for(const existing of [false,true])test(`team action reuses native seat and only opens drafts (existing team=${existing})`,{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:60000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'kode-team-primary-'));let browser,server;const posts=[]
 try{
 const bundle=await build({entryPoints:['packages/collab/client-source.js'],bundle:true,loader:{'.png':'dataurl'},format:'cjs',platform:'browser',external:['react','react-dom','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives','@kode/dsh-composer'],write:false})
 const client=`window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}},exports=module.exports;${bundle.outputFiles[0].text};return module.exports}})`
 const team={id:'existing',superagent_id:'existing-agent',conversation_id:'dm',home_hub:'home',spec:{name:'Existing team',kind:'coordinator'},contact:{preference:{revision:0,pinned:false,archived:false,archived_through_sequence:0},archived:false,needs_attention:false,latest_sequence:0,unread_count:0,last_activity_at:0,attention:{decisions:0,resources:0,stopping:0,active_runs:0}}}
 server=createServer(async(req,res)=>{const url=new URL(req.url,'http://fixture');const send=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value))};if(req.method==='POST'){posts.push(url.pathname);res.writeHead(403);res.end('{}');return}if(url.pathname==='/fixture-collab.js'){res.setHeader('content-type','text/javascript');res.end(client);return}if(url.pathname==='/api/kode/collab/teams')return send({home_hub:'home',projection:'contact_directory',archived:false,order:'pinned_attention_unread_recent',items:existing?[team]:[],next_cursor:null});if(url.pathname==='/api/kode/builder/drafts')return send({home_hub:'home',items:[],next_cursor:null});if(await collabRenderPage(req,res,{workspaces:existing?[{workspaceId:'project',title:'Existing project',path:'/fixture/project',sessionIds:[],createdAt:new Date().toISOString()}]:[]}))return;res.writeHead(503);res.end('{}')});server.listen(0,'127.0.0.1');await once(server,'listening')
 browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page(`http://127.0.0.1:${server.address().port}/`)
 const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+12000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('Team action timeout: '+document.body.innerText+' '+JSON.stringify(window.fixtureErrors))})()`)
 const switchMode=async label=>{await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`);await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes(${JSON.stringify(label)}))`);await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes(${JSON.stringify(label)})).click()`)}
 await wait(`globalThis.fixture`);await wait(`document.querySelector('button[aria-label="新建会话"]')`)
 const native=await page.evaluate(`(()=>{const b=document.querySelector('button[aria-label="新建会话"]'),r=b.getBoundingClientRect();return {className:b.className,parent:b.parentElement.className,icon:b.querySelector('svg')?.outerHTML,x:r.x,y:r.y,w:r.width,h:r.height}})()`)
 await switchMode('协作');await wait(`document.querySelector('button[aria-label="创建团队"]')`)
 const teamButton=await page.evaluate(`(()=>{const b=document.querySelector('button[aria-label="创建团队"]'),r=b.getBoundingClientRect();return {className:b.className,parent:b.parentElement.className,icon:b.querySelector('svg')?.outerHTML,x:r.x,y:r.y,w:r.width,h:r.height,shortcut:b.getAttribute('aria-keyshortcuts')}})()`)
 for(const key of ['className','parent','icon'])assert.equal(teamButton[key],native[key],key)
 for(const key of ['x','y','w','h'])assert.ok(Math.abs(teamButton[key]-native[key])<2,`${key}: native ${native[key]} team ${teamButton[key]}`)
 assert.equal(teamButton.shortcut,null)
 await page.evaluate(`fixture.ctx.layout.selectPanel('kode-collab')`)
 await wait(`document.querySelector('.kode-collab-empty button')?.textContent==='创建团队'`)
 await page.evaluate(`document.querySelector('.kode-collab-empty button').click()`)
 await wait(`document.querySelector('.kode-collab-builder-create [role=textbox][contenteditable=true]')`)
 await page.evaluate(`fixture.ctx.layout.selectPanel('kode-discussions')`)
 await page.evaluate(`document.querySelector('button[aria-label="创建团队"]').click()`)
 await wait(`document.querySelector('.kode-collab-builder-create [role=textbox][contenteditable=true]')`)
 assert.deepEqual(posts,[])
 // Both empty Main and ChannelHome reuse the same builder route, even with a team already present.
 await page.evaluate(`fixture.ctx.layout.selectPanel('kode-discussions')`)
 await wait(`document.querySelector('.kode-discussion-home button')?.textContent==='创建团队'`)
 await page.evaluate(`document.querySelector('.kode-discussion-home button').click()`)
 await wait(`document.querySelector('.kode-collab-builder-create [role=textbox][contenteditable=true]')`)
 await switchMode('会话');await wait(`document.querySelector('button[aria-label="新建会话"]')`)
 assert.equal(await page.evaluate(`document.querySelector('button[aria-label="新建会话"]').className`),native.className)
 await switchMode('协作');await page.evaluate(`document.querySelector('button[aria-label="收起侧边栏"]').click()`)
 await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:600,y:500});await wait(`document.querySelector('button[aria-label="创建团队"]').getBoundingClientRect().width<50`)
 const pos=await page.evaluate(`(()=>{const b=document.querySelector('button[aria-label="创建团队"]'),r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,label:b.getAttribute('aria-label'),shortcut:b.getAttribute('aria-keyshortcuts')}})()`)
 assert.equal(pos.label,'创建团队');assert.equal(pos.shortcut,null)
 await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:pos.x,y:pos.y});await page.evaluate(`document.querySelector('button[aria-label="创建团队"]').focus()`)
 await wait(`Array.from(document.querySelectorAll('[role=tooltip]')).some(t=>t.textContent.includes('创建团队'))`)
 const tip=await page.evaluate(`Array.from(document.querySelectorAll('[role=tooltip]')).find(t=>t.textContent.includes('创建团队')).textContent`)
 assert.equal(tip.trim(),'创建团队')
 await page.evaluate(`document.querySelector('button[aria-label="创建团队"]').click()`)
 await wait(`document.querySelector('.kode-collab-builder-create [role=textbox][contenteditable=true]')`)
 assert.deepEqual(posts,[]);assert.equal(await page.evaluate(`fixture.created()`),0);assert.deepEqual(await page.evaluate(`fixtureErrors`),[])
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await rm(profile,{recursive:true,force:true})}
})
