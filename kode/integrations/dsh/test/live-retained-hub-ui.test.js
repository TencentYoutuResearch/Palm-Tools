/** Inspect and cancel one explicitly retained disposable Hub. Never restart Host execution or a model. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, realpath, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { BackendClient } from '../src/backend-client.js'
import { createServer } from 'node:http'
import { headlessBrowser } from './support/headless-browser.js'
import { collabRenderPage } from './support/collab-render-page.js'
import { registerCollabTeams, registerCollabRuns, registerCollabEvidence } from '../src/collab-api.js'
import { registerConversationRead } from '../src/conversation-read-route.js'
import { registerConversation } from '../src/conversation-route.js'
import { registerCollabBudgets } from '../src/collab-budgets-route.js'
import { registerWorkRun } from '../src/work-run-route.js'
import { registerWorkRunExecution } from '../src/work-run-execution-route.js'
import { registerWorkRunReceipt } from '../src/work-run-receipt-route.js'
import { registerWorkRunTrace } from '../src/work-run-trace-route.js'

test('retained real-run UI refresh and owner cancellation preserve unresolved stop/accounting',{
 skip:!process.env.KODE_TEST_RETAINED_HUB||!process.env.KODE_TEST_BROWSER_BIN||!process.env.KODE_TEST_LIVE_EVIDENCE_DIR,timeout:90000,
},async t=>{
 const root=await realpath(process.env.KODE_TEST_RETAINED_HUB)
 assert.ok(basename(root).startsWith('kode-hub-fixture-'))
 const config=JSON.parse(await readFile(join(root,'config.json'),'utf8'));assert.equal(config.node_id,'official-coordinator')
 const readOnly=process.env.KODE_TEST_RETAINED_UI_READ_ONLY==='1'
 const output=process.env.KODE_TEST_LIVE_EVIDENCE_DIR;await mkdir(output,{recursive:true,mode:0o700})
 const profile=await mkdtemp(join(tmpdir(),'kode-retained-ui-'))
 let child,browser,server
 const binary=fileURLToPath(new URL('../../../target/debug/kode-session-server',import.meta.url))
 const summary={scope:'retained_isolated_hub_with_current_shipped_ui_and_controlled_native_shell',host_runtime_started:false,additional_model_requests:0,business_teams_touched:false}
 try{
  child=spawn(binary,['--config',join(root,'config.json'),'--token-file',join(root,'admin.token'),'--bind','127.0.0.1:0'],{env:{...process.env,KODE_GUI_STATE_PATH:join(root,'gui-state.json'),KODE_CLOUD_SYNC_CONFIG:join(root,'cloud-sync.json'),KODE_MEMORY_ROOT:join(root,'memory')},stdio:['ignore','pipe','ignore']})
  const address=await new Promise((resolve,reject)=>{let bytes='';const timer=setTimeout(()=>reject(Error('Retained fixture startup timeout')),10000);child.once('error',reject);child.stdout.on('data',chunk=>{bytes=(bytes+chunk).slice(-8192);const match=bytes.match(/kode-session-server [a-zA-Z0-9_-]+ (127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1])}})})
  // Only this fixture's generated token enters memory. It never reaches browser, logs or evidence.
  const client=new BackendClient('http://'+address,(await readFile(join(root,'admin.token'),'utf8')).trim()),hub={root,node:config.node_id,client}
  const runs=(await client.call('/api/v1/messaging/work-runs/active')).items
  assert.equal(runs.length,1);const runId=runs[0].id,runPath='/api/v1/messaging/work-runs/'+encodeURIComponent(runId)
  const before=await client.call(runPath),team=(await client.call('/api/v1/messaging/teams?limit=50')).items.find(x=>x.id===before.team_id)
  assert.ok(team);summary.before={run_id:runId,state:before.state,revision:before.revision}
  const routes=new Map(),commands=[]
  const ctx={get:()=>undefined,webServer:{register:route=>routes.set(route.path,route)},connection:{admit:req=>req.headers['x-fixture-owner']==='yes'?{peer:{principal:{kind:'owner'}}}:{rejection:401}}}
  const proxy={call:async(path,body)=>{if(body&&path==='/api/v1/messaging/conversations/'+encodeURIComponent(team.conversation_id)+'/read-state'){assert.deepEqual(Object.keys(body),['through_sequence']);assert.ok(Number.isSafeInteger(body.through_sequence)&&body.through_sequence>=0);return client.call(path,body)}if(body){assert.equal(path,runPath,'only owner cancellation or read acknowledgement may mutate this retained fixture');assert.equal(body.action,'request_cancel');commands.push({path,body:structuredClone(body)})}return client.call(path,body)}}
  for(const register of [registerCollabTeams,registerCollabRuns,registerCollabEvidence,registerConversation,registerConversationRead,registerCollabBudgets,registerWorkRun,registerWorkRunExecution,registerWorkRunReceipt,registerWorkRunTrace])register(ctx,{backendClient:proxy,quotaHost:hub.node})
  server=createServer(async(req,res)=>{try{const route=routes.get(new URL(req.url,'http://localhost').pathname);if(route)return await route.handler(req,res);if(await collabRenderPage(req,res,{hub}))return;res.writeHead(404);res.end()}catch{if(!res.headersSent)res.writeHead(500);res.end()}})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile)
  const page=await browser.page('http://127.0.0.1:'+server.address().port)
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false})
  const wait=expr=>page.evaluate(`(async()=>{const until=Date.now()+15000;while(Date.now()<until){if(${expr})return;await new Promise(r=>setTimeout(r,50))}throw Error('Retained UI state not reached')})()`)
  const click=async label=>{await wait(`Array.from(document.querySelectorAll('button')).some(x=>x.textContent.trim()===${JSON.stringify(label)}&&!x.disabled)`);await page.evaluate(`Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim()===${JSON.stringify(label)}&&!x.disabled).click()`)}
  const open=async()=>{await wait('globalThis.fixture');await page.evaluate(`document.querySelector('[data-sidebar-section=channels] summary')?.click()`);await wait(`document.querySelector('[data-sidebar-row=team] [data-row-title]')`);await page.evaluate(`Array.from(document.querySelectorAll('[data-sidebar-row=team] [data-row-title]')).find(x=>x.textContent==='Team').click()`);await click('工作过程');await click('查看详情');await wait(`document.querySelector('.kode-collab-run-detail')`)}
  const shot=async name=>{const png=await page.call('Page.captureScreenshot',{format:'png'});await writeFile(join(output,name),Buffer.from(png.data,'base64'),{mode:0o600})}
  await open();await page.evaluate(`document.querySelector('.kode-collab-run-detail')?.scrollIntoView({block:'center'})`);summary.initial_ui={run_detail_present:true,message_count:await page.evaluate(`document.querySelectorAll('.kode-collab-message-content').length`)};await shot(readOnly?'retained-real-cancelling-desktop-clean.png':'retained-real-failure-before-cancel.png')
  await page.call('Page.reload');await open();summary.refresh_before_cancel=true
  if(!readOnly){
  await click('取消任务');await click('确认请求取消')
  await wait(`document.querySelector('.kode-collab-run-cancel')?.innerText.includes('执行停止尚未确认')`)
  assert.equal(commands.length,1);const after=await client.call(runPath)
  assert.equal(after.state,'cancelling');assert.notEqual(after.cancellation?.stop_confirmed,true);assert.notEqual(after.cancellation?.resources_released,true)
  // Receipt recovery replays precisely the existing command; never invent a new request or stop proof.
  const replay=await client.call(commands[0].path,commands[0].body)
  assert.equal(replay.id,after.id);assert.equal((await client.call(runPath)).revision,after.revision)
  summary.after={state:after.state,revision:after.revision,stop_confirmed:after.cancellation?.stop_confirmed??false,resources_released:after.cancellation?.resources_released??false}
  summary.same_command_replay_preserves_revision=true
  }else{summary.owner_cancel_not_repeated=true;assert.equal((await client.call(runPath)).state,'cancelling')}
  await page.call('Page.reload');await open();await wait(`document.querySelector('.kode-collab-run-cancel')?.innerText.includes('执行停止尚未确认')`)
  summary.refresh_after_cancel=true;summary.read_route_registered=true;await wait(`!document.body.innerText.includes('已读状态暂未同步')`);summary.read_sync_error_present=false;summary.ui_errors=await page.evaluate('globalThis.fixtureErrors');assert.deepEqual(summary.ui_errors,[])
  await page.evaluate(`document.querySelector('.kode-collab-run-cancel')?.scrollIntoView({block:'center'})`)
  await shot(readOnly?'retained-real-cancelling-desktop-detail-clean.png':'retained-real-failure-after-cancel.png')
  summary.owner_cancel_command_count=commands.length;summary.result=readOnly?'read_only_refresh_preserves_unconfirmed_cancellation':'request_cancel_confirmed_drain_and_accounting_unconfirmed'
 }catch(error){summary.result='ui_verification_failed';summary.failure={name:error.name,code:typeof error.code==='number'?error.code:null};throw error}
 finally{
  await writeFile(join(output,readOnly?'retained-ui-read-only-result.json':'retained-ui-result.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600})
  await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
  if(child?.pid&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGINT');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);try{await done}finally{clearTimeout(timer)}}await rm(profile,{recursive:true,force:true})
 }
})
