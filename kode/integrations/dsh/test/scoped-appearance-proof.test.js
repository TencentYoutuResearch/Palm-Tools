/** Production bundle + production appearance components/API, persisted by disposable real Hub.
 * Native workspace controller geometry and all resource artwork are explicitly test fixtures. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdir,writeFile,readFile,copyFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {deflateSync} from 'node:zlib'
import {isolatedHub} from './support/isolated-hub.js'
import {conversationTeam} from './support/conversation-team.js'
import {collabRenderPage} from './support/collab-render-page.js'
import {headlessBrowser} from './support/headless-browser.js'
import {SessionAppearance,registerAvatarApi} from '../src/session-appearance.js'
import {registerCollabAppearance,teamAppearanceKey} from '../src/collab-appearance-route.js'
import {registerCollabTeams,registerCollabRuns} from '../src/collab-api.js'
import {registerConversation} from '../src/conversation-route.js'
import {registerConversationRead} from '../src/conversation-read-route.js'
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^0xffffffff)>>>0}
function png(){const w=960,h=720,rows=Buffer.alloc((w*3+1)*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const n=y*(w*3+1)+1+x*3,band=Math.sin(x/150+y/110)*12,t=y/h;rows[n]=Math.round(202+25*t+band);rows[n+1]=Math.round(217+14*t+band/2);rows[n+2]=Math.round(231+8*t)}const chunk=(type,data)=>{const name=Buffer.from(type),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([size,name,data,crc])},header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))])}

test('scoped IM uses native saved avatar/background with real document persistence across reload and Hub restart',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:90000},async()=>{
 const output=resolve('artifacts/scoped-sidebar-appearance');await mkdir(output,{recursive:true})
 const hub=await isolatedHub('appearance-proof'),profile=await mkdtemp(join(tmpdir(),'kode-appearance-browser-'));let browser,server
 const apiCalls=[],result={scope:'current shipped collab bundle; real Kode appearance facade/components/API and isolated Hub persistence; native shell/controllers are test fixtures',test_resources:true,model_calls:0,business_team_changes:false,screenshots:[]}
 try{
  const team=await conversationTeam(hub),identity={team_id:team.id,home_hub:team.home_hub,superagent_id:team.superagent_id}
  for(const [request_id,content] of [['resource-note','这是一条外观功能验证消息。头像使用测试 Kode 图标，背景是测试生成的浅蓝纹理，不代表真实账户身份。'],['persistence-note','请检查保存后的头像、背景，以及浅色桌面和深色窄屏的显示；本次没有调用模型。']])await hub.client.call(`/api/v1/messaging/conversations/${team.conversation_id}/messages`,{request_id,content})
  const avatars=join(hub.root,'avatars'),media=join(avatars,'gallery/测试资源-Kode/idle');await mkdir(media,{recursive:true})
  await copyFile('assets/agents/kode.png',join(media,'frame-01.png'));await writeFile(join(avatars,'gallery/测试资源-Kode/background.png'),png())
  await copyFile(join(media,'frame-01.png'),join(output,'test-avatar.png'));await writeFile(join(output,'test-background.png'),png())
  let appearance=new SessionAppearance(hub.client,{list:()=>[]},{avatarDirectory:avatars})
  const routes=[],ctx={webServer:{register:r=>{routes.push(r);return()=>{}}},connection:{admit:req=>(req.headers['x-fixture-owner']==='yes'||req.headers.cookie?.includes('appearance_fixture_owner=yes'))?{peer:{principal:{kind:'owner'}}}:{rejection:401}}}
  registerAvatarApi(ctx,appearance);registerCollabAppearance(ctx,{appearance,backendClient:hub.client})
  for(const register of [registerCollabTeams,registerCollabRuns,registerConversation,registerConversationRead])register(ctx,{backendClient:hub.client})
  const workspaces=[{workspaceId:'workspace',title:'外观验证 · 测试工作区',path:'/fixture',sessionIds:[],createdAt:new Date().toISOString()}]
  server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;if(path==='/')res.setHeader('set-cookie','appearance_fixture_owner=yes; Path=/; HttpOnly; SameSite=Strict');if(path.startsWith('/api/'))apiCalls.push({method:req.method,path});const route=routes.find(r=>r.kind==='prefix'?path.startsWith(r.path):path===r.path);if(route)return await route.handler(req,res);if(await collabRenderPage(req,res,{workspaces}))return;res.writeHead(404);res.end('{}')}catch(error){if(!res.headersSent)res.writeHead(500);res.end('{}')}})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page('http://127.0.0.1:'+server.address().port)
  const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+12000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,40))}throw Error('Appearance timeout: '+JSON.stringify({body:document.body.innerText,errors:fixtureErrors}))})()`)
  const button=async label=>{await wait(`Array.from(document.querySelectorAll('button')).some(b=>!b.disabled&&(b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)}))`);await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>!b.disabled&&(b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)})).click()`)}
  const open=async()=>{await wait(`document.querySelector('[data-sidebar-row=team] [data-row-title]')`);await page.evaluate(`document.querySelector('[data-sidebar-row=team] [data-row-title]').click()`);await wait(`document.querySelector('.kode-collab-composer :is(textarea,[contenteditable=true])')`)}
  await page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:940,deviceScaleFactor:1,mobile:false});await open();await button('SuperAgent 设置');await button('头像与背景')
  await wait(`document.querySelector('.kode-avatar-choice[title="测试资源-Kode"]')`);await page.evaluate(`document.querySelector('.kode-avatar-choice[title="测试资源-Kode"]').click()`)
  await wait(`document.querySelector('.kode-avatar-preview[data-has-background="true"] img')?.naturalWidth>0`)
  await page.evaluate(`Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`)
  {const shot=await page.call('Page.captureScreenshot',{format:'png'});await writeFile(join(output,'native-avatar-background-picker.png'),Buffer.from(shot.data,'base64'));result.screenshots.push('native-avatar-background-picker.png')}
  await page.evaluate(`document.querySelector('.kode-avatar-footer button:last-child').click()`)
  await wait(`!document.querySelector('.kode-avatar-editor')&&document.querySelector('[data-conversation-content][data-kode-scene]')`);await button('关闭设置')
  const index=(await hub.client.call('/api/v1/messaging/workbench/documents/session-index')).value
  assert.equal(index.presentation.sessionAvatars[teamAppearanceKey(team.home_hub,team.superagent_id)],'gallery/测试资源-Kode');assert.equal(index.presentation.agentAvatars,undefined)
  result.saved_via_native_choices=true;result.persisted_document=true
  await hub.stop();await hub.start();appearance=new SessionAppearance(hub.client,{list:()=>[]},{avatarDirectory:avatars});await appearance.load();assert.equal(appearance.avatarForSession(teamAppearanceKey(team.home_hub,team.superagent_id),'custom').id,'gallery/测试资源-Kode')
  // Existing BackendClient address is stable across this owned fixture restart.
  result.persisted_after_hub_restart=true
  await page.call('Page.reload');await open();await wait(`document.querySelector('[data-conversation-content][data-kode-scene]')&&document.querySelector('.kode-collab-header-avatar img')?.naturalWidth>0`)
  const inspect=()=>page.evaluate(`(()=>{const root=document.querySelector('[data-conversation-content]'),image=document.querySelector('.kode-collab-header-avatar img');return{scene:root.hasAttribute('data-kode-scene'),background:getComputedStyle(root).getPropertyValue('--kode-scene-image'),avatar:image.src,avatar_loaded:image.complete&&image.naturalWidth>0,errors:fixtureErrors,body_overflow:document.documentElement.scrollWidth>innerWidth}})()`)
  result.after_reload=await inspect();assert.equal(result.after_reload.scene,true);assert.equal(result.after_reload.avatar_loaded,true);assert.deepEqual(result.after_reload.errors,[])
  await page.evaluate(`(()=>{const mark=document.createElement('aside');mark.textContent='测试资源 / 测试工作区 · 真实外观 API · 无模型调用';mark.style='position:fixed;bottom:5px;right:6px;z-index:999999;padding:5px 8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:11px sans-serif';document.body.append(mark)})()`)
  const capture=async name=>{await page.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);const shot=await page.call('Page.captureScreenshot',{format:'png'});await writeFile(join(output,name),Buffer.from(shot.data,'base64'));result.screenshots.push(name)}
  await capture('desktop-light-native-appearance.png')
  await page.evaluate(`(()=>{const theme=fixture.ctx.theme.getTheme().themes.find(t=>t.colorScheme==='dark');document.body.setAttribute('data-ds-dark-theme','');document.documentElement.style.colorScheme='dark';for(const [k,v] of Object.entries(theme.tokens))document.documentElement.style.setProperty(k,v)})()`)
  await page.call('Emulation.setDeviceMetricsOverride',{width:430,height:844,deviceScaleFactor:1,mobile:false});await button('收起侧边栏');await wait(`document.querySelector('.kode-collab-unified-sidebar').dataset.wide==='false'`);await capture('narrow-dark-native-appearance.png')
  result.narrow=await inspect();assert.equal(result.narrow.body_overflow,false)
  // Native global preference must really remove and restore the scene.
  await page.evaluate(`localStorage.setItem('kode.avatar-background','off');dispatchEvent(new Event('kode-avatar-background'))`);await wait(`!document.querySelector('[data-conversation-content]').hasAttribute('data-kode-scene')`)
  await page.evaluate(`localStorage.setItem('kode.avatar-background','on');dispatchEvent(new Event('kode-avatar-background'))`);await wait(`document.querySelector('[data-conversation-content][data-kode-scene]')`)
  result.native_background_preference_verified=true;result.api_calls=apiCalls
  result.bundle_sha256=createHash('sha256').update(await readFile('packages/collab/client.js')).digest('hex')
 }finally{
  await writeFile(join(output,'evidence.json'),JSON.stringify(result,null,2)+'\n');await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await hub.close();await rm(profile,{recursive:true,force:true})
 }
})
