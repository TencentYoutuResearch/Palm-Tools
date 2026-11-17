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
test('interop settings require a successful load, preserve edits on failure and save complete local settings',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:60000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'kode-interop-ui-'));let browser,server
 try{
 const built=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {SessionInteropSettings} from './packages/collab/session-interop-settings.js';
 window.interop={writes:[],reads:0};const request=async settings=>{if(settings===undefined){if(++interop.reads===1)throw Error('owner-only load failed');return {scope:'local_host',summary:null,grants:[],profiles:[{id:'safe',name:'Safe local profile',models:['listed-model'],reasoningEfforts:[]}]}}interop.writes.push(settings);if(interop.writes.length===1)throw Error('save response unavailable');return settings};
 const root=document.createElement('div');root.id='interop-test';root.style='position:fixed;inset:0;background:white;z-index:99999';document.body.append(root);createRoot(root).render(React.createElement(SessionInteropSettings,{request}));`,resolveDir:process.cwd()},bundle:true,format:'iife',platform:'browser',external:['react','react-dom/client','@deepseek-ai/dsh-client-ui-primitives'],write:false,banner:{js:'const require=name=>window.__KODE_TEST_MODULES__[name];'}})
 server=createServer(async(req,res)=>{if(req.url==='/interop-test.js'){res.setHeader('content-type','text/javascript');res.end(built.outputFiles[0].text);return}if(await collabRenderPage(req,res))return;res.writeHead(404);res.end()});server.listen(0,'127.0.0.1');await once(server,'listening')
 browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page(`http://127.0.0.1:${server.address().port}/`)
 await page.evaluate(`new Promise((resolve,reject)=>{const run=()=>{if(!window.fixture)return setTimeout(run,20);const s=document.createElement('script');s.src='/interop-test.js';s.onload=resolve;s.onerror=reject;document.head.append(s)};run()})`)
 const wait=expression=>page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expression})return;await new Promise(r=>setTimeout(r,20))}throw Error('Interop UI wait failed')})()`)
 const click=text=>page.evaluate(`Array.from(document.querySelectorAll('#interop-test button')).find(b=>b.textContent===${JSON.stringify(text)}).click()`)
 await wait(`document.querySelector('#interop-test [role=alert]')`)
 assert.equal(await page.evaluate(`document.querySelectorAll('#interop-test fieldset').length`),0)
 assert.equal(await page.evaluate(`interop.writes.length`),0)
 await click('重新加载本机设置');await wait(`document.querySelector('#interop-test fieldset')`)
 assert.equal(await page.evaluate(`document.querySelector('#interop-test details.kode-interop-grants').open`),false,'per-Session grants are folded by default; saved grants stay intact')
 await page.evaluate(`document.querySelector('#interop-test input[type=checkbox]').click()`)
 await wait(`document.querySelector('#interop-test select')`)
 await page.evaluate(`const s=document.querySelector('#interop-test select');s.value='safe';s.dispatchEvent(new Event('change',{bubbles:true}))`)
 await click('添加精确会话授权')
 await page.evaluate(`const inputs=Array.from(document.querySelectorAll('#interop-test input:not([type=checkbox])'));for(let i=0;i<inputs.length;i++){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inputs[i],i?'target-session':'source-session');inputs[i].dispatchEvent(new Event('input',{bubbles:true}))}`)
 await page.evaluate(`document.querySelectorAll('#interop-test input[type=checkbox]')[1].click()`)
 await click('保存本机会话互通设置');await wait(`document.querySelector('#interop-test [role=alert]')?.textContent.includes('save response')`)
 assert.equal(await page.evaluate(`document.querySelector('#interop-test input[aria-label="来源会话 ID 1"]').value`),'source-session')
 await click('保存本机会话互通设置');await wait(`document.querySelector('#interop-test [role=status]')?.textContent==='已保存到本机。'`)
 assert.deepEqual(await page.evaluate(`interop.writes[1]`),{summary:{profile_id:'safe',model:'listed-model'},grants:[{source:'source-session',target:'target-session',actions:['summary']}]})
 assert.ok(await page.evaluate(`document.querySelector('#interop-test').textContent.includes('不发送工具调用记录、工具结果或隐藏的系统记录')`))
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await rm(profile,{recursive:true,force:true})}
})
