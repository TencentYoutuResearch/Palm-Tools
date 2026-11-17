/** Isolated style behavior checks. No daily profile, credentials or model access. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {headlessBrowser} from './support/headless-browser.js'
import {styles} from '../packages/collab/styles.js'

test('Emil polish retains immediate navigation, keyboard focus, touch targets and reduced motion', {skip:!process.env.KODE_TEST_BROWSER_BIN}, async()=>{
 const profile=await mkdtemp(join(tmpdir(),'kode-emil-polish-'))
 let browser
 const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<!doctype html><style>:root{--dsw-radius-sm:6px;--dsw-alias-border-l2:#ddd;--dsw-focus-ring-color:blue;--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#666}${styles}</style><section class="kode-discussions"><div class="kode-discussion-message">Root</div><div class="kode-discussion-message">Reply</div><button class="kode-discussion-reply">Open thread</button><button class="kode-discussion-reply" disabled>Disabled</button><div class="kode-discussion-detail"><header><button class="kode-collab-button kode-collab-icon-button">X</button></header></div><details class="kode-discussion-task-tools"><summary>Tasks</summary>Content</details><button class="kode-discussion-row">Channel</button></section>`)})
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile)
  const page=await browser.page('http://127.0.0.1:'+server.address().port)
  const css=selector=>page.evaluate(`(()=>{const s=getComputedStyle(document.querySelector(${JSON.stringify(selector)}));return {transition:s.transitionDuration,transform:s.transform,minHeight:s.minHeight,minWidth:s.minWidth,outline:s.outlineStyle,borderTop:s.borderTopWidth,backgroundSize:s.backgroundSize}})()`)
  assert.equal((await css('.kode-discussion-row')).transition,'0s')
  assert.equal((await css('.kode-discussion-message+.kode-discussion-message')).borderTop,'0px')
  assert.equal((await css('.kode-discussion-message+.kode-discussion-message')).backgroundSize,'calc(100% - 44px) 1px')
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
  await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
  assert.equal((await css('.kode-discussion-reply')).outline,'solid')
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '})
  assert.equal((await css('.kode-discussion-reply')).transform,'none','keyboard activation must not scale')
  await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32})
  if(await page.evaluate(`matchMedia('(hover:hover) and (pointer:fine)').matches`)){
   const point=await page.evaluate(`(()=>{const r=document.querySelector('.kode-discussion-reply').getBoundingClientRect();document.activeElement.blur();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
   // Chromium may serialize a settled identity transform as either `none` or
   // matrix(1, 0, 0, 1, 0, 0). Check geometry, not serialization or wall-clock timing.
   const awaitScale=async expected=>assert.equal(await page.evaluate(`(async()=>{
    const end=performance.now()+2000;let stable=0;
    while(performance.now()<end){
     const value=getComputedStyle(document.querySelector('.kode-discussion-reply')).transform;
     const m=value==='none'?new DOMMatrix():new DOMMatrix(value);
     const matches=m.is2D&&Math.abs(m.a-${expected})<0.000001&&Math.abs(m.d-${expected})<0.000001&&Math.abs(m.b)<0.000001&&Math.abs(m.c)<0.000001&&Math.abs(m.e)<0.000001&&Math.abs(m.f)<0.000001;
     stable=matches?stable+1:0;if(stable>=2)return true;
     await new Promise(resolve=>requestAnimationFrame(resolve));
    }return false;
   })()`),true,expected===1?'release returns to identity geometry':'pointer press settles at scale .97')
   await page.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point})
   await awaitScale(.97)
   await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point})
   await awaitScale(1)
  }
  await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  assert.equal((await css('.kode-discussion-reply')).transition,'0s')
  assert.equal((await css('.kode-collab-icon-button')).transition,'0s')
  assert.equal((await css('.kode-discussion-reply:disabled')).transform,'none')
  await page.call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
  assert.equal(await page.evaluate(`matchMedia('(pointer:coarse)').matches`),true)
  assert.equal((await css('.kode-discussion-reply')).minHeight,'44px')
  assert.equal((await css('.kode-collab-icon-button')).minWidth,'44px')
  assert.equal((await css('.kode-collab-icon-button')).minHeight,'44px')
  assert.equal((await css('.kode-discussion-task-tools>summary')).minHeight,'44px')
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true})}
})
