import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {headlessBrowser} from './support/headless-browser.js'
import {collabRenderPage} from './support/collab-render-page.js'

const home='fixture-home', ref={host_id:home,workspace_id:'project',root_ref:'/fixture/kode'}
const profiles=[{id:'tclaude',name:'tclaude',type:'claude',origin:'builtin'},{id:'codex',name:'Codex',type:'codex',origin:'builtin'},{id:'cursor',name:'Cursor',type:'cursor',origin:'builtin'}]
const catalogs={
 tclaude:{models:[{id:'opus-5.5',name:'Opus 5.5'},{id:'sonnet-5.5',name:'Sonnet 5.5'}],defaultModelSelection:{model:'opus-5.5'}},
 codex:{models:[{id:'gpt-6.1-sol',name:'GPT-6.1 Sol',reasoningEfforts:[{id:'medium',name:'中'},{id:'high',name:'高'}],defaultReasoningEffort:'medium'}],defaultModelSelection:{model:'gpt-6.1-sol',reasoningEffort:'medium'}},
 cursor:{models:[{id:'auto',name:'Auto'}],defaultModelSelection:{model:'auto'}},
}
const binding=extra=>({version:1,mode:'interactive_planning',home_hub:home,draft_id:'draft',context_epoch:1,session_id:'native-planning-session',workspace_id:null,cwd:'/fixture/private-planning/native-planning-session',location:{kind:'private_planning'},execution_authorized:false,...extra})

// Host without renderSession: covers only the session-mode fallback. Orbit embedding is orbit-planning-embed-browser.test.js.
test('team planning reuses native composer seats; a host without an embedded renderer falls back to session mode without sending',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:90000},async()=>{
 const longGoal='为 Kode 组建一个实现、评审和验证互相协作的团队。'+('团队应先理解现有系统，明确角色分工、验证依据与交付步骤，不自动执行未经确认的操作。'.repeat(12))
 const supplement='优先复用原生组件，不新造聊天。'
 const profile=await mkdtemp(join(tmpdir(),'kode-builder-planning-'));let browser,server
 const posts=[],agentReads=[],planningReads=[],builderPlanningReads=()=>planningReads.length,state={draft:null,planning:{state:'not_created'},planningPosts:0}
 const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))}
 try{
 const result=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {BuilderView,PlanningHostContext} from './packages/collab/builder-view.js';import {BuilderControlsContext} from './packages/collab/builder-controls.js';
 window.builderPlanning={store:new Map(),failRead:null,host:[],initResult:'applied',requests:[]};
 const storage={read:async key=>{if(builderPlanning.failRead&&key.includes(builderPlanning.failRead))throw Error('fixture read failure');return builderPlanning.store.get(key)??null},save:async(key,value)=>{builderPlanning.store.set(key,structuredClone(value))},reserve:async(key,value)=>{if(!builderPlanning.store.has(key))builderPlanning.store.set(key,value);return builderPlanning.store.get(key)}};
 const request=async(path,{signal}={})=>{builderPlanning.requests.push(path);const response=await fetch(path,{signal});if(!response.ok)throw Object.assign(Error('fixture read'),{status:response.status});return response.json()};
 const input={requestDraftInitialization:(binding,options)=>{builderPlanning.host.push(['init',binding.sessionId,options]);return builderPlanning.initResult},submit:()=>builderPlanning.host.push(['submit']),for:()=>({focus:()=>builderPlanning.host.push(['focus'])})};
 const host={sessions:{refresh:async()=>builderPlanning.host.push(['refresh']),binding:id=>({sessionId:id,ctx:{get:name=>name==='conversation'?{input}:null}})},uiWorkspace:{openSession:async id=>builderPlanning.host.push(['open',id])},selectMode:mode=>builderPlanning.host.push(['mode',mode])};
 const node=document.createElement('div');node.id='builder-planning-test';node.style='position:fixed;inset:0;background:var(--dsw-alias-bg-base,#fff);z-index:1';document.body.append(node);
 const root=createRoot(node);let generation=0;
 builderPlanning.remount=()=>root.render(React.createElement(BuilderControlsContext.Provider,{value:fixture.ctx.get('kodeAgentControls')},React.createElement(PlanningHostContext.Provider,{value:host},React.createElement(BuilderView,{key:++generation,request,storage}))));
 builderPlanning.remount();`,resolveDir:process.cwd()},bundle:true,format:'iife',platform:'browser',external:['react','react-dom','react-dom/client','@deepseek-ai/dsh-client-ui-primitives','@kode/dsh-composer'],write:false,banner:{js:'const require=name=>window.__KODE_TEST_MODULES__[name]||window.builderPlanningComposer;'}})
 server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost')
  if(url.pathname==='/api/kode/agents'&&req.method==='GET'){
   agentReads.push(url.search);assert.equal(url.searchParams.get('configuration'),'1')
   const id=url.searchParams.get('profile_id')
   return json(res,200,{profiles,selectedProfileId:'tclaude',supportedTypes:['claude','codex','cursor'],...(id?catalogs[id]:{models:[]})})
  }
  if(req.method==='POST'){
   let body='';for await(const chunk of req)body+=chunk;const command=JSON.parse(body);posts.push({path:url.pathname,body:command})
   if(url.pathname==='/api/kode/builder/create-draft'){
    state.draft={id:command.draft_id,home_hub:home,request_id:command.request_id,revision:1,status:'draft',eligible_for_execution:false,interview:{purpose:command.purpose,questions:[],answers:{},workspace_refs:[]}}
    return json(res,200,state.draft)
   }
   if(url.pathname==='/api/kode/builder/planning'){
    // 1: the connection drops with no reply. 2: the server reserved it but could not confirm.
    if(++state.planningPosts===1){res.writeHead(200,{'content-type':'application/json'});res.write('{"state":');setTimeout(()=>res.socket.destroy(),20);return}
    if(state.planningPosts===2){state.planning=binding({state:'uncertain',disposition:'recovered',retry_request:command});return json(res,409,{code:'PLANNING_NOT_CONFIRMED',execution_authorized:false})}
    const fresh=state.planning.state==='uncertain'
    state.planning=binding({state:'ready',disposition:'recovered',initial_selection:{model:'gpt-6.1-sol'}})
    return json(res,200,binding({draft_id:command.draft_id,state:'ready',disposition:fresh?'fresh':'recovered',initial_selection:{model:'gpt-6.1-sol'},...(command.workspace_id?{workspace_id:command.workspace_id,cwd:ref.root_ref,location:undefined}:{})}))
   }
   return json(res,503,{})
  }
  if(url.pathname==='/api/kode/builder/drafts'){
   if(url.searchParams.has('draft_id'))return state.draft?.id===url.searchParams.get('draft_id')?json(res,200,state.draft):json(res,404,{})
   return json(res,200,{home_hub:home,items:state.draft?[{id:state.draft.id,revision:1,purpose:state.draft.interview.purpose,status:'draft'}]:[],next_cursor:null})
  }
  if(url.pathname==='/api/kode/builder/planning'){planningReads.push(url.search);return json(res,200,state.planning.state==='not_created'?{version:1,mode:'interactive_planning',home_hub:home,draft_id:url.searchParams.get('draft_id'),state:'not_created',execution_authorized:false}:{...state.planning,draft_id:url.searchParams.get('draft_id')})}
  if(url.pathname==='/builder-planning-test.js'){res.setHeader('content-type','text/javascript');res.end(result.outputFiles[0].text);return}
  const end=res.end.bind(res);if(url.pathname==='/')res.end=html=>end(html.replace("const originalFetch=window.fetch.bind(window);","window.builderPlanningComposer=plugins['@kode/dsh-composer'];const originalFetch=window.fetch.bind(window);"))
  if(await collabRenderPage(req,res))return
  json(res,503,{})
 });server.listen(0,'127.0.0.1');await once(server,'listening')
 browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page(`http://127.0.0.1:${server.address().port}/`)
 await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
 await page.evaluate(`new Promise((resolve,reject)=>{const run=()=>{if(!window.fixture)return setTimeout(run,20);const s=document.createElement('script');s.src='/builder-planning-test.js';s.onload=resolve;s.onerror=reject;document.head.append(s)};run()})`)
 const root='#builder-planning-test'
 const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+12000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('Builder planning timeout: '+${JSON.stringify(expr)}+' :: '+document.querySelector('${root}')?.textContent)})()`)
 const q=selector=>`document.querySelector('${root} ${selector}')`
 const rect=selector=>page.evaluate(`(()=>{const r=${q(selector)}.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width}})()`)
 const clickLabel=label=>page.evaluate(`${q(`button[aria-label=${JSON.stringify(label)}]`)}.click()`)
 const clickText=text=>page.evaluate(`Array.from(document.querySelectorAll('${root} button')).find(b=>b.textContent===${JSON.stringify(text)}).click()`)
 const menuItems=()=>page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).map(b=>b.textContent)`)
 const menu=async label=>{await wait(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).some(b=>b.textContent.includes(${JSON.stringify(label)}))`);await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).find(b=>b.textContent.includes(${JSON.stringify(label)})).click()`)}
 const shots=process.env.KODE_ARTIFACT_DIR??resolve('../../../artifacts/builder-conversation-redesign-20261110');await mkdir(shots,{recursive:true})
 const shot=async name=>writeFile(join(shots,name),Buffer.from((await page.call('Page.captureScreenshot',{format:'png'})).data,'base64'))
 const openDraft=async()=>{
  await page.evaluate(`builderPlanning.remount()`)
  await wait(`${q('button[aria-label="团队规划记录"]')}&&!${q('button[aria-label="团队规划记录"]')}.disabled&&builderPlanning.requests.some(p=>p.includes('limit=25'))`)
  await clickLabel('团队规划记录');await menu('为 Kode 组建一个实现、评审和验证互相协作的团队')
  await wait(`${q('[aria-label="团队目标"] .kode-builder-goal-text')}`)
 }

 // New goal: the hero row holds only the Agent; the model sits before send. No workspace or machine is asked for.
 await wait(`${q('[aria-label="团队目标"][contenteditable=true]')}`)
 await wait(`${q('button[aria-label^="Agent："]')}?.disabled===false&&${q('button[aria-label^="模型："]')}`)
 const [agent,card,model,send]=await Promise.all(['button[aria-label^="Agent："]','[aria-label="团队目标"][contenteditable=true]','button[aria-label^="模型："]','button[aria-label="保存目标"]'].map(rect))
 assert.ok(agent.bottom<=card.top,'the Agent sits in the hero row above the input card')
 assert.ok(model.top>=card.bottom-4&&model.right<=send.left,'model sits in the standard control row before send')
 assert.equal(await page.evaluate(`!!(${q('.kode-builder-host')}||${q('.kode-builder-workspace-chip')})`),false,'no workspace chip or machine label in the hero row')
 assert.doesNotMatch(await page.evaluate(`document.querySelector('${root}').textContent`),/选择工作区|此计算机/,'the start page asks for no workspace or machine')
 await clickLabel((await page.evaluate(`${q('button[aria-label^="Agent："]')}.getAttribute('aria-label')`)))
 await menu('Codex')
 await wait(`document.querySelectorAll('[role=menuitem],[role=menuitemradio]').length===0`)
 await wait(`${q('button[aria-label^="Agent："]')}.getAttribute('aria-label').includes('Codex')`)
 await wait(`${q('button[aria-label^="模型："]')}?.textContent.includes('GPT-6.1 Sol')`)
 await page.evaluate(`${q('button[aria-label^="Agent："]')}.click()`)
 await wait(`document.querySelectorAll('[role=menuitem],[role=menuitemradio]').length>0`)
 const agents=await menuItems()
 assert.deepEqual(agents.map(text=>text.trim()).filter(Boolean).length,3,'Agent list is CLI profiles only: '+agents.join(' | '))
 for(const text of agents)assert.doesNotMatch(text,/·|Frontend|Opus|GPT|Sonnet/,'no Agent×model combos in the Agent list')
 await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
 await wait(`document.querySelectorAll('[role=menuitem],[role=menuitemradio]').length===0`)
 assert.ok(agentReads.some(search=>search.includes('profile_id=codex')),'model catalog follows the chosen Agent')
 await page.evaluate(`${q('[aria-label="团队目标"]')}.focus()`);await page.call('Input.insertText',{text:longGoal})
 await wait(`Array.from(builderPlanning.store.values()).some(row=>row.purpose===${JSON.stringify(longGoal)})`)
 assert.equal(posts.length,0,'typing and choosing never POST')
 await shot('planning-new-goal-1440.png')
 await clickLabel('保存目标')
 await wait(`${q('[aria-label="团队目标"] .kode-builder-goal-text')}`)
 assert.deepEqual(posts.map(row=>row.path),['/api/kode/builder/create-draft'])
 assert.equal(posts[0].body.purpose,longGoal)

 // Goal is shown once, folded, and expandable in full.
 assert.equal(await page.evaluate(`document.querySelectorAll('${root} .kode-builder-goal-text').length`),1)
 assert.equal(await page.evaluate(`${q('.kode-builder-goal-text')}.hasAttribute('data-collapsed')`),true)
 await clickText('展开全文')
 assert.equal(await page.evaluate(`${q('.kode-builder-goal-text')}.hasAttribute('data-collapsed')`),false)
 assert.equal(await page.evaluate(`${q('.kode-builder-goal-text')}.textContent`),longGoal)
 await clickText('收起')
 assert.ok(await page.evaluate(`Array.from(${q('.kode-builder-title')}.textContent).length<=33`))

 // Supplement is local until the user starts; it survives remount.
 await wait(`${q('[aria-label="规划对话的补充说明"][contenteditable=true]')}&&${q('button[aria-label="开始规划对话"]')}?.disabled===false`)
 await wait(`${q('button[aria-label^="模型："]')}?.textContent.includes('GPT-6.1 Sol')`)
 assert.match(await page.evaluate(`${q('[data-planning-location="private"]')}.textContent`),/私有空目录中打开，不使用你的主目录，也不读取项目文件.*添加工作区/,'a draft without a workspace states where planning runs, not an error')
 assert.equal(await page.evaluate(`${q('[data-planning-location="private"]')}.getAttribute('role')`),null,'the planning location is a note, not an error status')
 await page.evaluate(`${q('[aria-label="规划对话的补充说明"]')}.focus()`);await page.call('Input.insertText',{text:supplement})
 await wait(`Array.from(builderPlanning.store.values()).some(row=>row.content===${JSON.stringify(supplement)})`)
 await openDraft()
 await wait(`${q('[aria-label="规划对话的补充说明"]')}?.textContent===${JSON.stringify(supplement)}`)

 // Fail-closed: unreadable saved supplement blocks editing and starting.
 await page.evaluate(`builderPlanning.failRead='builder-prestart-text'`)
 await openDraft()
 await wait(`document.querySelector('${root}').textContent.includes('无法恢复已保存的补充内容')`)
 assert.equal(await page.evaluate(`${q('button[aria-label="开始规划对话"]')}.disabled`),true)
 assert.notEqual(await page.evaluate(`${q('[aria-label="规划对话的补充说明"]')}.getAttribute('contenteditable')`),'true')
 assert.equal(posts.length,1)
 await page.evaluate(`builderPlanning.failRead=null`)
 await openDraft()
 await wait(`${q('[aria-label="规划对话的补充说明"]')}?.textContent===${JSON.stringify(supplement)}&&${q('button[aria-label="开始规划对话"]')}?.disabled===false`)
 await shot('planning-draft-supplement-1440.png')

 // Start: the connection drops. Server truth is re-read; the original command is frozen.
 await clickLabel('开始规划对话')
 await wait(`${q('button[aria-label="恢复上次请求"]')}&&${q('button[aria-label="恢复上次请求"]')}.disabled===false`)
 assert.equal(await page.evaluate(`${q('button[aria-label^="Agent："]')}.disabled`),true,'Agent is frozen while the original request is unconfirmed')
 assert.equal(await page.evaluate(`${q('button[aria-label^="模型："]')}.disabled`),true,'model is frozen while the original request is unconfirmed')
 assert.match(await page.evaluate(`document.querySelector('${root}').textContent`),/上次开始规划时没有收到服务确认.*恢复会原样重发上次的请求（同一 Agent、模型和规划位置），不会重复创建会话/)
 assert.ok(builderPlanningReads()>=2,'a dropped reply re-reads the server binding')
 // The failure stays visible after the re-read, with only a whitelisted diagnosis.
 assert.match(await page.evaluate(`${q('.kode-builder-messages > p[role=status]')}?.textContent`),/没有收到服务确认[\s\S]*诊断：未收到完整的 HTTP 响应$/)
 await clickLabel('恢复上次请求')
 await wait(`${q('[data-planning-state="uncertain"]')}`)
 assert.deepEqual(posts[2].body,posts[1].body,'the frozen command is resent unchanged')
 assert.match(await page.evaluate(`${q('[data-planning-state="uncertain"]')}.textContent`),/上次开始规划时没有收到确认.*可能已创建，也可能没有.*服务只核对这次请求留下的原会话：核实后打开它；证据不足时仍保持未确认，不会新建替代会话/)
 assert.doesNotMatch(await page.evaluate(`document.querySelector('${root}').textContent`),/未创建只创建一次/)
 // The GET that shows the uncertain card does not erase why the recovery failed.
 const kept=await page.evaluate(`Array.from(document.querySelectorAll('${root} .kode-builder-messages > p[role=status]')).map(n=>n.textContent)`)
 assert.equal(kept.length,1); assert.match(kept[0],/服务还没有确认这次创建[\s\S]*诊断：HTTP 409 · PLANNING_NOT_CONFIRMED$/)
 assert.doesNotMatch(kept[0],/execution_authorized|Error|at |\{/,'no response body or stack')
 const first=posts[1]
 assert.equal(first.path,'/api/kode/builder/planning')
 assert.deepEqual(Object.keys(first.body).sort(),['draft_id','draft_revision','model','profile_id','reasoning_effort','request_id'],'no workspace is sent: the service opens a private planning directory')
 assert.equal(first.body.profile_id,'codex');assert.equal(first.body.model,'gpt-6.1-sol');assert.equal(first.body.draft_revision,1)
 assert.deepEqual(await page.evaluate(`builderPlanning.host`),[],'nothing opens before a confirmed ready receipt')
 assert.equal(await page.evaluate(`Array.from(builderPlanning.store.values()).some(row=>row.content===${JSON.stringify(supplement)})`),true,'supplement kept while unconfirmed')
 assert.equal(await page.evaluate(`(s=>s.scrollWidth<=s.clientWidth&&getComputedStyle(s).textOverflow!=='ellipsis'||getComputedStyle(s).whiteSpace==='normal')(${q('[data-planning-state="uncertain"] span')})`),true,'the recovery explanation is readable, not ellipsized')
 await shot('planning-uncertain-1440.png')
 await clickText('恢复上次请求')
 await wait(`${q('[data-planning-state="ready"]')}&&builderPlanning.host.some(row=>row[0]==='init')`)
 assert.deepEqual(posts[3].body,first.body,'recovery resends the exact original request')
 assert.doesNotMatch(await page.evaluate(`document.querySelector('${root}').textContent`),/诊断：/,'a confirmed success ends the failure notice')
 assert.deepEqual(await page.evaluate(`builderPlanning.host`),[['refresh'],['open','native-planning-session'],['mode','session'],['init','native-planning-session',{prompt:longGoal+'\n\n'+supplement,whenDraftExists:'keep'}],['focus']])
 assert.match(await page.evaluate(`${q('[data-planning-state="ready"]')}.textContent`),/规划会话已创建.*打开规划会话/)
 assert.equal(await page.evaluate(`Array.from(builderPlanning.store.values()).some(row=>row.content===${JSON.stringify(supplement)})`),false,'handed-off supplement is cleared only after the native input applied it')
 await shot('planning-session-ready-1440.png')

 // Reopen: GET ready is metadata only; confirm with the minimal request, no Agent/model override.
 await page.evaluate(`builderPlanning.host=[]`)
 await openDraft()
 await wait(`${q('[data-planning-state="ready"]')}?.textContent.includes('已有规划会话')`)
 assert.equal(posts.length,4,'reading a binding does not POST')
 await clickText('打开规划会话')
 await wait(`builderPlanning.host.some(row=>row[0]==='mode')`)
 assert.deepEqual(Object.keys(posts[4].body).sort(),['draft_id','draft_revision','request_id'])
 assert.notEqual(posts[4].body.request_id,first.body.request_id)
 assert.deepEqual(await page.evaluate(`builderPlanning.host`),[['refresh'],['open','native-planning-session'],['mode','session']],'goal is not offered twice and nothing is sent')

 // An uncertain record without its original request is never recreated.
 state.planning=binding({state:'uncertain',disposition:'recovered'})
 await openDraft()
 await wait(`${q('[data-planning-state="uncertain"]')}`)
 assert.match(await page.evaluate(`${q('[data-planning-state="uncertain"]')}.textContent`),/没有提供可重发的原请求。为避免重复创建，这里不会新建会话.*重新查询状态/)
 assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('${root} button')).some(b=>b.textContent==='恢复上次请求')`),false)
 assert.equal(posts.length,5)
 assert.ok(posts.every(row=>['/api/kode/builder/create-draft','/api/kode/builder/planning'].includes(row.path)),'no budget, grant, start or team POST')
 assert.ok(posts.every(row=>!('session_id' in row.body)),'the browser never proposes a session id')
 assert.deepEqual(await page.evaluate(`builderPlanning.host.filter(row=>row[0]==='submit')`),[])

 // A draft that already has a project keeps using it; nothing is dropped or widened.
 state.draft={...state.draft,id:'draft-with-project',interview:{...state.draft.interview,workspace_refs:[ref]}};state.planning={state:'not_created'}
 await openDraft()
 await wait(`${q('[data-planning-location="workspace"]')}&&${q('button[aria-label="开始规划对话"]')}?.disabled===false`)
 assert.match(await page.evaluate(`${q('[data-planning-location="workspace"]')}.textContent`),/会在工作区「kode」中打开，Agent 可以读取其中的文件.*更改规划位置/)
 await shot('planning-location-workspace-1440.png')
 await clickText('更改规划位置')
 await wait(`${q('[aria-label="规划会话位置"]')}`)
 assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll('${root} [aria-label="规划会话位置"] label')).map(l=>[l.querySelector('input').checked,l.textContent])`),[[false,'私有规划目录Kode 专用的空目录，不读取项目文件'],[true,'kode/fixture/kode']],'the existing workspace stays selected; private is an explicit option')
 await shot('planning-location-choice-1440.png')
 await clickText('返回对话')
 await wait(`${q('[data-planning-location="workspace"]')}&&${q('button[aria-label="开始规划对话"]')}?.disabled===false`)
 await clickLabel('开始规划对话')
 await wait(`${q('[data-planning-state="ready"]')}`)
 assert.equal(posts.length,6);assert.equal(posts[5].body.workspace_id,'project','the draft’s existing workspace is sent explicitly')

 // Narrow window: same structure, no horizontal overflow.
 state.planning=binding({state:'ready',disposition:'recovered'})
 await page.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true})
 await openDraft()
 await wait(`${q('[data-planning-state="ready"]')}`)
 assert.ok(await page.evaluate(`(()=>{const t=${q('.kode-builder-thread')};return t.scrollWidth<=t.clientWidth+1})()`))
 await shot('planning-session-ready-390.png')
 state.draft=null;state.planning={state:'not_created'}
 await page.evaluate(`builderPlanning.remount()`)
 await wait(`${q('[aria-label="团队目标"][contenteditable=true]')}&&${q('button[aria-label^="Agent："]')}`)
 assert.equal(await page.evaluate(`!!${q('.kode-builder-host')}`),false)
 assert.ok(await page.evaluate(`(()=>{const t=${q('.kode-builder-thread')};return t.scrollWidth<=t.clientWidth+1})()`))
 await shot('planning-new-goal-390.png')
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await rm(profile,{recursive:true,force:true})}
})
