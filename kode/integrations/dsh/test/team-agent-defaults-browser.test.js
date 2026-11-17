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

const profiles=[{id:'tclaude',name:'tclaude',type:'claude',origin:'builtin'},{id:'codex',name:'Codex',type:'codex',origin:'builtin'}]
const catalogs={
 tclaude:{models:[{id:'opus-5.5',name:'Opus 5.5'},{id:'sonnet-5.5',name:'Sonnet 5.5'}],defaultModelSelection:{model:'opus-5.5'}},
 codex:{models:[{id:'gpt-6.1-sol',name:'GPT-6.1 Sol',reasoningEfforts:[{id:'medium',name:'中'},{id:'high',name:'高'}],defaultReasoningEffort:'medium'}],defaultModelSelection:{model:'gpt-6.1-sol',reasoningEffort:'medium'}},
}
const legacy={profileId:'tclaude',model:'opus-5.5',sourceProfileId:'old-reviewer',sourceProfileRevision:'a'.repeat(64)}
const team={id:'team',home_hub:'fixture-home',revision:4,superagent_id:'superagent-team',conversation_id:'conversation-team',spec:{name:'评审团队',workers:[],coordinator_targets:['control'],execution_targets:[{id:'control',host_id:'fixture-home',executor_profile_id:'codex',model_id:'gpt-6.1-sol'}]}}

// Fixture models only: nothing here reaches a real model, Session or microphone.
test('DM settings: one Agent and Reasonable/Lite preferences use legacy versioned saves without touching authorization',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:60000},async()=>{
 const profileDir=await mkdtemp(join(tmpdir(),'kode-team-defaults-'));let browser,server
 const prefs={revision:3,roles:{tester:structuredClone(legacy),superagent:{profileId:'codex',model:'gpt-6.1-sol',reasoningEffort:'medium'}}},posts=[],reads=[]
 const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))}
 try{
  const result=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {TeamAgentDefaults} from './packages/collab/team-agent-defaults.js';import {collaborationSettingsStyles} from './packages/collab/resource-settings-styles.js';
  const style=document.createElement('style');style.textContent=collaborationSettingsStyles;document.head.append(style);const node=document.createElement('div');node.id='team-defaults-test';node.className='kode-settings-page kode-collab-settings';document.body.append(node);createRoot(node).render(React.createElement(TeamAgentDefaults,{controls:fixture.ctx.get('kodeAgentControls'),team:${JSON.stringify(team)}}));`,resolveDir:process.cwd()},bundle:true,format:'iife',platform:'browser',external:['react','react-dom','react-dom/client','@deepseek-ai/dsh-client-ui-primitives'],write:false,banner:{js:'const require=name=>window.__KODE_TEST_MODULES__[name];'}})
  server=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://localhost')
   if(url.pathname==='/api/kode/agents'&&req.method==='GET'){
    reads.push(url.search);const id=url.searchParams.get('profile_id'),teamId=url.searchParams.get('team_id')
    return json(res,200,{profiles,selectedProfileId:'tclaude',supportedTypes:['claude','codex'],...(id?catalogs[id]:{models:[]}),...(teamId?{teamRolePreferences:{teamId,assignments:prefs.roles,preferenceRevision:prefs.revision,scope:'local_host',eligibleForExecution:false}}:{})})
   }
   if(url.pathname==='/api/kode/agents'&&req.method==='POST'){
    let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);posts.push(input)
    if(input.action!=='set-team-roles')return json(res,400,{error:'unexpected action'})
    if(input.expectedRevision!==prefs.revision)return json(res,409,{error:'Local preferences changed; reload before saving',scope:'local_host'})
    prefs.roles=structuredClone(input.assignments);prefs.revision++
    return json(res,200,{teamId:input.teamId,assignments:prefs.roles,preferenceRevision:prefs.revision,scope:'local_host',eligibleForExecution:false})
   }
   if(url.pathname==='/team-defaults-test.js'){res.setHeader('content-type','text/javascript');res.end(result.outputFiles[0].text);return}
   if(await collabRenderPage(req,res))return
   json(res,503,{})
  });server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profileDir);const page=await browser.page(`http://127.0.0.1:${server.address().port}/`)
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
  await page.evaluate(`new Promise((resolve,reject)=>{const run=()=>{if(!window.fixture)return setTimeout(run,20);const s=document.createElement('script');s.src='/team-defaults-test.js';s.onload=resolve;s.onerror=reject;document.head.append(s)};run()})`)
  const root='#team-defaults-test',q=s=>`document.querySelector('${root} ${s}')`
  const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('Team defaults timeout: '+${JSON.stringify(expr)}+' :: '+document.querySelector('${root}')?.innerText)})()`)
  const menu=async label=>{await wait(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).some(b=>b.textContent.includes(${JSON.stringify(label)}))`);await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).find(b=>b.textContent.includes(${JSON.stringify(label)})).click()`);await wait(`document.querySelectorAll('[role=menuitem],[role=menuitemradio]').length===0`)}
  const shots=process.env.KODE_ARTIFACT_DIR??resolve('../../../artifacts/builder-conversation-redesign-20261110');await mkdir(shots,{recursive:true})
  const shot=async name=>writeFile(join(shots,name),Buffer.from((await page.call('Page.captureScreenshot',{format:'png'})).data,'base64'))
  await wait(`${q('[data-model-tier="lite"] button[aria-label^="模型："]')}`)
  assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll('${root} [data-model-tier]')).map(n=>n.dataset.modelTier)`),['reasonable','lite'])
  assert.equal(await page.evaluate(`document.querySelectorAll('${root} [data-team-role],${root} [data-authorized-role]').length`),0)
  assert.doesNotMatch(await page.evaluate(`document.querySelector('${root}').innerText`),/添加组合|团队执行配置|本机默认 Agent|预算|额度/)
  await shot('dm-execution-models-1440.png')

  await page.evaluate(`${q('[data-execution-agent] button[aria-label^="Agent："]')}.click()`);await menu('tclaude')
  await wait(`document.querySelector('${root}').innerText.includes('已保存执行配置')`)
  assert.deepEqual(posts.at(-1),{action:'set-team-roles',teamId:'team',expectedRevision:3,assignments:{tester:legacy,superagent:{profileId:'tclaude',model:'opus-5.5'},superagent_lite:{profileId:'tclaude',model:'opus-5.5'}}})

  await page.evaluate(`${q('[data-model-tier="lite"] button[aria-label^="模型："]')}.click()`)
  await wait(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).some(b=>b.textContent.startsWith('模型'))`)
  await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).find(b=>b.textContent.startsWith('模型')).click()`)
  await wait(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).some(b=>b.textContent.includes('Sonnet 5.5'))`)
  await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem],[role=menuitemradio]')).find(b=>b.textContent.includes('Sonnet 5.5')).click()`)
  await wait(`document.querySelector('${root} [data-model-tier="lite"]').innerText.includes('Sonnet 5.5')`)
  assert.deepEqual(posts.at(-1).assignments.superagent,{profileId:'tclaude',model:'opus-5.5'})
  assert.deepEqual(posts.at(-1).assignments.superagent_lite,{profileId:'tclaude',model:'sonnet-5.5'})
  assert.deepEqual(posts.at(-1).assignments.tester,legacy)
  assert.equal(posts.at(-1).expectedRevision,4)
  await shot('dm-execution-models-saved-1440.png')
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await rm(profileDir,{recursive:true,force:true})}
})
