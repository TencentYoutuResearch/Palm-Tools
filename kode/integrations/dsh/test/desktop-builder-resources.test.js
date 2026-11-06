import { join } from 'node:path'
/** Full released desktop; optional unpaid adapter saves an actual scoped proposal. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { realpath, writeFile } from 'node:fs/promises'
import { isolatedHub } from './support/isolated-hub.js'
import { fullDesktopProfile } from './support/full-desktop-profile.js'
import { desktopTeamSetup } from './support/desktop-team-setup.js'
for(const startBuilder of [false,true])test(`full desktop fresh Builder resources and controlled startup (start=${startBuilder})`,{skip:!process.env.KODE_TEST_DSH_RUNTIME_MODULES||!process.env.KODE_TEST_BROWSER_BIN||!process.env.KODE_TEST_BACKEND_URL,timeout:120000},async()=>{
 const hub=await isolatedHub('desktop-resources');let desktop
 try{
  desktop=await fullDesktopProfile(hub,{metadataOnly:true,builderRead:startBuilder,versionedProject:startBuilder,managedSessionProbe:startBuilder});const {page,root}=desktop
  await page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false})
  const wait=async(predicate,timeout=12000,failOnProgression=false)=>{
   const end=Date.now()+timeout;let nextDiagnostic=0
   while(!await page.evaluate(`Boolean(${predicate})`)){
    if(failOnProgression&&Date.now()>=nextDiagnostic){
     nextDiagnostic=Date.now()+500
     const status=await page.evaluate(`fetch('/api/kode/test-metadata').then(r=>r.json())`)
     if(status.workRunStates?.some(row=>row.blocked&&row.state==='progression_failed'))throw Error('Workflow progression is fenced: '+JSON.stringify(status))
    }
    if(Date.now()>end){
     const diagnostics=await page.evaluate(`(async()=>({ui:document.body.innerText.slice(0,1800),metadata:await fetch('/api/kode/test-metadata').then(r=>r.json())}))()`)
     throw Error('Desktop UI timeout: '+predicate+' '+JSON.stringify(diagnostics))
    }
    await new Promise(resolve=>setTimeout(resolve,25))
   }
  }
  const button=label=>`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`
  const click=label=>page.evaluate(`${button(label)}.click()`)
  await wait(button('继续'));await click('继续')
  await wait(`!document.querySelector('dialog[open],[role=dialog][aria-modal=true]')`)
 await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='选择工作区')?.click()`);
 await wait(`Array.from(document.querySelectorAll('button,[role=option],[role=menuitem]')).some(b=>b.textContent.trim()==='创建项目…')`);
 await page.evaluate(`Array.from(document.querySelectorAll('button,[role=option],[role=menuitem]')).find(b=>b.textContent.trim()==='创建项目…')?.click()`);
 await wait(button('添加文件夹'));
 await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='添加文件夹')?.click()`);
 await wait(`document.querySelector('button[aria-label="编辑路径"]')`);
 await page.evaluate(`document.querySelector('button[aria-label="编辑路径"]').click()`)
 await wait(`document.querySelector('input[aria-label="编辑路径"]')`)
 await page.evaluate(`document.querySelector('input[aria-label="编辑路径"]').select()`)
 await page.call('Input.insertText',{text:join(root,'project')})
 await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
 await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
 await wait(button('打开'))
 await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='打开')?.click()`)
 await wait(button('创建项目'))
 await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='创建项目'&&!b.disabled)?.click()`)
 await wait(`globalThis.probeSession?.().selected.length===1&&document.querySelector('[data-composer-input]')?.isContentEditable`)
 const initialNativeSession=await page.evaluate(`probeSession().selected[0]`)

  await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]')?.click()`)
  await page.evaluate(`document.querySelector('[aria-label="展开联系人"]')?.click()`)
  await wait(button('团队搭建助手'));await click('团队搭建助手')
  await wait(`document.querySelector('.kode-collab-builder-create textarea')`)
  await page.evaluate(`document.querySelector('.kode-collab-builder-create textarea').focus()`)
  await page.call('Input.insertText',{text:'UI command setup fixture'})
  await wait(button('保存目标并继续'));await click('保存目标并继续')
  await wait(`document.querySelector('.kode-collab-builder h2')?.textContent==='UI command setup fixture'`)
  const drafts=(await hub.client.call('/api/v1/messaging/superagents/drafts')).items
  assert.equal(drafts.length,1);const draftPath='/api/v1/messaging/superagents/drafts/'+drafts[0].id
  await wait(`document.querySelector('.kode-collab-workspace-form select')&&!document.querySelector('.kode-collab-workspace-form select').disabled`)
  await page.evaluate(`(()=>{const e=document.querySelector('.kode-collab-workspace-form select');e.value=${JSON.stringify(hub.node)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await wait(`document.querySelector('.kode-collab-workspace-option input')`)
  await page.evaluate(`document.querySelector('.kode-collab-workspace-option input').click()`)
  await click('保存工作区')
  await wait(button('保存助手资源'))
  assert.equal((await hub.client.call(draftPath+'/selection')).record,null)
  await click('保存助手资源')
  await wait(`document.querySelector('.kode-collab-selection-form').innerText.includes('助手资源选择已保存')`)
  const selection=(await hub.client.call(draftPath+'/selection')).record
  assert.equal(selection.selection.profile_id,'official');assert.equal(selection.selection.provider,'fixture');assert.equal(selection.selection.model,'fixture-model')
  await page.evaluate(`document.querySelector('[aria-label="账户归属标识"]').focus()`)
  await page.call('Input.insertText',{text:'owner-account'})
  await click('核对账户绑定');await wait(button('确认账户绑定'));await click('确认账户绑定')
  await wait(`document.querySelector('.kode-collab-account-form').innerText.includes('账户绑定已确认')`)
  for(const [label,text] of [['预算单位','credits'],['创建预算总额','100'],['每百万输入 token 内部计价','1'],['每百万缓存输入 token 内部计价','1'],['每百万输出 token 内部计价','1']]){
   await page.evaluate(`document.querySelector('[aria-label="${label}"]').focus()`);await page.call('Input.insertText',{text})
  }
  await page.evaluate(`(()=>{const e=document.querySelector('[aria-label="预算到期时间"]'),date=new Date(Date.now()+3600000);date.setMinutes(date.getMinutes()-date.getTimezoneOffset());Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,date.toISOString().slice(0,16));e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await click('核对预算与权限');await wait(button('确认创建预算与草案权限'));await click('确认创建预算与草案权限')
  await wait(`document.querySelector('.kode-collab-funding-form').innerText.includes('创建预算与草案权限已配置')`)
  const funded=(await hub.client.call(draftPath+'/funding')).record
  assert.equal(funded.budget.limit,100);assert.equal(funded.budget.spent,0);assert.equal(funded.budget.reserved,0)
  assert.deepEqual((await hub.client.call('/api/v1/messaging/teams')).items,[])
  assert.deepEqual(await page.evaluate(`fetch('/api/kode/test-metadata').then(r=>r.json())`),{calls:0})
  if(startBuilder){
   await page.evaluate(`Array.from(document.querySelectorAll('summary')).find(e=>e.textContent==='配置本机验证命令').click()`)
   await wait(`document.querySelector('.kode-collab-verification-setup button')&&!document.querySelector('.kode-collab-verification-setup button').disabled`)
   for(const [label,text] of [['命令标识','desktop-check'],['可执行文件绝对路径',await realpath(process.execPath)],['参数（JSON 数组）',JSON.stringify(['-e',"if(require('node:fs').readFileSync('implemented.txt','utf8')!=='implemented')process.exit(3)"])]]){
    await page.evaluate(`(()=>{const e=Array.from(document.querySelectorAll('.kode-collab-verification-setup label')).find(e=>e.textContent===${JSON.stringify(label)}).querySelector('input');e.focus();e.select()})()`)
    await page.call('Input.insertText',{text})
   }
   await click('核对验证命令');await wait(button('确认登记此命令'));await click('确认登记此命令')
   await wait(`document.querySelector('.kode-collab-verification-setup').innerText.includes('验证命令已登记。')`)
   await page.evaluate(`document.querySelector('[aria-label="本次预留预算"]').focus()`);await page.call('Input.insertText',{text:'60'})
   await page.evaluate(`document.querySelector('.kode-collab-start-form input[type=checkbox]').click()`)
   await click('核对启动配置');await wait(button('确认启动创建助手'));await click('确认启动创建助手')
   await wait(`document.querySelector('.kode-collab-start-form').innerText.includes('助手创建已确认')`)
   assert.deepEqual(await page.evaluate(`fetch('/api/kode/test-metadata').then(r=>r.json())`),{calls:0})
   await wait(`document.querySelector('[aria-label="给创建助手的消息"]')&&!document.querySelector('[aria-label="给创建助手的消息"]').disabled`)
   await page.evaluate(`document.querySelector('[aria-label="给创建助手的消息"]').focus()`);await page.call('Input.insertText',{text:'请读取草案并总结下一步。'})
   await page.evaluate(`document.querySelector('.kode-collab-builder-conversation form button[type=submit]').click()`)
   await wait(`document.body.innerText.includes('已保存团队草案。流程、执行资源和交付条件仍需配置，团队尚未激活。')`)
   const observed=await page.evaluate(`fetch('/api/kode/test-metadata').then(r=>r.json())`)
   assert.equal(observed.calls,5);assert.equal(observed.globalHasBuilder,false);assert.equal(observed.lastModel,'fixture-model');assert.ok(observed.tools.includes('kode_builder_read_draft'))
   assert.ok(!observed.tools.some(t=>t.startsWith('kode_sessions_')))
   const saved=await hub.client.call(draftPath)
   assert.equal(saved.actor.kind,'builder');assert.equal(saved.request_id,'desktop-proposal')
   assert.equal(saved.interview.proposed_team.name,'桌面创建的团队草案')
   assert.deepEqual(saved.interview.questions,[{id:'delivery',prompt:'这支团队完成任务时，你希望收到哪些交付物？'}])
   assert.deepEqual(saved.interview.proposed_team.workspace_refs,saved.interview.workspace_refs)
   assert.deepEqual(saved.interview.proposed_workflow.workflow.stages.map(s=>s.id),['implement','review','verify'])
   const reference=await page.evaluate(`fetch('/api/kode/verification/definitions?runner_id=local&command_id=desktop-check&revision=1').then(r=>r.json())`)
   assert.equal(saved.interview.proposed_workflow.project.spec.commands.check.definition_hash,reference.reference.definition_hash)
   const workflowPath='/api/v1/messaging/workflows/desktop-flow/versions/1'
   await assert.rejects(hub.client.call(workflowPath),{status:404},'Builder proposal cannot register a workflow')
   await wait(button('核对工作流方案'));await click('核对工作流方案')
   await wait(button('确认登记流程配置'));await click('确认登记流程配置')
   await wait(`document.querySelector('.kode-collab-workflow-proposal').innerText.includes('流程配置已登记。')`)
   const workflow=await hub.client.call(workflowPath)
   assert.equal(workflow.id,'desktop-flow');assert.match(workflow.hash,/^[a-f0-9]{64}$/)
   assert.equal((await hub.client.call(draftPath)).revision,saved.revision,'Owner version registration does not rewrite the draft')
   await page.evaluate(`document.querySelector('[aria-label="给创建助手的消息"]').focus()`);await page.call('Input.insertText',{text:'请使用刚登记的流程版本更新团队方案。'})
   await page.evaluate(`document.querySelector('.kode-collab-builder-conversation form button[type=submit]').click()`)
   await wait(`document.body.innerText.includes('团队方案已引用实际登记的流程、项目和交付版本，执行资源仍待配置，尚未激活。')`)
   const linked=await hub.client.call(draftPath)
   const version=row=>({id:row.id,version:row.version,hash:row.hash})
   const project=await hub.client.call('/api/v1/messaging/project-configs/desktop-project/versions/1')
   const delivery=await hub.client.call('/api/v1/messaging/project-configs/desktop-delivery/versions/1')
   assert.equal(linked.request_id,'desktop-linked-proposal');assert.equal(linked.actor.kind,'builder')
   assert.deepEqual(linked.interview.proposed_team.workflow_pack_refs,[version(workflow)])
   assert.deepEqual(linked.interview.proposed_team.delivery_bindings,[{id:'local',workflow:version(workflow),project:version(project),delivery_policy:version(delivery)}])
   assert.equal((await page.evaluate(`fetch('/api/kode/test-metadata').then(r=>r.json())`)).calls,12)
   assert.doesNotMatch(await page.evaluate(`document.querySelector('.kode-collab-builder-conversation').innerText`),/Current runtime context|Current DSH file policy|Current DeepSeek Harness implementation checkout/)
   assert.deepEqual((await hub.client.call('/api/v1/messaging/teams')).items,[])
   await desktopTeamSetup({page,wait,button,click})
   const teams=(await hub.client.call('/api/v1/messaging/teams')).items
   assert.equal(teams.length,1)
   assert.equal(teams[0].spec.execution_targets[0].model_id,'fixture-model')
   assert.deepEqual(teams[0].spec.workers.map(w=>w.role),['author','reviewer','verifier'])
   assert.equal((await hub.client.call('/api/v1/messaging/teams/'+teams[0].id+'/activation')).active,true)
   assert.equal((await page.evaluate(`fetch('/api/kode/test-metadata').then(r=>r.json())`)).calls,12,'Activation alone must not infer or run Workers')
   // Commit the owner-approved close, lose only its HTTP reply, then recover
   // the immutable IndexedDB command after a real desktop reload.
   await wait(button('核对结束本次搭建'));await click('核对结束本次搭建')
   await wait(button('确认结束并释放创建预留'))
   await page.evaluate(`(()=>{const original=globalThis.fetch;globalThis.closeWires=[];globalThis.fetch=async function(url,options){const closing=String(url)==='/api/kode/builder/close';if(closing)globalThis.closeWires.push(JSON.parse(options.body));const response=await original.apply(this,arguments);if(closing&&response.status===200)throw Error('fixture dropped committed close reply');return response}})()`)
   await click('确认结束并释放创建预留');await wait(button('恢复本次结束'))
   const closeWire=await page.evaluate(`globalThis.closeWires[0]`)
   assert.ok(closeWire?.command?.request_id)
   assert.equal(await page.evaluate(`document.querySelector('[aria-label="给创建助手的消息"]').disabled`),true)
   const creationBudgetPath='/api/v1/messaging/budgets/'+funded.budget.id
   const closedBudget=(await hub.client.call(creationBudgetPath)).budget
   assert.equal(closedBudget.limit,100);assert.equal(closedBudget.spent,1);assert.equal(closedBudget.reserved,0)
   await page.call('Page.reload')
   await wait(`globalThis.probeSession`)
   await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]')?.click()`)
   await page.evaluate(`document.querySelector('[aria-label="展开联系人"]')?.click()`)
   await wait(button('团队搭建助手'));await click('团队搭建助手')
   await wait(button('UI command setup fixture · 草案'));await click('UI command setup fixture · 草案')
   await wait(button('恢复本次结束'))
   await page.evaluate(`(()=>{const original=globalThis.fetch;globalThis.closeWires=[];globalThis.fetch=function(url,options){if(String(url)==='/api/kode/builder/close')globalThis.closeWires.push(JSON.parse(options.body));return original.apply(this,arguments)}})()`)
   await click('恢复本次结束')
   await wait(`document.querySelector('.kode-collab-builder-close')?.innerText.includes('本次搭建已结束。创建预算已对账，剩余预留已释放。')`)
   assert.deepEqual(await page.evaluate(`globalThis.closeWires`),[closeWire],'reload retries the same owner-approved close identity')
   assert.equal(await page.evaluate(`document.querySelector('[aria-label="给创建助手的消息"]')`),null)
   await wait(`document.querySelector('.kode-collab-builder-conversation')?.innerText.includes('团队方案已引用实际登记的流程、项目和交付版本')`)
   assert.equal((await hub.client.call(creationBudgetPath)).budget.spent,1,'historical close cannot charge again')
   assert.equal((await page.evaluate(`fetch('/api/kode/test-metadata').then(r=>r.json())`)).calls,12,'close and recovery must not infer')
   await wait(`Array.from(document.querySelectorAll('.kode-collab-contact-name')).some(e=>e.textContent==='桌面创建的团队草案')`)
   await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-contact-name')).find(e=>e.textContent==='桌面创建的团队草案').click()`)
   await wait(`document.querySelector('.kode-collab-composer textarea')`)
   await page.evaluate(`document.querySelector('.kode-collab-composer textarea').focus()`)
   await page.call('Input.insertText',{text:'帮我实现这个需求：生成 implemented.txt，内容为 implemented。'})
   await wait(`document.querySelector('.kode-collab-composer button[type=submit]')&&!document.querySelector('.kode-collab-composer button[type=submit]').disabled`)
   await page.evaluate(`document.querySelector('.kode-collab-composer button[type=submit]').click()`)
   await wait(`Array.from(document.querySelectorAll('.kode-collab-message-content')).some(e=>e.textContent==='桌面需求已完成实现、独立评审和实际命令验证，交付证据已归档。')`,45000,true)
   const runs=await page.evaluate(`fetch('/api/kode/collab/runs?team_id=${teams[0].id}&limit=25&after=').then(r=>r.json())`)
   assert.equal(runs.items.length,1)
   const run=await hub.client.call('/api/v1/messaging/work-runs/'+runs.items[0].id)
   assert.equal(run.state,'completed');assert.equal(run.completion_authorized,true)
   assert.deepEqual(run.stages.map(s=>s.state),['passed','passed','passed'])
   assert.equal(new Set(run.stages.map(s=>s.assignment_id)).size,3)
   assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-contact-name').length`),1,'Workers must not appear as IM contacts')
   await wait(button('工作过程'));await click('工作过程');await wait(button('查看详情'));await click('查看详情')
   await wait(`document.querySelector('.kode-collab-run-detail')?.innerText.includes('Hub 已确认交付')`)
   assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-stage-evidence').length`),3)
   await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-evidence-detail button')).forEach(e=>e.click())`)
   await wait(`Array.from(document.querySelectorAll('.kode-collab-evidence-detail')).some(e=>e.innerText.includes('退出码：0'))`)
   const deliveredScreenshot=await page.call('Page.captureScreenshot',{format:'png'})
   await writeFile('/tmp/superagent-desktop-verified-delivery.png',Buffer.from(deliveredScreenshot.data,'base64'))
   const budgetQuery='/api/kode/collab/budgets?team_id='+teams[0].id
   const readBudget=()=>page.evaluate(`fetch(${JSON.stringify(budgetQuery)}).then(r=>r.json())`)
   let accounting;const accountingDeadline=Date.now()+12000
   do{
    accounting=await readBudget()
    if(accounting.budgets.every(b=>b.budget.reserved===0))break
    await new Promise(resolve=>setTimeout(resolve,100))
   }while(Date.now()<accountingDeadline)
   assert.equal(accounting.label,'团队预算');assert.equal(accounting.budgets.length,1)
   const finalMetrics=await page.evaluate(`fetch('/api/kode/test-metadata').then(r=>r.json())`),teamBudget=accounting.budgets[0]
   assert.deepEqual(finalMetrics.workers,[4,4,3])
   assert.equal(teamBudget.budget.limit,3000);assert.equal(teamBudget.budget.reserved,0,JSON.stringify({budget:teamBudget.budget,metrics:finalMetrics}))
   assert.equal(teamBudget.budget.spent,2*(finalMetrics.calls-12),'reviewed team price is one internal credit per token; creation calls are separate')
   assert.equal(teamBudget.available,3000-teamBudget.budget.spent)
   await click('收起工作过程');await click('团队预算');await wait(button('核对预算修改'))
   await page.evaluate(`const e=document.querySelector('.kode-collab-budget-form input');e.focus();e.select()`)
   await page.call('Input.insertText',{text:'3050'})
   await click('核对预算修改');await wait(button('确认修改团队预算'));await click('确认修改团队预算')
   await wait(`document.querySelector('.kode-collab-budget-form').innerText.includes('团队预算已保存。')`)
   const changed=(await readBudget()).budgets[0]
   assert.equal(changed.budget.limit,3050);assert.equal(changed.budget.spent,teamBudget.budget.spent);assert.equal(changed.budget.reserved,0)
   assert.equal((await page.evaluate(`fetch('/api/kode/test-metadata').then(r=>r.json())`)).calls,finalMetrics.calls,'budget review/configuration does not invoke inference')
   await click('收起预算');await click('工作过程');await wait(button('查看详情'));await click('查看详情')
   await wait(button('查看内部会话诊断'));await click('查看内部会话诊断')
   await wait(`document.querySelectorAll('.kode-collab-session-diagnostics li').length===3`)
   const diagnostic=await hub.client.call('/api/v1/messaging/work-runs/'+run.id+'/diagnostics?run_revision='+run.revision)
   const worker=diagnostic.items[0].worker.session_id
   const observe=()=>page.evaluate(`fetch('/api/kode/test-session-observation?session_id='+${JSON.stringify(worker)}).then(r=>r.json())`)
   const beforeReadOnly=await observe()
   assert.equal(beforeReadOnly.session_id,worker);assert.ok(beforeReadOnly.events>0)
   const ownership=await page.evaluate(`fetch('/api/kode/managed-session?session_id='+${JSON.stringify(worker)}).then(r=>r.json())`)
   assert.deepEqual({session:ownership.session_id,host:ownership.host,home:ownership.home_hub,assignment:ownership.managed?.assignment_id,operation:ownership.managed?.operation_id,readonly:ownership.read_only},
    {session:worker,host:diagnostic.items[0].worker.node_id,home:run.home_hub,assignment:diagnostic.items[0].assignment_id,operation:diagnostic.items[0].operation.id,readonly:true})
   await wait(button('打开原生会话（只读）'));await click('打开原生会话（只读）')
   await wait(`probeSession().selected[0]===${JSON.stringify(worker)} && document.querySelector('.kode-managed-session-banner')?.innerText.includes('受管会话，只读排障')`)
   await wait(`document.body.innerText.includes('阶段证据已归档。')`)
   assert.deepEqual(await observe(),beforeReadOnly,'native history reading preserves cold Agent state')
   assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('[data-composer-input]')).some(element=>element.isContentEditable)`),false)
   for(const method of ['prompt','cancel','rename']){
    const result=await page.evaluate(`probeNativeCommand(${JSON.stringify(worker)},${JSON.stringify(method)})`)
    assert.match(JSON.stringify(result),/协作流程管理/)
    assert.deepEqual(await observe(),beforeReadOnly,method+' rejection must preserve the cold Agent')
   }
   const denied=await page.evaluate(`fetch('/api/kode/agents',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'select',sessionId:${JSON.stringify(worker)},profileId:'official',model:'fixture-model'})}).then(response=>response.status)`)
   assert.equal(denied,403)
   assert.deepEqual(await observe(),beforeReadOnly,'read-only navigation and rejected writes preserve history and Agent activation')
   assert.equal((await page.evaluate(`fetch('/api/kode/test-metadata').then(r=>r.json())`)).calls,finalMetrics.calls)
   const readOnlyScreenshot=await page.call('Page.captureScreenshot',{format:'png'})
   await writeFile('/tmp/superagent-native-readonly-693.png',Buffer.from(readOnlyScreenshot.data,'base64'))
   const ordinary=await page.evaluate(`probeOpenSession(${JSON.stringify(initialNativeSession)})`)
   await wait(`probeSession().selected[0]===${JSON.stringify(ordinary)} && document.querySelector('[data-composer-input]')?.isContentEditable`)
   await page.evaluate(`document.querySelector('[data-composer-input]').focus()`)
   await page.call('Input.insertText',{text:'ordinary draft after read-only inspection'})
   await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]').click()`)
   await wait(`document.querySelector('.kode-collab-composer textarea')`)
   await page.evaluate(`document.querySelector('[aria-label="切换到 Session 模式"]').click()`)
   await wait(`probeSession().selected[0]===${JSON.stringify(ordinary)} && document.querySelector('[data-composer-input]')?.textContent.includes('ordinary draft after read-only inspection')`)
   await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]').click()`)
   await wait(`document.querySelector('.kode-collab-composer textarea')`)
   if(await page.evaluate(`Boolean(${button('团队预算')})`))await click('团队预算')
   await wait(button('核对预算修改'))
  }
  await page.evaluate(`document.querySelector('.kode-collab-budget-form,.kode-collab-funding-form').scrollIntoView({block:'start'})`)
  const screenshot=await page.call('Page.captureScreenshot',{format:'png'});await writeFile(startBuilder?'/tmp/superagent-desktop-delivery-budget.png':'/tmp/superagent-desktop-configuration.png',Buffer.from(screenshot.data,'base64'))
 }catch(error){
  // Preserve the bounded assertion diagnostic even if a test-owned runtime
  // handle later delays Node's reporter shutdown.
  await writeFile(`/tmp/superagent-desktop-start-${startBuilder}-failure.json`,JSON.stringify({message:String(error.message),host:desktop?.diagnostics?.()}))
  throw error
 }finally{try{await desktop?.close()}finally{await hub.close()}}
})
