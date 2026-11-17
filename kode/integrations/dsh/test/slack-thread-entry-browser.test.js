/** Isolated CSS interaction test: no external browser profile or model invocation. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {headlessBrowser} from './support/headless-browser.js'
import {collaborationLayout} from '../packages/collab/collaboration-layout.js'

test('Slack thread entrances support pointer hover, keyboard focus and touch without animating navigation',{skip:!process.env.KODE_TEST_BROWSER_BIN},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'kode-thread-entry-'));let browser
 const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<!doctype html><style>:root{--dsw-alias-bg-base:#fff;--dsw-alias-border-l2:#ddd;--dsw-focus-ring-color:blue}.kode-discussion-message{position:relative;margin:80px;width:600px;padding:24px}${collaborationLayout}</style><section class="kode-discussions"><article class="kode-discussion-message"><p>需求正文保持清楚</p><button class="kode-discussion-reply kode-discussion-reply-action">回复</button><button class="kode-discussion-thread-summary"><span class="kode-discussion-reply-avatars"><span class="kode-discussion-avatar">A</span></span>3 条回复</button></article></section>`)})
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile)
  const page=await browser.page('http://127.0.0.1:'+server.address().port)
  const action=()=>page.evaluate(`(()=>{const s=getComputedStyle(document.querySelector('.kode-discussion-reply-action'));return {opacity:s.opacity,pointer:s.pointerEvents,height:s.minHeight,position:s.position}})()`)
  if(await page.evaluate(`matchMedia('(hover:hover) and (pointer:fine)').matches`)){
   assert.equal((await action()).opacity,'0');assert.equal((await action()).pointer,'none')
   const point=await page.evaluate(`(()=>{const r=document.querySelector('article').getBoundingClientRect();return {x:r.left+20,y:r.top+20}})()`)
   await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});assert.equal((await action()).opacity,'1')
   await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:5});assert.equal((await action()).opacity,'0')
  }
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
  await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
  assert.equal(await page.evaluate(`document.activeElement.classList.contains('kode-discussion-reply-action')`),true)
  assert.equal((await action()).opacity,'1');assert.equal((await action()).pointer,'auto')
  await page.call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
  assert.equal((await action()).position,'static');assert.equal((await action()).height,'44px')
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.kode-discussion-thread-summary')).minHeight`),'44px')
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true})}
})
