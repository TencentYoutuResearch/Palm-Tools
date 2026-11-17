/** Team Builder settings in the native right-Sidebar settings tab: planning Agent/model as
 * compact native pickers, the Kode session-mode avatar with its default-appearance dialog, and
 * the planning instruction saved through owner-only GET/PUT /api/kode/builder/settings. */
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
const catalogs={tclaude:{models:[{id:'opus-5.5',name:'Opus 5.5'}],defaultModelSelection:{model:'opus-5.5'}},codex:{models:[{id:'gpt-6.1-sol',name:'GPT-6.1 Sol'}],defaultModelSelection:{model:'gpt-6.1-sol'}}}
const BASE='你是 Team Builder。\n安全规则与输出协议……'
const doc=s=>({version:1,revision:s.revision,system_prompt:s.prompt,scope:'local_host',applies_to:'new_planning_sessions',default_system_prompt:BASE,default_system_prompt_version:'kode.builder.native-planning.v1',prompt_mode:'append'})

// Fixture only: no real model, Session, Hub document or preference is touched.
test('Team Builder settings: native pickers, session-mode avatar, planning instruction saved by CAS',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:90000},async()=>{
 const profileDir=await mkdtemp(join(tmpdir(),'kode-builder-home-'));let browser,server
 const settings={revision:2,prompt:''},puts=[],others=[];let conflictOnce=false
 const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))}
 try{
  const result=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';
  import {BuilderHomeSettings} from './packages/collab/builder-view.js';import {usePlanningChoice} from './packages/collab/builder-planning-controls.js';import {superagentSettingsStyles} from './packages/collab/superagent-settings-panel.js';
  const memory=new Map(),storage={read:async k=>memory.get(k)??null,save:async(k,v)=>{memory.set(k,v)}};
  function Tab(){const controls=fixture.ctx.get('kodeAgentControls');const planning=usePlanningChoice({controls,storage,home:'fixture-home',draftId:null});
   return React.createElement('section',{className:'kode-superagent-settings kode-superagent-settings-tab',style:{width:'480px',height:'100vh',overflow:'auto',borderLeft:'.5px solid var(--dsw-alias-border-l2)',background:'var(--dsw-alias-bg-base,#fff)'}},React.createElement('style',null,superagentSettingsStyles),
    React.createElement('div',{className:'kode-settings-main kode-superagent-settings-body'},React.createElement('div',{className:'kode-settings-page'},React.createElement(BuilderHomeSettings,{controls,planning,appearance:fixture.ctx.get('kodeAppearance')}))))}
  const node=document.createElement('div');node.id='builder-home-test';node.style='position:fixed;inset:0 0 0 auto;z-index:1';document.body.append(node);
  window.avatarDialogs=[];window.addEventListener('kode-avatar-dialog',e=>{window.avatarDialogs.push({profile:e.detail.profile.id,host:e.detail.host});e.stopImmediatePropagation()},true);
  createRoot(node).render(React.createElement(Tab));`,resolveDir:process.cwd()},
   bundle:true,format:'iife',platform:'browser',external:['react','react-dom','react-dom/client','@deepseek-ai/dsh-client-ui-primitives'],write:false,banner:{js:'const require=name=>window.__KODE_TEST_MODULES__[name];'}})
  server=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://localhost')
   if(url.pathname==='/api/kode/agents'&&req.method==='GET'){const id=url.searchParams.get('profile_id');return json(res,200,{profiles,selectedProfileId:'tclaude',supportedTypes:['claude','codex'],...(id?catalogs[id]:{models:[]})})}
   if(url.pathname==='/api/kode/builder/settings'&&req.method==='GET')return json(res,200,doc(settings))
   if(url.pathname==='/api/kode/builder/settings'&&req.method==='PUT'){
    let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);puts.push({input,headers:Object.keys(req.headers).filter(k=>/^(authorization|x-)/i.test(k)&&k!=='x-fixture-owner')})
    if(conflictOnce){conflictOnce=false;settings.revision++;settings.prompt='其它窗口';return json(res,409,{error:{code:'BUILDER_SETTINGS_CONFLICT',message:'changed'}})}
    if(input.expected_revision!==settings.revision)return json(res,409,{error:{code:'BUILDER_SETTINGS_CONFLICT',message:'changed'}})
    settings.revision++;settings.prompt=input.system_prompt;return json(res,200,doc(settings))
   }
   if(url.pathname==='/builder-home-test.js'){res.setHeader('content-type','text/javascript');res.end(result.outputFiles[0].text);return}
   if(req.method!=='GET')others.push(req.method+' '+url.pathname)
   if(await collabRenderPage(req,res))return
   json(res,503,{})
  });server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profileDir);const page=await browser.page(`http://127.0.0.1:${server.address().port}/`)
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
  await page.evaluate(`new Promise((resolve,reject)=>{const run=()=>{if(!window.fixture)return setTimeout(run,20);const s=document.createElement('script');s.src='/builder-home-test.js';s.onload=resolve;s.onerror=reject;document.head.append(s)};run()})`)
  const root='#builder-home-test'
  const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+20000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('Builder settings timeout: '+${JSON.stringify(expr)}+' :: '+document.querySelector('${root}')?.innerText)})()`)
  const status=()=>page.evaluate(`Array.from(document.querySelectorAll('${root} .kode-builder-prompt-settings [role=status]')).map(n=>n.textContent).join(' ')`)
  const button=label=>`Array.from(document.querySelectorAll('${root} button')).find(b=>b.textContent===${JSON.stringify(label)})`
  const type=value=>page.evaluate(`(()=>{const t=document.querySelector('${root} .kode-builder-prompt-settings textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(value)});t.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const shots=process.env.KODE_ARTIFACT_DIR??resolve('../../../artifacts/builder-conversation-redesign-20261110');await mkdir(shots,{recursive:true})
  const shot=async name=>writeFile(join(shots,name),Buffer.from((await page.call('Page.captureScreenshot',{format:'png'})).data,'base64'))

  await wait(`document.querySelector('${root} [data-builder-appearance="tclaude"]')&&document.querySelector('${root} .kode-builder-prompt-settings [aria-label="编辑补充指令"]')`)
  // Base instruction is shown read-only (no editor until the pencil), version visible; preference is "append".
  assert.equal(await page.evaluate(`document.querySelector('${root} .kode-builder-prompt-text').textContent`),BASE)
  assert.equal(await page.evaluate(`document.querySelectorAll('${root} .kode-builder-prompt-settings textarea').length`),0)
  assert.match(await page.evaluate(`document.querySelector('${root} .kode-builder-prompt-settings').textContent`),/kode\.builder\.native-planning\.v1[\s\S]*补充指令[\s\S]*未添加补充指令/)
  const edit=()=>page.evaluate(`document.querySelector('${root} [aria-label="编辑补充指令"]').click()`)
  assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll('${root} .kode-settings-group-title')).map(n=>n.textContent)`),['规划 Agent 与模型','规划指令'])
  // Native hierarchy: section 16/500, row title 14 regular, notes 12/18.
  assert.deepEqual(await page.evaluate(`(()=>{const f=s=>{const c=getComputedStyle(document.querySelector('${root} '+s));return [c.fontSize,c.fontWeight,c.lineHeight].join(' ')};return [f('.kode-settings-group-title'),f('.kode-team-role-row strong'),f('.kode-team-role-row .kode-config-note')]})()`),['16px 500 24px','14px 400 20px','12px 400 18px'])
  // Image-4 rows: pickers are the row's right-side control, compact and together, inside one settings card.
  const layout=await page.evaluate(`(()=>{const row=document.querySelector('${root} .kode-team-role-row').getBoundingClientRect(),p=document.querySelector('${root} .kode-team-role-pickers'),kids=Array.from(p.children).map(n=>n.getBoundingClientRect());return {rowRight:row.right,rowWidth:row.width,card:!!document.querySelector('${root} .kode-settings-card .kode-team-role-row'),first:kids[0].left,last:kids.at(-1).right,top:kids.map(k=>Math.round(k.top))}})()`)
  assert.ok(layout.card,'row sits in a settings card');assert.ok(layout.rowRight-layout.last<12,'pickers end at the row edge');assert.ok(layout.last-layout.first<layout.rowWidth*.6,'pickers stay compact');assert.equal(new Set(layout.top).size,1,'one line')
  // Session-mode appearance: the Kode Avatar for the planning Agent, and its native default-appearance dialog.
  assert.ok(await page.evaluate(`!!document.querySelector('${root} [data-builder-appearance="tclaude"] .kode-builder-appearance-avatar *')`),'Kode avatar rendered')
  await page.evaluate(`${button('设置默认外观')}.click()`)
  assert.deepEqual(await page.evaluate('window.avatarDialogs'),[{profile:'tclaude',host:'local'}])
  assert.equal(await page.evaluate(`getComputedStyle(${button('设置默认外观')}).whiteSpace`),'nowrap')
  await shot('builder-home-settings-480.png')

  await edit();await wait(`document.querySelector('${root} .kode-builder-prompt-settings textarea')`)
  // The editor holds only the supplement: the built-in text is never prefilled, and a pasted copy cannot be saved (it would load twice).
  assert.equal(await page.evaluate(`document.querySelector('${root} .kode-builder-prompt-settings textarea').value`),'')
  await type('补充：'+BASE)
  assert.equal(await page.evaluate(`${button('保存')}.disabled`),true)
  assert.match(await page.evaluate(`document.querySelector('${root} .kode-builder-prompt-settings [role=alert]').textContent`),/内建指令每次都会自动加载/)
  await type('')
  // Save: disabled until changed; one PUT with exactly {expected_revision, system_prompt}, no added auth headers.
  assert.equal(await page.evaluate(`${button('保存')}.disabled`),true)
  await type('优先拆成两到三名成员。');await page.evaluate(`${button('保存')}.click()`)
  await wait(`document.querySelector('${root} .kode-builder-prompt-settings [role=status]')?.textContent.startsWith('已保存')`)
  assert.deepEqual(puts.map(p=>p.input),[{expected_revision:2,system_prompt:'优先拆成两到三名成员。'}]);assert.deepEqual(puts[0].headers,[])
  assert.equal(await page.evaluate(`document.querySelector('${root} .kode-builder-prompt-append').textContent`),'优先拆成两到三名成员。','saved preference shown with its edit icon')
  // Conflict: nothing saved, server version reread, the user's edit kept in the editor.
  await edit();await wait(`document.querySelector('${root} .kode-builder-prompt-settings textarea')`);conflictOnce=true;await type('新的指令');await page.evaluate(`${button('保存')}.click()`)
  await wait(`document.querySelector('${root} .kode-builder-prompt-settings [role=status]')?.textContent.includes('其它窗口')`)
  assert.equal(await page.evaluate(`document.querySelector('${root} .kode-builder-prompt-settings textarea').value`),'新的指令')
  await page.evaluate(`${button('保存')}.click()`);await wait(`document.querySelector('${root} .kode-builder-prompt-settings [role=status]')?.textContent.startsWith('已保存')`)
  assert.equal(settings.prompt,'新的指令');assert.equal(puts.at(-1).input.expected_revision,4)
  await shot('builder-home-settings-saved-480.png')
  // Clear the preference = PUT "" (the base instruction stays).
  await edit();await wait(`${button('移除补充指令')}`)
  await page.evaluate(`${button('移除补充指令')}.click()`);await wait(`document.querySelector('${root} .kode-builder-prompt-settings [role=status]')?.textContent.startsWith('已移除补充指令')`)
  assert.equal(settings.prompt,'');assert.match(await status(),/已开始的规划不受影响/)
  assert.deepEqual(others,[],'no other writes')
 }finally{await browser?.close();server?.close();await rm(profileDir,{recursive:true,force:true})}
})
