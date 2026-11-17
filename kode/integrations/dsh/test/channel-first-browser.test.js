/** Real isolated Hub and shipped DSH renderer. All content is synthetic; no model starts. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm,writeFile,mkdir,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {isolatedHub} from './support/discussion-hub.js'
import {versionedProject} from './support/versioned-project.js'
import {conversationTeam} from './support/conversation-team.js'
import {headlessBrowser} from './support/headless-browser.js'
import {collabRenderPage} from './support/collab-render-page.js'
import {registerCollabTeams,registerCollabRuns} from '../src/collab-api.js'
import {registerCollaboration} from '../src/collaboration-route.js'
import {registerConversation} from '../src/conversation-route.js'
import {registerConversationRead} from '../src/conversation-read-route.js'
import {registerWorkRun} from '../src/work-run-route.js'
import {registerManagedSessionAccess} from '../src/managed-session-access.js'
import {ownerWorkerDirectory} from '../src/owner-worker-directory.js'
import {draftKey} from '../packages/collab/discussion-model.js'

test('channel-first discussions, native composers and exact existing execution links', {skip:!process.env.KODE_TEST_BROWSER_BIN||!process.env.KODE_TEST_HUB_BIN,timeout:180000}, async()=>{
 const hub=await isolatedHub('channel-first-ui'),profile=await mkdtemp(join(tmpdir(),'kode-channel-first-'))
 let server,browser,page
 const call=(path,body)=>hub.client.call('/api/v1/messaging/'+path,body),writes=[],bindings={}
 try{
  const root=await versionedProject(hub.root)
  await call('workbench/workspaces',{action:'create',path:root,title:'协作设计 · 隔离验证'})
  const workspace=(await call('workbench/workspaces')).workspaces.find(w=>w.path===root)
  const scope={home_hub:hub.node,host_id:hub.node,workspace_id:workspace.id,root_ref:root}
  const emptyRoot=await versionedProject(hub.root)
  await call('workbench/workspaces',{action:'create',path:emptyRoot,title:'空白项目'})
  const emptyWorkspace=(await call('workbench/workspaces')).workspaces.find(w=>w.path===emptyRoot)
  const configuredHub={...hub,client:{call:(path,body)=>hub.client.call(path,path.endsWith('/capability-profiles')?{...body,assessments:{fit:{evaluation:{kind:'task_fit',tag:'inspection',score:80},source:'user',confidence:1,evidence:[],updated_at:Date.now(),valid_until:Date.now()+180000,pinned:false}}}:body)}}
  const team=await conversationTeam(configuredHub,{workspace:{host_id:scope.host_id,workspace_id:scope.workspace_id,root_ref:root}})
  for(const [id,kind,title] of [['channel','channel','产品设计'],['private','dm','设计私信']])await call('collaboration/surfaces/'+id,{request_id:'create-'+id,expected_revision:0,scope,kind,title,team_ids:[team.id],enabled:true})
  const post=(surface,content,thread)=>call('collaboration/surfaces/'+surface+'/messages',{request_id:crypto.randomUUID(),expected_revision:1,content,mentions:[],...(thread?{thread_id:thread}:{})})
  await post('private','先对齐设计方向，结论再放回频道。私信只保留核心决策。')
  const cases=[]
  for(const [label,content,reply] of [
   ['A','频道导航：保留原有项目树，在频道中同步目标、边界和验证结果。','建议把任务工具收进讨论串。主时间线保留需求和结果，执行细节通过链接查看。'],
   ['B','输入体验：复用原生编辑器，支持换行、草稿隔离和重复发送保护。','同意复用现有编辑器。请覆盖 Enter 发送、Shift+Enter 换行和切换频道后草稿恢复。'],
  ]){
   const message=await post('channel',content);await post('channel',reply,message.id)
   const summary='需求 '+label+' 的独立任务'
   let task=await call('collaboration/tasks',{request_id:'task-'+label,origin_surface_id:'channel',origin_message_id:message.id,origin_revision:1,archive_surface_id:'channel',archive_revision:1,team_id:team.id,team_revision:1,summary,publication:{destination_id:'channel',destination_revision:1,summary_sha256:createHash('sha256').update(summary).digest('hex')}})
   const preview=await call('collaboration/tasks/'+task.id+'/execution'),activation=await call('teams/team/activation')
   const receipt=await call('collaboration/tasks/'+task.id+'/execution',{request_id:'execute-'+label,expected_task_revision:task.revision,binding_id:'local',activation_revision:activation.revision,context_sha256:preview.context_sha256})
   const run=await call('work-runs/'+receipt.work_run_id)
   const {assignment}=await call('work-runs/'+run.id+'/stages/inspect/assignments',{request_id:'assignment-'+label,expected_revision:run.revision,target_id:'control',worker_id:null})
   bindings[assignment.worker.session_id]={managedAssignment:{id:assignment.id},managedOperation:assignment.dispatch.command.operation}
   task=await call('collaboration/tasks/'+task.id);cases.push({label,message,reply,task,assignment,run:await call('work-runs/'+run.id)})
  }
  const longOriginal='核心结论：频道承载协作，私信保留决策。\n\n'+Array.from({length:24},(_,i)=>`验证记录 ${i+1}：保持原始文本与证据顺序，不把执行日志放到主时间线。`).join('\n')+'\n原文末尾标记：COMPLETE-ORIGINAL-END'
  await call('conversations/'+team.conversation_id+'/messages',{request_id:'dm-human',content:'请简要说明频道与讨论串的设计，并保留完整验证记录供查看。'})
  // Controlled retained response in the disposable DB, not a model-generated result.
  const db=new DatabaseSync(join(hub.root,'ledger.sqlite'))
  try{
   const sequence=db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM conversation_messages').get().n
   const row={id:'synthetic-long-reply',conversation_id:team.conversation_id,team_id:team.id,home_hub:hub.node,superagent_id:team.superagent_id,sequence,actor:{kind:'superagent',id:team.superagent_id},content:longOriginal,created_at:Date.now(),state:'accepted',request_id:'synthetic-long-reply'}
   db.prepare('INSERT INTO conversation_messages(sequence,id,conversation_id,team_id,actor,request_id,request,body) VALUES (?,?,?,?,?,?,?,?)').run(sequence,row.id,team.conversation_id,team.id,'superagent:'+team.superagent_id,row.request_id,'{}',JSON.stringify(row))
  }finally{db.close()}
  const rows=cases.map(c=>({sessionId:c.assignment.worker.session_id,blank:false,cwd:'/isolated/derived-not-origin',projections:{values:{title:'Worker '+c.label}}}))
  const services={kodeAgents:{profiles:{binding:id=>bindings[id]}},sessionController:{list:async()=>({items:rows})}}
  const directory={nodeId:hub.node,workspaces:[{id:workspace.id,title:'协作设计 · 隔离验证',path:root,sessionIds:[]},{id:emptyWorkspace.id,title:'空白项目',path:emptyRoot,sessionIds:[]}],archivedSessionIds:[]}
  const managed=await ownerWorkerDirectory({get:key=>services[key]},hub.client,directory)
  assert.equal(managed.length,2)
  const routes=new Map(),ctx={connection:{admit:req=>req.headers['x-fixture-owner']==='yes'?{peer:{principal:{kind:'owner'}}}:{rejection:401}},webServer:{register:r=>routes.set(r.path,r)}}
  const client={call:async(path,body)=>{if(body)writes.push({path,body});return hub.client.call(path,body)}}
  for(const register of [registerCollaboration,registerCollabTeams,registerCollabRuns,registerConversation,registerConversationRead,registerWorkRun])register(ctx,{backendClient:client})
  registerManagedSessionAccess(ctx,{profiles:{binding:id=>bindings[id]}},hub.node)
  const workspaces=directory.workspaces.map(row=>({workspaceId:row.id,title:row.title,path:row.path,sessionIds:[],createdAt:new Date().toISOString()}))
  const ownerDirectory={current:'local',hosts:[{id:'local',...directory,sessions:[],ownerManagedSessions:managed,ownerManagedCandidateLimit:100}]}
  server=createServer(async(req,res)=>{try{const route=routes.get(new URL(req.url,'http://localhost').pathname);if(route)return await route.handler(req,res);if(await collabRenderPage(req,res,{workspaces,ownerDirectory,managedSessions:managed.map(row=>({id:row.id,title:row.title}))}))return;res.writeHead(404);res.end('{}')}catch{if(!res.headersSent)res.writeHead(500);res.end('{}')}})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);page=await browser.page('http://127.0.0.1:'+server.address().port)
  const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+15000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,35))}throw Error('UI timeout: '+document.body.innerText+' '+JSON.stringify(fixtureErrors))})()`)
  // Sidebar rows also hold avatars and badges, so a row is matched by its [data-row-title] text.
  const click=async text=>{await wait(`Array.from(document.querySelectorAll('button,[data-sidebar-row] [data-row-title]')).some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`);await page.evaluate(`Array.from(document.querySelectorAll('button,[data-sidebar-row] [data-row-title]')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`)}
  const select=async selector=>{await wait(`document.querySelector(${JSON.stringify(selector)})`);await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)}
  const key=async(name,modifiers=0)=>{const code=name==='Escape'?27:13;await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:name,code:name,windowsVirtualKeyCode:code,modifiers,...(name==='Enter'?{text:'\r',unmodifiedText:'\r'}:{})});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:name,code:name,windowsVirtualKeyCode:code,modifiers})}
  const type=async(selector,text)=>{await wait(`document.querySelector(${JSON.stringify(selector)})?.isContentEditable`);await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);await page.call('Input.insertText',{text})}
  const replaceDraft=async(selector,text='')=>{
   await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
   await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4,commands:['selectAll']})
   await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA'})
   await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8})
   await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8})
   await wait(`!document.querySelector(${JSON.stringify(selector)}).textContent.trim()`);await new Promise(r=>setTimeout(r,100))
   if(text){await type(selector,text);await wait(`document.querySelector(${JSON.stringify(selector)}).textContent.includes('长草稿第 36 行')`);await new Promise(r=>setTimeout(r,100))}
  }
  const longDraft=Array.from({length:36},(_,i)=>`长草稿第 ${i+1} 行：频道、讨论串与私信都应保持消息可见。`).join('\n')
  const boundedDraft=async(editor,pane,messages)=>{
   const result=await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(editor)}),p=document.querySelector(${JSON.stringify(pane)}),m=p.querySelector(${JSON.stringify(messages)}),send=p.querySelector('button[aria-label="发送"]');let s=e;while(s&&s!==p&&!(getComputedStyle(s).maxHeight!=='none'&&/auto|scroll/.test(getComputedStyle(s).overflowY)))s=s.parentElement;const r=s?.getBoundingClientRect(),b=send?.getBoundingClientRect(),mr=m?.getBoundingClientRect();return {maxHeight:s?getComputedStyle(s).maxHeight:'none',height:r?.height,bottom:b?.bottom,sendHeight:b?.height,messageHeight:mr?.height,messageBottom:mr?.bottom,viewport:innerHeight,text:e.textContent}})()`)
   assert.notEqual(result.maxHeight,'none','native text scroll must receive host max-height')
   assert.ok(result.height<=Math.min(220,result.viewport*.25)+2,JSON.stringify(result))
   assert.ok(result.bottom<=result.viewport&&result.sendHeight>0,'send remains visible')
   assert.ok(result.messageHeight>50&&result.messageBottom<=result.viewport,'message region remains visible')
   for(let i=1;i<=36;i++)assert.ok(result.text.includes(`长草稿第 ${i} 行`))
   return result.text
  }
  const collab=async()=>{await wait(`document.querySelector('.kode-collab-mode-switch button')`);if(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button')?.getAttribute('aria-label').includes('会话')`)){await select('.kode-collab-mode-switch button');await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`);await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)}}
  const assertCurrent=async(discussion,teamActive=false)=>{
   await wait(`Array.from(document.querySelectorAll(':is([data-sidebar-row=channel],[data-sidebar-row=dm]) [data-row-title]')).some(e=>e.textContent.trim()===${JSON.stringify(discussion||'产品设计')})`)
   assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll('[data-sidebar-row]:is([data-sidebar-row=channel],[data-sidebar-row=dm])[aria-current="page"]')).map(e=>e.querySelector("[data-row-title]").textContent.trim())`),discussion?[discussion]:[],'only the displayed discussion surface may be current')
   assert.equal(await page.evaluate(`document.querySelectorAll('[data-sidebar-row=team][aria-current="page"]').length`),teamActive?1:0,'team current state follows actual active panel')
  }
  const openThread=async c=>{await collab();await click('产品设计');await select(`.kode-discussion-timeline [data-message-id="${c.message.id}"] .kode-discussion-reply`);await wait(`document.querySelector('.kode-discussion-detail .kode-discussion-messages')?.innerText.includes(${JSON.stringify(c.reply)})`);await assertCurrent('产品设计')}
  const shot=async name=>{
   if(!process.env.KODE_TEST_SCREENSHOTS)return
   const previous=await page.evaluate(`(()=>{const root=document.getElementById('root'),old=root.getAttribute('style');root.style.height='calc(100% - 24px)';const e=document.createElement('div');e.id='channel-evidence-label';e.style='position:fixed;left:0;right:0;bottom:0;height:24px;display:flex;align-items:center;justify-content:center;background:#203040;color:white;font:11px sans-serif';e.textContent='隔离验证 · 合成讨论与受控 Session · 未启动模型';document.body.append(e);return old})()`)
   try{await new Promise(r=>setTimeout(r,80));await mkdir(process.env.KODE_TEST_SCREENSHOTS,{recursive:true});await writeFile(join(process.env.KODE_TEST_SCREENSHOTS,name+'.png'),Buffer.from((await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'))}
   finally{await page.evaluate(`(()=>{document.getElementById('channel-evidence-label').remove();const root=document.getElementById('root');${previous===null?"root.removeAttribute('style')":`root.setAttribute('style',${JSON.stringify(previous)})`}})()`)}
  }
  const baseline={runs:await Promise.all(cases.map(c=>call('work-runs/'+c.run.id))),tasks:await Promise.all(cases.map(c=>call('collaboration/tasks/'+c.task.id))),budget:await call('budgets/budget'),activation:await call('teams/team/activation')}
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:980,deviceScaleFactor:1,mobile:false})
  await collab();await wait(`document.querySelector('.kode-discussion-home')?.innerText.includes('在频道中协作')`)
  assert.equal(await page.evaluate(`!!document.querySelector('.kode-collab-conversation')`),false,'default collaboration landing is channels, not DM')
  await wait(`document.querySelector('.kode-discussion-home-links')?.innerText.includes('产品设计')`)
  // Projects are switched in the sidebar tree: expand the project row, then any click inside its group makes it current.
  const switchWorkspace=async title=>{const row=`[aria-label=${JSON.stringify('项目：'+title)}]`,group=`[role=group][aria-label=${JSON.stringify(title)}]`
   await wait(`document.querySelector(${JSON.stringify(row)})`)
   if(!await page.evaluate(`!!document.querySelector(${JSON.stringify(group)})`))await select(row)
   await select(group);await wait(`document.querySelector(${JSON.stringify(row)}).getAttribute('aria-current')==='true'`)}
  await switchWorkspace('空白项目');await wait(`document.querySelector('.kode-discussion-home')?.innerText.includes('创建第一个频道')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussion-home-links').children.length`),0)
  // A workspace without a team: the new-channel dialog explains why and offers 关闭 / 打开 Team Builder on one footer row.
  await page.evaluate(`Array.from(document.querySelectorAll('[role=group][aria-label="空白项目"] button')).find(b=>b.textContent.trim()==='新建频道').click()`)
  await wait(`document.querySelector('.kode-surface-create-empty')`)
  const footer=await page.evaluate(`(()=>{const dialog=document.querySelector('.kode-surface-create-empty').closest('[role=dialog]')??document;const box=label=>{const b=Array.from(dialog.querySelectorAll('button')).filter(e=>e.textContent.trim()===label).pop();return b&&b.getBoundingClientRect().toJSON()};return {close:box('关闭'),builder:box('打开 Team Builder'),text:document.querySelector('.kode-surface-create-empty').innerText}})()`)
  assert.ok(footer.close&&footer.builder,JSON.stringify(footer))
  assert.ok(Math.abs(footer.close.top-footer.builder.top)<1&&Math.abs(footer.close.height-footer.builder.height)<1,'footer buttons share one row: '+JSON.stringify(footer))
  assert.ok(footer.close.right<=footer.builder.left,'关闭 sits before 打开 Team Builder')
  assert.match(footer.text,/频道至少需要一位成员/)
  await shot('channel-create-no-team-footer')
  await page.evaluate(`Array.from(document.querySelector('.kode-surface-create-empty').closest('[role=dialog]').querySelectorAll('button')).filter(b=>b.textContent.trim()==='关闭').pop().click()`)
  await wait(`!document.querySelector('.kode-surface-create-empty')`)
  await switchWorkspace('协作设计 · 隔离验证')
  await openThread(cases[0])
  // Both entrances keep the same immutable root; counts come from the full Hub summary.
  const summaryPage=await call('collaboration/surfaces/channel/threads');
  const threadSummary=summaryPage.items.find(row=>row.thread_id===cases[0].message.id);
  assert.ok(threadSummary.reply_count>0);assert.ok(threadSummary.reply_actors.length>0);
  const summarySelector=`.kode-discussion-timeline [data-message-id="${cases[0].message.id}"] .kode-discussion-thread-summary`;
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(summarySelector)})?.textContent`),`${threadSummary.reply_count} 条回复`);
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(summarySelector)})?.querySelectorAll('.kode-discussion-avatar').length`),threadSummary.reply_actors.length);
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussion-detail>header strong').textContent`),'消息列');
  await select('button[aria-label="关闭消息列"]');await wait(`!document.querySelector('.kode-discussion-detail')`);
  await select(summarySelector);await wait(`document.querySelector('.kode-discussion-detail [data-thread-root=true]')?.dataset.messageId===${JSON.stringify(cases[0].message.id)}`);
  assert.equal(await page.evaluate(`document.querySelector('details.kode-discussion-task-tools')?.open`),false)
  assert.equal(await page.evaluate(`document.querySelectorAll('.kode-discussions textarea').length`),0)
  assert.equal(await page.evaluate(`document.querySelectorAll('.kode-discussions [role=textbox][contenteditable=true]').length`),2)
  assert.equal(await page.evaluate(`(()=>{const t=document.querySelector('.kode-discussion-timeline').getBoundingClientRect(),d=document.querySelector('.kode-discussion-detail').getBoundingClientRect();return d.left>=t.right-1&&Math.abs(d.top-t.top)<2})()`),true,'thread is a right sidebar, not a top pipeline')
  await shot('01-channel-thread-desktop')
  const rootEditor='.kode-discussion-timeline [role=textbox]',threadEditor='.kode-discussion-detail [role=textbox]'
  await replaceDraft(rootEditor,longDraft);await replaceDraft(threadEditor,longDraft)
  const savedRoot=await boundedDraft(rootEditor,'.kode-discussion-timeline','.kode-discussion-messages'),savedThread=await boundedDraft(threadEditor,'.kode-discussion-detail','.kode-discussion-messages')
  await click('设计私信');await openThread(cases[0])
  await wait(`document.querySelector(${JSON.stringify(threadEditor)})?.textContent.includes('长草稿第 36 行')`)
  for(const [editor,thread] of [[rootEditor,null],[threadEditor,cases[0].message.id]]){
   assert.equal(await page.evaluate(`Array.from(document.querySelector(${JSON.stringify(editor)}).children).map(p=>p.textContent).join(String.fromCharCode(10))`),longDraft)
   assert.equal(await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(draftKey(scope,'channel',thread))})).text`),longDraft,'persisted original multiline draft must be exact')
  }
  await replaceDraft(rootEditor);await replaceDraft(threadEditor)
  // Chromium DevTools composition, not an OS input-method integration test.
  const nearLimit='x'.repeat(65535)
  await type(threadEditor,nearLimit);await wait(`document.querySelector(${JSON.stringify(threadEditor)}).textContent.length===65535`)
  await new Promise(r=>setTimeout(r,100))
  await page.call('Input.imeSetComposition',{text:'a',selectionStart:1,selectionEnd:1})
  await page.call('Input.insertText',{text:'中文'})
  await wait(`document.querySelector('.kode-discussion-detail').innerText.includes('本次超限输入未加入草稿')`)
  await wait(`document.querySelector(${JSON.stringify(threadEditor)}).textContent===${JSON.stringify(nearLimit)}`)
  await openThread(cases[1]);await openThread(cases[0]);await wait(`document.querySelector(${JSON.stringify(threadEditor)}).textContent===${JSON.stringify(nearLimit)}`)
  await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(threadEditor)});e.focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);const data=new DataTransfer();data.setData('text/plain','PASTE-OVER-LIMIT');e.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))})()`)
  await wait(`document.querySelector('.kode-discussion-detail').innerText.includes('本次超限输入未加入草稿')`)
  await wait(`document.querySelector(${JSON.stringify(threadEditor)}).textContent===${JSON.stringify(nearLimit)}`)
  await openThread(cases[1]);await openThread(cases[0]);await wait(`document.querySelector(${JSON.stringify(threadEditor)}).textContent===${JSON.stringify(nearLimit)}`)
  await replaceDraft(threadEditor)
  await type(rootEditor,'频道草稿');await type(threadEditor,'讨论串草稿')
  await click('设计私信');await wait(`document.querySelector('.kode-discussions')?.dataset.private==='true'`)
  await assertCurrent('设计私信')
  assert.equal(await page.evaluate(`document.querySelector('.kode-discussions [role=textbox]')?.textContent`),'')
  await type('.kode-discussions [role=textbox]','私信草稿')
  await openThread(cases[0]);await wait(`document.querySelector(${JSON.stringify(threadEditor)})?.textContent==='讨论串草稿'`)
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(rootEditor)}).textContent`),'频道草稿')
  await page.evaluate(`document.querySelector(${JSON.stringify(threadEditor)}).focus()`);await key('Escape')
  await wait(`!document.querySelector('.kode-discussion-detail')`)
  await wait(`document.activeElement?.closest('[data-message-id]')?.dataset.messageId===${JSON.stringify(cases[0].message.id)}`)
  assert.equal(await page.evaluate(`document.activeElement?.closest('[data-message-id]')?.dataset.messageId`),cases[0].message.id)
  await openThread(cases[0]);await select('button[aria-label="关闭消息列"]');await wait(`!document.querySelector('.kode-discussion-detail')`)
  await wait(`document.activeElement?.classList.contains('kode-discussion-reply')`)
  assert.equal(await page.evaluate(`document.activeElement?.classList.contains('kode-discussion-reply')`),true)
  await openThread(cases[0])
  // Clear through the native editable, then use real browser key events.
  await page.evaluate(`document.querySelector(${JSON.stringify(threadEditor)}).focus()`)
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4,commands:['selectAll']})
  await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:0})
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8})
  await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8})
  await wait(`!document.querySelector(${JSON.stringify(threadEditor)}).textContent.trim()`)
  await new Promise(r=>setTimeout(r,100))
  await type(threadEditor,'键盘第一行');await wait(`document.querySelector(${JSON.stringify(threadEditor)}).textContent==='键盘第一行'`);await key('Enter',8);await page.call('Input.insertText',{text:'键盘第二行'})
  assert.equal((await call('collaboration/surfaces/channel/messages?thread_id='+cases[0].message.id)).items.filter(m=>m.content.includes('键盘第一行')).length,0,'Shift+Enter does not send')
  await key('Enter');await wait(`document.querySelector('.kode-discussion-detail .kode-discussion-messages')?.innerText.includes('键盘第二行')`)
  const keyboard=(await call('collaboration/surfaces/channel/messages?thread_id='+cases[0].message.id)).items.filter(m=>m.content.includes('键盘第一行'))
  assert.equal(keyboard.length,1,JSON.stringify((await call('collaboration/surfaces/channel/messages?thread_id='+cases[0].message.id)).items.map(m=>m.content)));assert.equal(keyboard[0].content,'键盘第一行\n键盘第二行')
  await type(threadEditor,'重复点击只发一次')
  await wait(`!document.querySelector('.kode-discussion-detail button[aria-label="发送"]')?.disabled`)
  await page.evaluate(`(()=>{const b=document.querySelector('.kode-discussion-detail button[aria-label="发送"]');b.click();b.click()})()`)
  await wait(`document.querySelector('.kode-discussion-detail .kode-discussion-messages')?.innerText.includes('重复点击只发一次')`)
  assert.equal((await call('collaboration/surfaces/channel/messages?thread_id='+cases[0].message.id)).items.filter(m=>m.content==='重复点击只发一次').length,1)
  for(const c of cases){
   await openThread(c);await select('details.kode-discussion-task-tools > summary')
   await wait(`document.querySelector('[data-task-id="${c.task.id}"] [data-assignment-id="${c.assignment.id}"]')`)
   const other=cases.find(x=>x!==c)
   assert.equal(await page.evaluate(`!!document.querySelector('.kode-discussion-task-panel [data-assignment-id="${other.assignment.id}"]')`),false)
   await click('打开执行会话（只读）：'+c.assignment.worker.session_id)
   await wait(`document.querySelector('[data-native-session="${c.assignment.worker.session_id}"]')`)
   await assertCurrent(null)
   await openThread(c);await select('details.kode-discussion-task-tools > summary');await click('查看工作过程')
   await wait(`document.querySelector('.kode-collab-inspector .kode-collab-run-detail[data-run-id="${c.run.id}"]')?.innerText.includes('流程阶段')`)
   await assertCurrent(null,true)
   assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-run-detail').length`),1)
   assert.equal(await page.evaluate(`(()=>{const p=document.querySelector('.kode-collab-inspector');return p.scrollWidth<=p.clientWidth+1})()`),true,'execution inspector has no horizontal overflow')
   if(c.label==='A')await shot('02-exact-run-inspector')
   await select('button[aria-label="关闭执行详情"]')
   await wait(`document.querySelector('.kode-discussion-detail .kode-discussion-messages')?.innerText.includes(${JSON.stringify(c.reply)})`)
   await assertCurrent('产品设计')
  }
  await openThread(cases[0])
  await page.call('Emulation.setDeviceMetricsOverride',{width:1000,height:980,deviceScaleFactor:1,mobile:false})
  await wait(`getComputedStyle(document.querySelector('.kode-discussion-timeline')).display==='none'`)
  await shot('03-channel-thread-narrow-desktop')
  await page.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true})
  await page.evaluate(`fixture.ctx.layout.toggleSidebar()`);await new Promise(r=>setTimeout(r,500))
  await shot('04-channel-thread-mobile')
  assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`),true)
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:980,deviceScaleFactor:1,mobile:false});await page.evaluate(`fixture.ctx.layout.toggleSidebar()`)
  await collab();await select('[data-sidebar-row=team] [data-row-title]')
  await wait(`document.querySelector('.kode-collab-conversation [role=textbox]')?.isContentEditable`)
  await assertCurrent(null,true)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-inspector')`),null,'legacy DM has no default execution panel')
  assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-conversation textarea').length`),0)
  await wait(`document.querySelector('.kode-collab-question-empty')?.innerText.includes('暂无待回答问题')`)
  assert.equal(await page.evaluate(`document.querySelector('.kode-collab-question-empty').getBoundingClientRect().height<60`),true)
  const dmEditor='.kode-collab-conversation [role=textbox]'
  await replaceDraft(dmEditor,longDraft)
  const savedDm=await boundedDraft(dmEditor,'.kode-collab-conversation','.kode-collab-messages')
  await click('产品设计');await select('[data-sidebar-row=team] [data-row-title]')
  await wait(`document.querySelector(${JSON.stringify(dmEditor)})?.textContent.includes('长草稿第 36 行')`)
  assert.equal(await page.evaluate(`Array.from(document.querySelector(${JSON.stringify(dmEditor)}).children).map(p=>p.textContent).join(String.fromCharCode(10))`),longDraft)
  const persistedDm=await page.evaluate(`(async()=>{const found=[];for(const info of await indexedDB.databases()){const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(info.name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});try{for(const store of db.objectStoreNames){const rows=await new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});for(const entry of rows){const row=entry?.value;if(row?.format==='kode.conversation.view.v1'&&row.conversation_id===${JSON.stringify(team.conversation_id)})found.push(row.value.draft)}}}finally{db.close()}}return found})()`)
  assert.ok(persistedDm.includes(longDraft),'exact DM draft persisted in native storage')
  await replaceDraft(dmEditor)
  await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim().startsWith('展开完整原文'))`)
  await shot('05-direct-message-compact')
  await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim().startsWith('展开完整原文')).click()`)
  await wait(`document.querySelector('.kode-collab-conversation')?.innerText.includes('COMPLETE-ORIGINAL-END')`)
  const expandedText=await page.evaluate(`document.querySelector('.kode-collab-conversation [data-message-id="synthetic-long-reply"] .kode-collab-message-content').textContent`)
  for(const line of longOriginal.split('\n').filter(Boolean))assert.ok(expandedText.includes(line),'expanded Markdown retains every original line')
  assert.equal((await call('conversations/'+team.conversation_id+'/messages')).items.find(m=>m.id==='synthetic-long-reply').content,longOriginal)
  await shot('06-direct-message-original')
  assert.equal(await page.evaluate('fixture.created()'),0)
  const disallowed=writes.filter(({path})=>!path.includes('/messages')&&!path.endsWith('/read-state'))
  assert.deepEqual(disallowed,[],'browser navigation never changes tasks, assignments, budgets or activation')
  assert.deepEqual(await Promise.all(cases.map(c=>call('work-runs/'+c.run.id))),baseline.runs)
  assert.deepEqual(await Promise.all(cases.map(c=>call('collaboration/tasks/'+c.task.id))),baseline.tasks)
  assert.deepEqual(await call('budgets/budget'),baseline.budget);assert.deepEqual(await call('teams/team/activation'),baseline.activation)
  assert.deepEqual(await page.evaluate('fixtureErrors'),[])
  if(process.env.KODE_TEST_SCREENSHOTS){
   const sha256=async file=>createHash('sha256').update(await readFile(new URL(file,import.meta.url))).digest('hex')
   await writeFile(join(process.env.KODE_TEST_SCREENSHOTS,'channel-first-result.json'),JSON.stringify({
    verifiedAt:new Date().toISOString(),realIsolatedHub:true,syntheticDiscussionData:true,controlledExistingSessionSnapshots:true,
    collabBundleSha256:await sha256('../packages/collab/client.js'),nativeComposerBundleSha256:await sha256('../packages/composer/client.js'),
    workerModelsStarted:0,nativeSessionCreates:0,channelHomeDefault:true,emptyRegisteredWorkspaceGuidance:true,
    currentSidebarIndicator:{channelOnlyWhenDisplayed:true,discussionDmOnlyWhenDisplayed:true,teamDmClearsDiscussionIndicator:true,nativeSessionClearsDiscussionAndTeamIndicators:true,returnToChannelRestoresOnlyChannel:true},
    channelAndPrivateDraftIsolation:true,
    longDraft:{lines:36,root:{bounded:true,exactLocalStorageRestore:true},thread:{bounded:true,exactLocalStorageRestore:true},dm:{bounded:true,exactIndexedDbRestore:true},nativeScrollMaxHeight:'min(220px,25dvh)',sendAndMessageRegionRemainVisible:true},
    overflowInput:{originalCharacters:65535,chromiumComposition:{mechanism:'CDP Input.imeSetComposition preedit a, Input.insertText commit 中文',wholeCompositionRejected:true,originalRestoredAfterThreadSwitch:true,clearRejectionMessage:true},syntheticClipboard:{mechanism:'DOM ClipboardEvent with DataTransfer',overLimitPasteRejected:true,originalRestoredAfterThreadSwitch:true},operatingSystemImeTested:false},
    enterAndShiftEnter:true,duplicateSubmissionCount:1,escapeAndCloseRestoreFocus:true,exactTaskRunSessionSeparation:true,
    returnToOriginatingThread:true,executionInspectorNoHorizontalOverflow:true,compactEmptyClarificationState:true,
    originalTextPreserved:true,unchangedTaskRunBudgetActivation:true,viewports:[1440,1000,390],mobileNoHorizontalOverflow:true,
    screenshotEvidenceStrip:{heightPx:24,placement:'outside product root at viewport bottom',overlaysProduct:false},
   },null,2))
  }
 }finally{await browser?.close();if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r))}await hub.close();await rm(profile,{recursive:true,force:true})}
})
