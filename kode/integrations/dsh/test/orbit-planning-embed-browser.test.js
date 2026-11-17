/** Orbit Team Builder DM hosts the real planning Session in place: collab Main →
 * standard SessionProvider → kode.orbit.planning → conversation.content (embedded).
 * Released client Session stack; only the Remote RPC namespace is a fixture. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {collabRenderPage} from './support/collab-render-page.js'
import {headlessBrowser} from './support/headless-browser.js'

const SID='native-planning-session',home='home',ref={host_id:home,workspace_id:'project',root_ref:'/fixture/kode'}
const goal='为 Kode 组建一个实现、评审和验证互相协作的团队，先在规划会话里讨论角色分工。'
const draft={id:'7c0b1f8e-0d55-4b1c-9a51-1d3f3f8a2e10',home_hub:home,request_id:'create-1',revision:2,status:'draft',eligible_for_execution:false,interview:{purpose:goal,questions:[],answers:{},workspace_refs:[ref]}}
const receipt=extra=>({version:1,state:'ready',mode:'interactive_planning',home_hub:home,draft_id:draft.id,context_epoch:1,session_id:SID,workspace_id:'project',cwd:'/fixture/kode',disposition:'recovered',initial_selection:{provider:'kode-agent-claude',model:'opus-5.5'},execution_authorized:false,...extra})
const bundle=await build({entryPoints:['packages/collab/client-source.js'],bundle:true,loader:{'.png':'dataurl'},format:'cjs',platform:'browser',external:['react','react-dom','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives','@kode/dsh-composer'],write:false})
const client=`window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}},exports=module.exports;${bundle.outputFiles[0].text};return module.exports}})`
const workspaces=[{workspaceId:'project',title:'Kode',path:'/fixture/kode',sessionIds:[SID],createdAt:new Date(1700000000000).toISOString()}]

/** Real Orbit Main over the released client Session stack; `scenario` drives it. `routes` may answer a request first. */
const orbit=(scenario,routes)=>async()=>{
 const profile=await mkdtemp(join(tmpdir(),'kode-orbit-planning-'));let server,browser
 const posts=[]
 const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))}
 try{
  server=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://localhost')
   if(url.pathname==='/fixture-collab.js'){res.setHeader('content-type','text/javascript');res.end(client);return}
   if(req.method!=='POST'&&routes&&await routes({method:'GET',url,res,json}))return
   if(req.method==='POST'){
    let body='';for await(const chunk of req)body+=chunk
    // A pasted file's upload body is not JSON: record it and leave it in flight, so the draft keeps an upload pending.
    let command;try{command=JSON.parse(body)}catch{posts.push({path:url.pathname,upload:true});return}
    posts.push({path:url.pathname,body:command})
    if(routes&&await routes({method:'POST',url,body:command,res,json}))return
    if(url.pathname==='/api/kode/builder/planning')return json(res,200,receipt())
    return json(res,503,{})
   }
   if(url.pathname==='/api/kode/collab/teams')return json(res,200,{home_hub:home,projection:'contact_directory',archived:false,order:'pinned_attention_unread_recent',items:[],next_cursor:null})
   if(url.pathname==='/api/kode/agents')return json(res,200,{profiles:[{id:'tclaude',name:'tclaude',type:'claude',origin:'builtin'}],selectedProfileId:'tclaude',supportedTypes:['claude'],models:[{id:'opus-5.5',name:'Opus 5.5'}],defaultModelSelection:{model:'opus-5.5'}})
   if(url.pathname==='/api/kode/builder/drafts'){
    if(url.searchParams.has('draft_id'))return url.searchParams.get('draft_id')===draft.id?json(res,200,draft):json(res,404,{})
    return json(res,200,{home_hub:home,items:[{id:draft.id,revision:draft.revision,purpose:goal,status:'draft'}],next_cursor:null})
   }
   if(url.pathname==='/api/kode/builder/planning')return json(res,200,receipt())
   if(await collabRenderPage(req,res,{workspaces,nativeSession:{id:SID,cwd:'/fixture/kode',createdAt:1700000000000,updatedAt:1700000000000,
    modelCatalog:{default:{provider:'tclaude',model:'opus-5.5'},routableProviders:['tclaude'],groups:[{id:'tclaude',name:'tclaude',models:[{id:'opus-5.5',name:'Opus 5.5'},{id:'sonnet-5.5',name:'Sonnet 5.5'}]}],failures:[]},
    projections:{modelSelection:{lastUsed:null,next:{provider:'tclaude',model:'opus-5.5'}}}}}))return
   json(res,404,{})
  });server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page(`http://127.0.0.1:${server.address().port}`)
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
  const wait=(expr,ms=12000)=>page.evaluate(`(async()=>{const end=Date.now()+${ms};while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('Orbit planning timeout: '+${JSON.stringify(expr)}+' '+JSON.stringify({errors:window.fixtureErrors,console:window.consoleErrors?.slice(-4),wire:window.nativeWire?.calls,main:document.querySelector('#fixture-main')?.innerText.slice(0,600)}))})()`)
  const shots=process.env.KODE_ARTIFACT_DIR??resolve('../../../artifacts/builder-conversation-redesign-20261110');await mkdir(shots,{recursive:true})
  const shot=async name=>writeFile(join(shots,name),Buffer.from((await page.call('Page.captureScreenshot',{format:'png'})).data,'base64'))
  const clickText=text=>page.evaluate(`Array.from(document.querySelectorAll('#fixture-main button')).find(b=>b.textContent===${JSON.stringify(text)}).click()`)
  const embedded=`document.querySelector('[data-planning-session] [data-conversation-session]')`
  const composers=`document.querySelectorAll('[data-conversation-session=${JSON.stringify(SID)}] [role=textbox][contenteditable=true]').length`
  // One shell editor per Session: the composer whose element is that editor's root (test-only Lexical probe).
  const rootHolder=`(()=>{const rows=Array.from(document.querySelectorAll('[data-conversation-session=${JSON.stringify(SID)}] [data-composer-input]')).filter(el=>el.__lexicalEditor?.getRootElement()===el);return rows.length===1?(rows[0].closest('[data-planning-session]')?'orbit':rows[0].closest('[data-fixture-rightbar]')?'sidebar':'main'):rows.length})()`
  const enterCollaboration=async()=>{await wait(`document.querySelector('.kode-collab-mode-switch button')`);if(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').getAttribute('aria-label').includes('会话')`)){await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`);await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`);await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)}}
  const openPlanning=async(settledWhen=`${embedded}&&${composers}===1`)=>{
   await wait(`document.querySelector('[aria-label="私信 Team Builder"]')`);await page.evaluate(`document.querySelector('[aria-label="私信 Team Builder"]').click()`)
   await wait(`document.querySelector('#fixture-main button[aria-label="团队规划记录"]:not([disabled])')`)
   await page.evaluate(`document.querySelector('#fixture-main button[aria-label="团队规划记录"]').click()`)
   await wait(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).some(b=>b.textContent.includes('为 Kode 组建'))`)
   await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).find(b=>b.textContent.includes('为 Kode 组建')).click()`)
   await wait(`document.querySelector('#fixture-main [data-planning-state="ready"]')`)
   await clickText('打开规划会话')
   await wait(settledWhen)
  }

  await wait(`window.fixture`)
  await enterCollaboration()
  await scenario({page,wait,shot,clickText,embedded,composers,rootHolder,openPlanning,posts})
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await rm(profile,{recursive:true,force:true})}
}

test('Orbit hosts the real planning Session in the Team Builder DM without switching to session mode',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:90000},orbit(async({page,wait,shot,clickText,embedded,composers,rootHolder,openPlanning,posts})=>{
  await openPlanning()
  assert.equal(await page.evaluate(rootHolder),'orbit')
  // The real native occurrence: ui-conversation's own data-conversation-session is the receipt id.
  assert.equal(await page.evaluate(`${embedded}.getAttribute('data-conversation-session')`),SID)
  assert.deepEqual(await page.evaluate(`nativeRetains.filter(r=>r.source==='kodeOrbitPlanning').map(r=>r.id)`),[SID],'one Orbit reference; native seats (e.g. commandCatalog) add their own')
  assert.ok(await page.evaluate(`nativeRetains.every(r=>r.id===${JSON.stringify(SID)})`))
  assert.ok(await page.evaluate(`nativeWire.calls.some(c=>c[0]==='follow'&&c[1]===${JSON.stringify(SID)})`),'the retained reference opened the real Session event stream')
  assert.equal(await page.evaluate(`fixture.selectedPanel()`),'kode-collab','Orbit stays the active panel')
  assert.deepEqual(await page.evaluate(`nativeOpened`),[],'uiWorkspace.openSession is not called')
  assert.ok(!(await page.evaluate(`nativePanels`)).slice(1).includes(null),'no selectMode(session) / selectPanel(null)')
  assert.equal(await page.evaluate(`document.querySelector('[aria-label="私信 Team Builder"]').getAttribute('aria-current')`),'page','Builder row stays selected in the DM list')
  assert.equal(await page.evaluate(`!!document.querySelector('[data-planning-session] [data-conversation-session] [class*=hero]')`),false,'no hero workspace picker can rebind the draft')
  // Native seats: input, model, attachments come from the released plugins.
  const seats=await page.evaluate(`(()=>{const root=document.querySelector('[data-planning-session]');return {textbox:root.querySelectorAll('[role=textbox][contenteditable=true]').length,buttons:Array.from(root.querySelectorAll('button')).map(b=>b.getAttribute('aria-label')||b.textContent.trim()).filter(Boolean)}})()`)
  assert.equal(seats.textbox,1)
  await wait(`document.querySelector('[data-planning-session] [data-conversation-session] [role=textbox]').textContent.includes(${JSON.stringify(goal)})`)
  assert.deepEqual(await page.evaluate(`nativeWire.prompts`),[],'the goal is offered to the native draft, never sent')
  assert.deepEqual(posts.map(row=>Object.keys(row.body).sort()),[['draft_id','draft_revision','request_id']],'reopen confirms with the minimal request')
  assert.ok(seats.buttons.includes('添加文件或调用指令'),'native attachment/command seat: '+seats.buttons)
  assert.ok(seats.buttons.some(label=>label.startsWith('选择模型，当前 Opus 5.5')),'native model seat follows the Session: '+seats.buttons)
  await shot('orbit-planning-embedded-1440.png')

  // The user's own native draft survives leaving Orbit and coming back.
  await page.evaluate(`(()=>{const box=document.querySelector('[data-planning-session] [role=textbox]');box.focus();const s=getSelection();s.selectAllChildren(box);s.collapseToEnd()})()`)
  await page.call('Input.insertText',{text:' 请先列出评审角色。'})
  await wait(`document.querySelector('[data-planning-session] [role=textbox]').textContent.includes('请先列出评审角色。')`)
  await page.evaluate(`fixture.ctx.layout.selectPanel('plugins')`)
  await wait(`!document.querySelector('[data-planning-session]')&&nativeRetains.every(r=>r.released)`)
  assert.equal(await page.evaluate(composers),0,'no composer stays mounted for the Session outside Orbit')
  await page.evaluate(`fixture.ctx.layout.selectPanel('kode-collab')`)
  await openPlanning()
  assert.equal(await page.evaluate(`nativeRetains.filter(r=>!r.released&&r.source==='kodeOrbitPlanning').length`),1)
  await wait(`document.querySelector('[data-planning-session] [role=textbox]').textContent.includes('请先列出评审角色。')`)
  assert.equal(await page.evaluate(composers),1)
  assert.deepEqual(await page.evaluate(`nativeOpened`),[])
  await page.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true})
  // Narrow window: the sidebar is a closed drawer; Orbit's main column is what remains.
  await page.evaluate(`document.head.insertAdjacentHTML('beforeend','<style id=narrow-drawer>#fixture-frame{grid-template-columns:minmax(0,1fr)!important}#fixture-frame>:not(main){display:none!important}</style>')`)
  await wait(`${embedded}`)
  assert.ok(await page.evaluate(`(()=>{const n=document.querySelector('[data-planning-session]');return n.scrollWidth<=n.clientWidth+1})()`),'no horizontal overflow at 390')
  await shot('orbit-planning-embedded-390.png')
  assert.ok(await page.evaluate(`Array.from(document.querySelectorAll('.kode-builder-session-bar button')).every(b=>b.getBoundingClientRect().height<=40)`),'bar actions never wrap vertically')
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
  await page.evaluate(`document.getElementById('narrow-drawer').remove()`)

  // Explicit opt-out: the embed releases first, then the native session mode owns the only composer.
  await clickText('在会话模式打开')
  await wait(`nativeOpened.length===1&&nativeRetains.filter(r=>r.source==='kodeOrbitPlanning').every(r=>r.released)`)
  assert.deepEqual(await page.evaluate(`nativeOpened`),[SID])
  assert.equal(await page.evaluate(`!!document.querySelector('[data-planning-session]')`),false)
  await wait(`${composers}===1&&document.querySelector('[data-conversation-session=${JSON.stringify(SID)}] [role=textbox]').textContent.includes('请先列出评审角色。')`)
  assert.ok(await page.evaluate(`nativeRetains.some(r=>r.source==='mainView'&&!r.released)`),'session mode now owns the only writer')
  assert.equal(await page.evaluate(rootHolder),'main','Orbit unmounted before session mode bound the editor root')
  await shot('orbit-planning-session-mode-1440.png')
  assert.deepEqual(await page.evaluate(`window.fixtureErrors`),[])
}))

test('A failed native fill stays pending until an explicit retry, and a second writer never gets a second composer',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:90000},orbit(async({page,wait,shot,clickText,embedded,composers,rootHolder,openPlanning})=>{
  const status=`document.querySelector('#fixture-main .kode-builder-embed-status')`
  const live=`nativeRetains.filter(r=>r.source==='kodeOrbitPlanning'&&!r.released).length`
  const draftText=`(document.querySelector('[data-planning-session] [role=textbox]')?.textContent??'')`
  const failedFill=`!!${status}?.textContent.includes('目标未能填入')&&${live}===0&&!document.querySelector('[data-planning-session]')`
  const settle=()=>page.evaluate(`new Promise(r=>setTimeout(r,400))`)

  // input_unavailable (no binding for offerPlanningText), a throw and the native 'blocked' result:
  // each releases the reference at once, keeps the goal pending and offers only an explicit retry.
  await page.evaluate(`fixtureFill.push('unbound','throw','blocked')`)
  await openPlanning(failedFill)
  assert.deepEqual(await page.evaluate(`nativeWire.faults`),['unbound'])
  assert.equal(await page.evaluate(composers),0)
  assert.ok(await page.evaluate(`nativeRetains.filter(r=>r.source==='kodeOrbitPlanning').every(r=>r.released)`),'the failed reference is released')
  await shot('orbit-planning-fill-failed-1440.png')
  await clickText('重试填入');await wait(`nativeWire.faults.length===2&&${failedFill}`)
  await clickText('重试填入');await wait(`nativeWire.faults.length===3&&${failedFill}`)
  assert.deepEqual(await page.evaluate(`nativeWire.faults`),['unbound','throw','blocked'])
  assert.deepEqual(await page.evaluate(`nativeWire.inits.map(o=>[o.whenDraftExists,o.prompt])`),[['keep',goal],['keep',goal]],'every retry offers the same pending goal with keep')
  assert.equal(await page.evaluate(`fixture.selectedPanel()`),'kode-collab')

  // The local record of an applied fill fails to persist: the native draft keeps the goal,
  // the user is told, and nothing is filled a second time.
  await page.evaluate(`(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...rest){if(String(value?.key).includes('builder-planning-goal-offered'))throw new DOMException('fixture quota','QuotaExceededError');return put.call(this,value,...rest)}})()`)
  await clickText('重试填入')
  await wait(`${embedded}&&${composers}===1&&${draftText}.includes(${JSON.stringify(goal)})`)
  await wait(`document.querySelector('#fixture-main').textContent.includes('本地记录未能保存')`)
  const inits=await page.evaluate(`nativeWire.inits.length`)
  await settle()
  assert.equal(await page.evaluate(`nativeWire.inits.length`),inits,'a persistence failure never re-fills')
  assert.equal(await page.evaluate(live),1)

  // The user's own draft exists: reopening offers the still-unrecorded goal with keep, and the native input preserves it.
  await page.evaluate(`(()=>{const box=document.querySelector('[data-planning-session] [role=textbox]');box.focus();const s=getSelection();s.selectAllChildren(box);s.collapseToEnd()})()`)
  await page.call('Input.insertText',{text:' 补充：先列评审角色。'})
  await wait(`${draftText}.includes('补充：先列评审角色。')`)
  await page.evaluate(`fixture.ctx.layout.selectPanel('plugins')`)
  await wait(`!document.querySelector('[data-planning-session]')&&${live}===0`)
  await page.evaluate(`fixture.ctx.layout.selectPanel('kode-collab')`)
  await openPlanning()
  await wait(`document.querySelector('#fixture-main').textContent.includes('已有未发送内容，没有覆盖')`)
  assert.deepEqual(await page.evaluate(`nativeWire.inits.at(-1).whenDraftExists`),'keep')
  assert.equal(await page.evaluate(`${draftText}.split(${JSON.stringify(goal)}).length-1`),1,'the goal is never duplicated')
  assert.ok(await page.evaluate(`${draftText}.includes('补充：先列评审角色。')`))

  // A second writer (a right-Sidebar Conversation for the same Session, hidden while a panel is
  // active) already holds the editor: Orbit shows no composer of its own until it is gone.
  await page.evaluate(`fixture.ctx.layout.selectPanel('plugins')`)
  await wait(`${live}===0`)
  await page.evaluate(`fixtureSidebarWriter.publish(true)`)
  await wait(`document.querySelector('[data-fixture-rightbar] [data-conversation-session=${JSON.stringify(SID)}] [role=textbox][contenteditable=true]')`)
  await page.evaluate(`fixture.ctx.layout.selectPanel('kode-collab')`)
  await openPlanning(`!!${status}?.textContent.includes('其他位置编辑')`)
  assert.equal(await page.evaluate(composers),1,'only the Sidebar writer is editable')
  assert.equal(await page.evaluate(rootHolder),'sidebar')
  assert.equal(await page.evaluate(`!!document.querySelector('[data-planning-session]')`),false)
  assert.equal(await page.evaluate(live),0)
  assert.ok(await page.evaluate(`document.querySelector('[data-fixture-rightbar] [role=textbox]').textContent.includes('补充：先列评审角色。')`),'the shared draft is untouched')
  await shot('orbit-planning-writer-elsewhere-1440.png')
  await page.evaluate(`fixtureSidebarWriter.publish(false)`)
  await wait(`!document.querySelector('[data-fixture-rightbar]')`)
  await clickText('重新检查')
  await wait(`${embedded}&&${composers}===1&&${draftText}.includes('补充：先列评审角色。')`)
  assert.equal(await page.evaluate(rootHolder),'orbit')
  assert.equal(await page.evaluate(`${draftText}.split(${JSON.stringify(goal)}).length-1`),1)

  assert.deepEqual(await page.evaluate(`nativeWire.prompts`),[],'nothing is ever sent to the model')
  assert.deepEqual(await page.evaluate(`nativeOpened`),[])
  assert.ok(!(await page.evaluate(`nativePanels`)).includes(null),'never switched to session mode')
  assert.deepEqual(await page.evaluate(`window.fixtureErrors`),[])
}))

test('Patched native composer: a later Sidebar writer keeps its root and file action when Orbit leaves; roots hand back in either order',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:120000},orbit(async({page,wait,shot,clickText,embedded,composers,rootHolder,openPlanning,posts})=>{
  const sid=JSON.stringify(SID)
  const ownBox=`document.querySelector('[data-planning-session] [data-composer-input]')`
  const sideBox=`document.querySelector('[data-fixture-rightbar] [data-composer-input]')`
  const live=`nativeRetains.filter(r=>r.source==='kodeOrbitPlanning'&&!r.released).length`
  // Which view's own native file input the shared Session file action opens (no dialog is shown).
  await page.evaluate(`(()=>{window.pickedBy=[];HTMLInputElement.prototype.click=function(){if(this.type!=='file')return;pickedBy.push(this.closest('[data-planning-session]')?'orbit':this.closest('[data-fixture-rightbar]')?'sidebar':'other')}})()`)
  // Each pick must open exactly one new file input; a stale earlier entry never counts.
  const pick=async()=>page.evaluate(`(()=>{const n=pickedBy.length;fixture.ctx.get('conversation').input.pickFiles(${sid});return pickedBy.length===n+1?pickedBy.at(-1):'none'})()`)
  const typeInto=async(box,text)=>{await page.evaluate(`(()=>{const box=${box};box.focus();const s=getSelection();s.selectAllChildren(box);s.collapseToEnd()})()`);await page.call('Input.insertText',{text});await wait(`${box}.textContent.includes(${JSON.stringify(text)})`)}
  assert.equal(await page.evaluate(`fixtureConversationId`),'@kode/dsh-conversation','the released override built from the reviewed patch is under test')

  // Orbit first.
  await openPlanning()
  await wait(`${ownBox}.textContent.includes(${JSON.stringify(goal)})`)
  assert.equal(await page.evaluate(rootHolder),'orbit')
  assert.equal(await pick(),'orbit')

  // The same Session in a right-Sidebar Conversation: it takes the root and the file action; Orbit's covered copy is inert.
  await page.evaluate(`fixtureSidebarWriter.publish(true)`)
  await wait(`document.querySelector('[data-planning-session][data-writer-yielded][inert]')&&${sideBox}`)
  assert.equal(await page.evaluate(rootHolder),'sidebar')
  assert.equal(await pick(),'sidebar')
  await shot('orbit-planning-writer-yielded-1440.png')
  // Enter and paste on the shared editor answer once, through the root owner's view only: the covered
  // Orbit view registered its keymap first, so its gate would otherwise answer (and toast) for the Sidebar.
  // The Session submit is replaced by a recorder, so nothing is ever sent.
  await page.evaluate(`(()=>{const shell=fixture.ctx.get('conversation').input.shell(${sid});window.submits=[];shell.submit=(...a)=>{submits.push(a)};shell.steerQueue=()=>{submits.push(['steer'])}})()`)
  const caretEnd=box=>`const box=${box};box.focus();const s=getSelection();s.selectAllChildren(box);s.collapseToEnd()`
  const paste=(box,data)=>page.evaluate(`(()=>{${caretEnd(box)};const dt=new DataTransfer();${data};box.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}))})()`)
  // The right rail is mounted but hidden under an active panel, so the keydown goes to its root element directly (Lexical's own root listener).
  const enterOn=box=>page.evaluate(`(()=>{${caretEnd(box)};box.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true,cancelable:true}))})()`)
  const draftText=`fixture.ctx.get('conversation').input.shell(${sid}).snapshot.draft`
  const stillUploading='文件还在上传，请等待上传完成后发送'
  // The Toast is portaled out of its InputBar; its React owner chain names the view that raised it (test-only probe).
  const toastsIn=`(()=>{const rows=Array.from(document.querySelectorAll('body *')).filter(e=>e.children.length===0&&e.textContent===${JSON.stringify(stillUploading)});return rows.map(e=>{let f=e[Object.keys(e).find(k=>k.startsWith('__reactFiber$'))];for(;f;f=f.return)if(f.stateNode instanceof Element){if(f.stateNode.closest('[data-planning-session]'))return 'orbit';if(f.stateNode.closest('[data-fixture-rightbar]'))return 'sidebar'}return 'other'})})()`
  await paste(sideBox,`dt.setData('text/plain','〔粘贴〕')`)
  await wait(`${draftText}.includes('〔粘贴〕')`)
  assert.equal(await page.evaluate(`${draftText}.split('〔粘贴〕').length`),2,'pasted text lands once')
  await enterOn(sideBox)
  await wait(`submits.length>0`)
  assert.deepEqual(await page.evaluate(`submits`),[['queue','enter']],'one Enter, one submit')
  await paste(sideBox,`dt.items.add(new File(['x'],'notes.txt',{type:'text/plain'}))`)
  await wait(`fixture.ctx.get('conversation').input.shell(${sid}).attachmentIds.length===1`)
  await enterOn(sideBox)
  await wait(`${toastsIn}.length>0`)
  assert.deepEqual(await page.evaluate(toastsIn),['sidebar'],'the pending-upload notice belongs to the root owner, never the covered Orbit view')
  assert.equal(await page.evaluate(`submits.length`),1,'Enter with an upload in flight never submits')

  // Leave Orbit for session mode, where the right Sidebar is shown: its root and file action survive Orbit's unmount.
  await page.evaluate(`fixture.ctx.layout.selectPanel(null)`)
  await wait(`!document.querySelector('[data-planning-session]')&&${live}===0&&!document.querySelector('[data-fixture-rightbar]').hidden`)
  assert.equal(await page.evaluate(rootHolder),'sidebar','Orbit leaving never detaches the newer root')
  await typeInto(sideBox,' 右栏补充。')
  assert.equal(await page.evaluate(rootHolder),'sidebar')
  // The visible Sidebar answers real keys alone: remove its pending upload through its own native control, then Enter submits once.
  await page.evaluate(`document.querySelector('[data-fixture-rightbar] button[aria-label="移除文件 notes.txt"]').click()`)
  await wait(`fixture.ctx.get('conversation').input.shell(${sid}).attachmentIds.length===0`)
  for(const type of ['keyDown','keyUp'])await page.call('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,...(type==='keyDown'?{text:'\r'}:{})})
  await wait(`submits.length===2`)
  assert.deepEqual(await page.evaluate(`submits.at(-1)`),['queue','enter'])
  assert.ok(!(await page.evaluate(`${sideBox}.textContent`)).includes('\n'),'Enter never inserted a line break')
  assert.equal(await page.evaluate(`fixture.ctx.get('conversation').input.canPickFiles(${sid})`),true)
  // The native 文件 command through the Sidebar composer's own command seat.
  await page.evaluate(`document.querySelector('[data-fixture-rightbar] button[aria-label="添加文件或调用指令"]').click()`)
  const fileOption=`Array.from(document.querySelectorAll('[role=listbox] [role=option]')).find(b=>b.textContent.trim().startsWith('文件file'))`
  await wait(fileOption)
  const picks=await page.evaluate(`pickedBy.length`)
  const at=await page.evaluate(`(()=>{const r=${fileOption}.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for(const type of ['mouseMoved','mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...at,button:'left',clickCount:1})
  await wait(`pickedBy.length===${picks+1}`)
  assert.equal(await page.evaluate(`pickedBy.at(-1)`),'sidebar')
  await shot('orbit-planning-sidebar-after-leave-1440.png')

  // Reverse order: the Sidebar already writes, so Orbit shows no composer of its own.
  await page.evaluate(`fixture.ctx.layout.selectPanel('kode-collab')`)
  await openPlanning(`!!document.querySelector('#fixture-main .kode-builder-embed-status')?.textContent.includes('其他位置编辑')`)
  assert.equal(await page.evaluate(composers),1)
  assert.equal(await page.evaluate(rootHolder),'sidebar')
  assert.equal(await page.evaluate(live),0)
  assert.equal(await pick(),'sidebar')
  await page.evaluate(`fixtureSidebarWriter.publish(false)`)
  await wait(`!document.querySelector('[data-fixture-rightbar]')`)
  await clickText('重新检查')
  await wait(`${embedded}&&${composers}===1&&${ownBox}.textContent.includes('右栏补充。')`)
  assert.equal(await page.evaluate(rootHolder),'orbit')
  assert.equal(await pick(),'orbit')

  // Orbit first again, then the Sidebar leaves first: native hands the root and file action back without an Orbit remount.
  await page.evaluate(`document.querySelector('[data-planning-session] [data-composer-input]').setAttribute('data-same-node','')`)
  await page.evaluate(`fixtureSidebarWriter.publish(true)`)
  await wait(`document.querySelector('[data-planning-session][data-writer-yielded]')&&${rootHolder}==='sidebar'`)
  await page.evaluate(`fixtureSidebarWriter.publish(false)`)
  await wait(`!document.querySelector('[data-fixture-rightbar]')&&!document.querySelector('[data-planning-session][inert]')&&${rootHolder}==='orbit'`)
  assert.equal(await page.evaluate(`${ownBox}.hasAttribute('data-same-node')`),true,'the same Orbit element regains the root')
  assert.ok(await page.evaluate(`${ownBox}.textContent.includes('右栏补充。')`),'one shared draft survives every hand-back')
  await typeInto(ownBox,' 回到 Orbit。')
  assert.equal(await pick(),'orbit')
  assert.equal(await page.evaluate(composers),1)

  assert.equal(await page.evaluate(`submits.length`),2,'only the two owner Enters reached the (recorded, never sent) Session submit')
  assert.equal(posts.filter(p=>p.upload).length,1,'the one pasted file started one upload')
  assert.deepEqual(await page.evaluate(`nativeWire.prompts`),[],'nothing is ever sent to the model')
  assert.deepEqual(await page.evaluate(`nativeOpened`),[])
  assert.deepEqual(await page.evaluate(`window.fixtureErrors`),[])
}))

test('An existing sidebar Session opens in Orbit’s canvas through the same retained native chain, not session mode',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:90000},orbit(async({page,wait,shot,clickText,composers,rootHolder})=>{
  const row=`document.querySelector('[data-adapted-session-id=${JSON.stringify(SID)}]')`
  const inOrbit=`document.querySelector('[data-orbit-session=${JSON.stringify(SID)}] [data-planning-session] [data-conversation-session=${JSON.stringify(SID)}]')`
  await wait(row)
  await page.evaluate(`${row}.click()`)
  await wait(`${inOrbit}&&${composers}===1`)
  assert.equal(await page.evaluate(`fixture.selectedPanel()`),'kode-collab','Orbit stays the active panel')
  assert.deepEqual(await page.evaluate(`nativeOpened`),[],'native open / uiWorkspace.openSession is not called')
  assert.ok(!(await page.evaluate(`nativePanels`)).slice(1).includes(null),'no selectMode(session) / selectPanel(null)')
  assert.equal(await page.evaluate(rootHolder),'orbit')
  assert.deepEqual(await page.evaluate(`nativeRetains.filter(r=>r.source==='kodeOrbitPlanning').map(r=>r.id)`),[SID])
  assert.ok(await page.evaluate(`nativeWire.calls.some(c=>c[0]==='follow'&&c[1]===${JSON.stringify(SID)})`),'history comes from the real Session event stream')
  assert.equal(await page.evaluate(`${row}.getAttribute('aria-current')`),'page','the sidebar row shows what Orbit is showing')
  assert.equal(await page.evaluate(`document.querySelector('[aria-label="私信 Team Builder"]').getAttribute('aria-current')`),null,'the DM row is not also selected')
  assert.equal(await page.evaluate(`!!document.querySelector('[data-orbit-session] [data-conversation-session] [class*=hero]')`),false,'no hero workspace picker can rebind the Session')
  // Basic chat: the native input takes text into the Session's own draft; nothing is sent here.
  await page.evaluate(`(()=>{const box=document.querySelector('[data-orbit-session] [role=textbox]');box.focus();const s=getSelection();s.selectAllChildren(box);s.collapseToEnd()})()`)
  await page.call('Input.insertText',{text:'继续上次的评审。'})
  await wait(`document.querySelector('[data-orbit-session] [role=textbox]').textContent.includes('继续上次的评审。')`)
  await shot('orbit-existing-session-embedded-1440.png')
  // Changing Agent goes through whatever the Kode plugin registers as 'kode-handoff' on the declared
  // native header-actions slot. This fixture provides Kode facades but does not apply the Kode plugin,
  // so a labelled stand-in occupies that registration; the real HandoffMenu modal is not exercised here.
  await page.evaluate(`(()=>{window.handoffProps=[];const React=globalThis.__KODE_TEST_MODULES__.react;fixture.ctx.slots.register({name:'conversation.session.header.actions',id:'kode-handoff',order:100,inject:sessionId=>({sessionId,sessions:fixture.ctx.sessions})},props=>{handoffProps.push({sessionId:props.sessionId,sessions:!!props.sessions});return React.createElement('button',{type:'button',className:'kode-handoff-trigger'},'交接（测试替身）')})})()`)
  const handoff=`document.querySelector('[data-orbit-session] .kode-builder-topbar .kode-handoff-trigger')`
  await wait(handoff)
  assert.deepEqual(await page.evaluate(`handoffProps.at(-1)`),{sessionId:SID,sessions:true},'the registered handoff entry receives this Session through its own inject')
  await page.evaluate(`${handoff}.click()`)
  assert.deepEqual(await page.evaluate(`nativeOpened`),[],'opening and cancelling handoff navigates nowhere')
  // A DM row returns to the conversation and releases the Session; its draft is the native one and survives.
  await page.evaluate(`document.querySelector('[aria-label="私信 Team Builder"]').click()`)
  await wait(`!document.querySelector('[data-orbit-session]')&&nativeRetains.filter(r=>r.source==='kodeOrbitPlanning').every(r=>r.released)`)
  assert.equal(await page.evaluate(composers),0)
  await page.evaluate(`${row}.click()`)
  await wait(`${inOrbit}&&document.querySelector('[data-orbit-session] [role=textbox]').textContent.includes('继续上次的评审。')`)
  // Explicit opt-out releases first; session mode then owns the only writer.
  await clickText('在会话模式打开')
  await wait(`nativeOpened.length===1&&nativeRetains.filter(r=>r.source==='kodeOrbitPlanning').every(r=>r.released)`)
  await wait(`${composers}===1`)
  assert.equal(await page.evaluate(rootHolder),'main')
  assert.deepEqual(await page.evaluate(`nativeWire.prompts`),[],'nothing is ever sent to the model')
  assert.deepEqual(await page.evaluate(`window.fixtureErrors`),[])
}))

// Builder planning handoff: fixture agent-hub replies only (no live backend, no model). The real
// HandoffMenu / Modal / AgentPicker / ModelPicker occupy the native 'kode-handoff' registration.
const NEW='successor-planning-session',sha='a'.repeat(64)
const hub={scope:{home_hub:home,draft_id:draft.id,session_id:SID,context_epoch:1,draft_revision:2,context_sha256:sha,state:'active'},replies:[],binding:null,hold:null},revision='e'.repeat(64)
const selection={model:'opus-5.5',reasoningEffort:'high',fast:true}
const successorReceipt=(command,extra)=>({version:1,mode:'interactive_planning',kind:'planning',state:'ready',home_hub:home,draft_id:draft.id,session_id:NEW,context_epoch:2,disposition:'fresh',
 initial_selection:{...command.selection,provider:`kode-agent-${command.profileId}`},source_session_id:SID,source_epoch:1,request_id:command.requestId,automatic_input:false,execution_authorized:false,...extra})
const handoffRoutes=async({method,url,body,res,json})=>{
 if(url.pathname==='/api/kode/agents')return json(res,200,{profiles:[{id:'claude',name:'Claude',type:'claude',origin:'builtin'},{id:'kode-frontend',name:'kode-frontend',type:'claude',origin:'custom'}],selectedProfileId:'claude',canChangeAgent:true,supportedTypes:['claude'],types:{claude:{name:'Claude Code'}},models:[{id:'opus-5.5',name:'Opus 5.5',reasoningEfforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultReasoningEffort:'low',fastCapability:true},{id:'gpt-x',name:'GPT X',reasoningEfforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultReasoningEffort:'low',fastCapability:{transport:'model-variant',fastModelId:'gpt-x-fast',standardModelId:'gpt-x',defaultEnabled:false}},{id:'gpt-x-fast',name:'GPT X Fast',reasoningEfforts:[{id:'low',name:'Low'}],defaultReasoningEffort:'low',fastCapability:{transport:'model-variant',fastModelId:'gpt-x-fast',standardModelId:'gpt-x',defaultEnabled:true}}],defaultModelSelection:{model:'opus-5.5',reasoningEffort:'low'}}),true
 if(url.pathname==='/api/kode/builder/planning'&&hub.binding)return json(res,200,hub.binding),true
 if(url.pathname!=='/api/kode/agent-hub')return false
 if(method==='GET'){const id=url.searchParams.get('session_id');return json(res,200,{planning_handoff:id===SID?hub.scope:id===NEW?{...hub.scope,session_id:NEW,context_epoch:2,state:'active'}:null}),true}
 if(body.action==='prepare-handoff'&&hub.hold)await hub.hold.promise
 if(body.action==='prepare-handoff')return json(res,200,{kind:'planning',automatic_input:false,execution_authorized:false,prepared:{action:'handoff',sessionId:body.sessionId,profileId:body.profileId,selection:body.selection,
  planning:{draft_id:draft.id,source_epoch:hub.scope.context_epoch,draft_revision:hub.scope.draft_revision,source_context_sha256:hub.scope.context_sha256,target_profile_revision:revision}}}),true
 if(body.action!=='handoff')return json(res,400,{}),true
 const reply=hub.replies.shift()
 if(reply==='lost'){res.writeHead(200,{'content-type':'application/json'});res.write('{"kind":');setTimeout(()=>res.socket.destroy(),20);return true}
 if(reply==='409')return json(res,409,{code:'PLANNING_HANDOFF_CONFLICT'}),true
 if(reply==='foreign')return json(res,200,successorReceipt(body,{source_session_id:'another-source'})),true
 if(reply==='same-epoch')return json(res,200,successorReceipt(body,{context_epoch:1})),true
 // Ready: the server now binds the draft to the successor (next epoch) and supersedes the source.
 hub.binding=receipt({session_id:NEW,context_epoch:2,disposition:'fresh',initial_selection:{...body.selection,provider:`kode-agent-${body.profileId}`}});hub.scope={...hub.scope,state:'superseded'}
 return json(res,200,successorReceipt(body)),true
}

test('Builder planning handoff reuses the native HandoffMenu in Orbit: cancel posts nothing, one stored exact request, unknown outcomes keep it, foreign or same-epoch receipts are refused, success embeds only the successor',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:120000},orbit(async({page,wait,shot,clickText,embedded,openPlanning,posts})=>{
  await page.evaluate(`fixture.ctx.slots.register({name:'conversation.session.header.actions',id:'kode-handoff',order:100,inject:sessionId=>({sessionId,sessions:fixture.ctx.get('sessions')})},fixture.ctx.get('kodeAgentControls').HandoffMenu)`)
  const hubPosts=()=>posts.filter(row=>row.path==='/api/kode/agent-hub').map(row=>row.body)
  const sends=()=>hubPosts().filter(body=>body.action==='handoff')
  const dialog=`document.querySelector('.kode-handoff-dialog')`,trigger=`document.querySelector('.kode-builder-session-bar .kode-handoff-trigger')`
  const inDialog=text=>`Array.from(document.querySelectorAll('.kode-handoff-dialog button')).find(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled)`
  const press=async text=>{await wait(inDialog(text));await page.evaluate(`${inDialog(text)}.click()`)}
  const settle=()=>page.evaluate(`new Promise(r=>setTimeout(r,400))`)
  const record=()=>page.evaluate(`new Promise((resolve,reject)=>{const open=indexedDB.open('kode.collab.outbox.v1',1);open.onerror=reject;open.onsuccess=()=>{const get=open.result.transaction('messages').objectStore('messages').get(${JSON.stringify(JSON.stringify(['builder-planning-handoff',home,draft.id,SID]))});get.onsuccess=()=>{open.result.close();resolve(get.result?.value??null)};get.onerror=reject}})`)
  const shownSession=()=>page.evaluate(`${embedded}?.getAttribute('data-conversation-session')??null`)
  const orbitStays=async()=>{assert.equal(await page.evaluate(`fixture.selectedPanel()`),'kode-collab');assert.deepEqual(await page.evaluate(`nativeOpened`),[]);assert.ok(!(await page.evaluate(`nativePanels`)).slice(1).includes(null))}

  await openPlanning()
  const startPosts=posts.length
  // Ordinary (non-planning) HandoffMenu from the same facade still renders its original dialog.
  await page.evaluate(`(()=>{const M=globalThis.__KODE_TEST_MODULES__,node=document.createElement('div');node.id='ordinary-handoff';document.body.append(node);window.ordinaryRoot=M['react-dom/client'].createRoot(node);ordinaryRoot.render(M.react.createElement(fixture.ctx.get('kodeAgentControls').HandoffMenu,{sessionId:${JSON.stringify(SID)},sessions:fixture.ctx.get('sessions')}))})()`)
  await wait(`document.querySelector('#ordinary-handoff .kode-handoff-trigger')`);await page.evaluate(`document.querySelector('#ordinary-handoff .kode-handoff-trigger').click()`)
  await wait(`${dialog}?.innerText.includes('开始交接')`)
  assert.match(await page.evaluate(`${dialog}.innerText`),/将文字历史带入目标 Agent 的新会话，并继续最近的请求/)
  assert.match(await page.evaluate(`${dialog}.innerText`),/目标 Agent 会收到一份新的文字上下文，不会修改当前会话/,'the original ordinary note')
  assert.equal(await page.evaluate(`!!${inDialog('准备交接')}||${dialog}.innerText.includes('模型')`),false,'no planning action or model picker in the ordinary dialog')
  await press('取消');await wait(`!${dialog}`)
  await page.evaluate(`ordinaryRoot.unmount();document.getElementById('ordinary-handoff').remove()`)
  assert.deepEqual(hubPosts(),[],'ordinary open/cancel posts nothing')

  // 1. Planning mode in the embedded bar: same trigger and Modal, native Agent + model pickers; cancel posts nothing.
  await wait(trigger);await page.evaluate(`${trigger}.click()`)
  await wait(inDialog('准备交接'))
  const choose=await page.evaluate(`${dialog}.innerText`)
  assert.match(choose,/用其他 Agent 继续[\s\S]*更换 Agent 并建立继任规划会话[\s\S]*不会自动发送任何内容/)
  assert.equal(await page.evaluate(`${dialog}.querySelectorAll('.kode-field').length`),2,'目标 Agent + 模型')
  await press('取消');await wait(`!${dialog}`);await settle()
  assert.deepEqual(hubPosts(),[],'planning cancel posts nothing');assert.equal(await record(),null)

  // 2. Choose kode-frontend through the native AgentPicker, prepare (read-only), then cancel: still no handoff and no record.
  await page.evaluate(`${trigger}.click()`);await wait(inDialog('准备交接'))
  await page.evaluate(`${dialog}.querySelector('.kode-field button').click()`)
  await wait(`Array.from(document.querySelectorAll('[role^=menuitem]')).some(b=>b.textContent.includes('kode-frontend'))`)
  await page.evaluate(`Array.from(document.querySelectorAll('[role^=menuitem]')).find(b=>b.textContent.includes('kode-frontend')).click()`)
  await wait(`${dialog}.querySelector('.kode-field button').textContent.includes('kode-frontend')`)
  // Native ModelPicker: Fast switch and reasoning effort are saved with the choice (IndexedDB) and shown on its trigger.
  const modelTrigger=`${dialog}.querySelector('.kode-model-control .kode-trigger')`,agentTrigger=`${dialog}.querySelector('.kode-agent-trigger')`,fastSwitch=`document.querySelector('[role=switch][aria-label=Fast]')`
  const menuItem=text=>`Array.from(document.querySelectorAll('[role^=menuitem]')).find(b=>b.textContent.includes(${JSON.stringify(text)}))`
  await wait(`${modelTrigger}&&!${modelTrigger}.disabled&&${modelTrigger}.textContent.includes('Opus 5.5 · Low')`)
  const choiceRow=()=>page.evaluate(`new Promise((resolve,reject)=>{const open=indexedDB.open('kode.collab.outbox.v1',1);open.onerror=reject;open.onsuccess=()=>{const get=open.result.transaction('messages').objectStore('messages').get(${JSON.stringify(JSON.stringify(['builder-planning-handoff-choice',home,draft.id,SID]))});get.onsuccess=()=>{open.result.close();resolve(get.result?.value??null)};get.onerror=reject}})`)
  // A model-variant Fast pair uses the native conversion: the switch moves between standardModelId and fastModelId,
  // so the trigger, the stored choice and the later prepare selection are the same canonical model.
  const exactItem=text=>`Array.from(document.querySelectorAll('[role^=menuitem]')).find(b=>b.textContent===${JSON.stringify(text)})`
  const pickModel=async name=>{if(!await page.evaluate(`!!document.querySelector('[role=menu]')`))await page.evaluate(`${modelTrigger}.click()`);await wait(menuItem('模型'));await page.evaluate(`${menuItem('模型')}.click()`);await wait(exactItem(name));await page.evaluate(`${exactItem(name)}.click()`)}
  const closeMenu=async()=>{if(await page.evaluate(`!!document.querySelector('[role=menu]')`))await page.evaluate(`${modelTrigger}.click()`);await wait(`!document.querySelector('[role=menu]')`)}
  const toggleFast=async checked=>{if(!await page.evaluate(`!!document.querySelector('[role=menu]')`))await page.evaluate(`${modelTrigger}.click()`);await wait(fastSwitch);await page.evaluate(`${fastSwitch}.click()`);await wait(`${fastSwitch}?.getAttribute('aria-checked')===${JSON.stringify(String(checked))}`)}
  await pickModel('GPT X');await closeMenu();await wait(`${modelTrigger}.textContent==='GPT X · Low'`)
  assert.deepEqual(await choiceRow(),{profileId:'kode-frontend',model:'gpt-x',reasoningEffort:'low',fast:false})
  await toggleFast(true);await closeMenu();await wait(`${modelTrigger}.textContent==='GPT X Fast · Low'`)
  assert.deepEqual(await choiceRow(),{profileId:'kode-frontend',model:'gpt-x-fast',reasoningEffort:'low',fast:true},'Fast on stores the advertised fastModelId')
  await toggleFast(false);await closeMenu();await wait(`${modelTrigger}.textContent==='GPT X · Low'`)
  assert.deepEqual(await choiceRow(),{profileId:'kode-frontend',model:'gpt-x',reasoningEffort:'low',fast:false},'Fast off returns to standardModelId')
  await pickModel('Opus 5.5');await closeMenu();await wait(`${modelTrigger}.textContent==='Opus 5.5 · Low'`)
  await page.evaluate(`${modelTrigger}.click()`);await wait(fastSwitch)
  await page.evaluate(`${fastSwitch}.click()`);await wait(`${fastSwitch}?.getAttribute('aria-checked')==='true'`)
  await page.evaluate(`${menuItem('推理强度')}.click()`);await wait(menuItem('High'));await page.evaluate(`${menuItem('High')}.click()`)
  await wait(`${modelTrigger}.textContent.includes('Opus 5.5 · High · Fast')`)
  assert.deepEqual(await choiceRow(),{profileId:'kode-frontend',model:'opus-5.5',reasoningEffort:'high',fast:true})
  if(await page.evaluate(`!!document.querySelector('[role=menu]')`))await page.evaluate(`${modelTrigger}.click()`)
  await wait(`!${fastSwitch}`)
  // Preparing locks both pickers: a ModelPicker menu already open closes, and nothing can be selected until the reply.
  let release;hub.hold={promise:new Promise(resolve=>{release=resolve})}
  await page.evaluate(`${modelTrigger}.click()`);await wait(fastSwitch)
  await page.evaluate(`(()=>{const b=${inDialog('准备交接')};b[Object.keys(b).find(k=>k.startsWith('__reactProps'))].onClick()})()`)
  await wait(`!${fastSwitch}&&${modelTrigger}.disabled&&${agentTrigger}.disabled`)
  await page.evaluate(`${modelTrigger}.click();${agentTrigger}.click()`);await settle()
  assert.equal(await page.evaluate(`!!document.querySelector('[role=menu]')`),false,'a locked picker opens no menu')
  assert.deepEqual(await choiceRow(),{profileId:'kode-frontend',model:'opus-5.5',reasoningEffort:'high',fast:true},'nothing changed while preparing')
  hub.hold=null;release()
  await wait(inDialog('确认交接'))
  assert.deepEqual(hubPosts(),[{action:'prepare-handoff',sessionId:SID,profileId:'kode-frontend',selection}])
  assert.match(await page.evaluate(`${dialog}.innerText`),/确认后会更换 Agent 并建立继任规划会话，不自动发送/)
  assert.equal(await page.evaluate(`Array.from(${dialog}.querySelectorAll('.kode-field button')).every(b=>b.disabled)`),true,'prepared choice is locked')
  // The confirmation shows the frozen command's target and selection.
  assert.equal(await page.evaluate(`${agentTrigger}.getAttribute('aria-label')`),'Agent：kode-frontend')
  assert.equal(await page.evaluate(`${modelTrigger}.getAttribute('aria-label')`),'模型：Opus 5.5 · High · Fast')
  await shot('orbit-planning-handoff-confirm-1440.png')
  await press('取消');await wait(`!${dialog}`);await settle()
  assert.deepEqual(sends(),[]);assert.equal(await record(),null)

  // 3. The source context changes between prepare and confirm: the confirmation is withdrawn, nothing stored or sent.
  await page.evaluate(`${trigger}.click()`);await press('准备交接');await wait(inDialog('确认交接'))
  hub.scope={...hub.scope,context_sha256:'b'.repeat(64)}
  await press('确认交接');await wait(`${dialog}?.innerText.includes('确认已撤回')`)
  assert.deepEqual(sends(),[]);assert.equal(await record(),null)
  // The withdrawn dialog re-reads the new context; the next preparation is for it.

  // 4. Double-click confirm: one POST of exactly prepared + one request id, stored first; a lost reply keeps it, no auto resend.
  await press('准备交接');await wait(inDialog('确认交接'))
  const prepared=hubPosts().filter(body=>body.action==='prepare-handoff').length
  hub.replies.push('lost','409','foreign','same-epoch','ready')
  // Two native clicks, plus the same handler entered again before React commits the disabled state: only the synchronous ref stops it.
  await page.evaluate(`(()=>{const b=${inDialog('确认交接')},handler=b[Object.keys(b).find(k=>k.startsWith('__reactProps'))].onClick;b.click();b.click();handler()})()`)
  await wait(inDialog('核对原请求'));await settle()
  assert.equal(sends().length,1,'a double click sends once')
  const original=sends()[0]
  assert.ok(typeof original.requestId==='string'&&original.requestId.length>0)
  assert.deepEqual(original,{action:'handoff',sessionId:SID,profileId:'kode-frontend',selection,requestId:original.requestId,
   planning:{draft_id:draft.id,source_epoch:1,draft_revision:2,source_context_sha256:'b'.repeat(64),target_profile_revision:revision}},'the prepared command verbatim plus one request id')
  assert.deepEqual(await record(),{request_id:original.requestId,state:'sent',command:original},'persisted in IndexedDB')
  assert.match(await page.evaluate(`${dialog}.innerText`),/不会自动重试[\s\S]*诊断：未收到完整的 HTTP 响应/)
  assert.equal(await shownSession(),SID);await orbitStays()

  // Reopening offers only the check of the original; no new prepare is possible.
  await press('取消');await wait(`!${dialog}`);await page.evaluate(`${trigger}.click()`);await wait(inDialog('核对原请求'))
  assert.equal(await page.evaluate(`!!${inDialog('准备交接')}`),false)

  // 5. 409, a foreign-scope receipt and a same-epoch receipt: each resends only the original and opens nothing.
  for(const [reply,diagnosis] of [['409',/HTTP 409 · PLANNING_HANDOFF_CONFLICT/],['foreign',/结果与这次交接不符/],['same-epoch',/结果与这次交接不符/]]){
   const before=sends().length
   await press('核对原请求');await wait(`${dialog}&&!${dialog}.getAttribute('aria-busy')&&${inDialog('核对原请求')}&&${dialog}.innerText.match(${diagnosis})`);await settle()
   assert.equal(sends().length,before+1,reply);assert.deepEqual(sends().at(-1),original,reply+': verbatim')
   assert.deepEqual(await record(),{request_id:original.requestId,state:'sent',command:original},reply)
   assert.equal(await shownSession(),SID,reply+': nothing else is opened');await orbitStays()
  }
  assert.equal(hubPosts().filter(body=>body.action==='prepare-handoff').length,prepared,'no new prepare after the original was stored')

  // 6. Ready: only the successor is embedded in place, the draft is not filled and nothing is sent.
  const inits=await page.evaluate(`nativeWire.inits.length`)
  // The server-created successor appears in the native Session list (fixture RPC boundary).
  await page.evaluate(`fixtureNativeExtra.push(${JSON.stringify(NEW)})`)
  await press('核对原请求')
  await wait(`!${dialog}&&${embedded}?.getAttribute('data-conversation-session')===${JSON.stringify(NEW)}`);await settle()
  assert.deepEqual(sends().at(-1),original);assert.equal(sends().length,5)
  assert.deepEqual(await record(),{request_id:original.requestId,state:'accepted',command:original,session_id:NEW})
  await orbitStays()
  assert.ok(await page.evaluate(`nativeRetains.some(r=>r.id===${JSON.stringify(NEW)}&&r.source==='kodeOrbitPlanning'&&!r.released)`),'the successor is retained by Orbit')
  assert.ok(await page.evaluate(`nativeRetains.filter(r=>r.id===${JSON.stringify(SID)}&&r.source==='kodeOrbitPlanning').every(r=>r.released)`),'the source is released')
  assert.ok(await page.evaluate(`nativeWire.inits.slice(${inits}).every(o=>!o.prompt)`),'no text is offered to the successor')
  assert.deepEqual(await page.evaluate(`nativeWire.prompts`),[],'nothing is sent to the model')
  assert.ok(posts.slice(startPosts).every(row=>row.path==='/api/kode/agent-hub'),'no other write')
  const refreshCount = () => page.evaluate(`Array.from(document.querySelectorAll('.kode-builder-session-bar button')).filter(b=>b.textContent==='按最新草案继续规划').length`)
  assert.equal(await refreshCount(),1,'successor reload leaves exactly one context refresh button')
  await clickText('团队目标');await wait(`document.querySelector('[data-planning-state="ready"]')`);await clickText('打开规划会话')
  await wait(`${embedded}?.getAttribute('data-conversation-session')===${JSON.stringify(NEW)}`);await settle()
  assert.equal(await refreshCount(),1,'reopening the successor leaves exactly one context refresh button')
  await shot('orbit-planning-handoff-successor-1440.png')
  assert.deepEqual(await page.evaluate(`window.fixtureErrors`),[])
},handoffRoutes))
