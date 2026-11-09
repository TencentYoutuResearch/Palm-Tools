/** Actual released dsh CLI/base/web-app plus worktree plugins; isolated profile, no inference. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { isolatedHub } from './support/isolated-hub.js'
import { fullDesktopProfile } from './support/full-desktop-profile.js'
const runtime=process.env.KODE_TEST_DSH_RUNTIME_MODULES
test('full dsh shell preserves native and IM drafts, Session identity and team authority across mode switches', {skip:!runtime||!process.env.KODE_TEST_BROWSER_BIN||!process.env.KODE_TEST_BACKEND_URL,timeout:60000},async()=>{
const hub=await isolatedHub('desktop-probe')
let desktop
try {
 const {conversationTeam}=await import('./support/conversation-team.js');await conversationTeam(hub)
 desktop=await fullDesktopProfile(hub)
 const {page,root}=desktop
 const wait=predicate=>page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${predicate})return;await new Promise(r=>setTimeout(r,25))}throw Error('Full-shell UI condition timed out')})()`)
 const button=label=>`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`
 await page.evaluate(`globalThis.probeErrors=[];addEventListener('error',e=>probeErrors.push(e.message));addEventListener('unhandledrejection',e=>probeErrors.push(String(e.reason)))`);
 await page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false})
 await wait(button('继续'))
 await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='继续')?.click()`);
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
 const sessionBefore=await page.evaluate('probeSession()');assert.equal(sessionBefore.selected.length,1)
 const authorityPaths=['team-grants/grant','teams/team/activation','teams/team/work-runs?limit=50','budgets/budget']
 const authoritative=()=>Promise.all(authorityPaths.map(p=>hub.client.call('/api/v1/messaging/'+p)))
 const before=await authoritative()
 const nativeDraft='原生 Session 草稿 471'; const imDraft='IM 草稿 471'
 await page.evaluate(`document.querySelector('[data-composer-input]').focus()`)
 await page.call('Input.insertText',{text:nativeDraft})
 assert.equal(await page.evaluate(`document.querySelector('[data-composer-input]').innerText`),nativeDraft)
 await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]').click()`)
 await wait(`Array.from(document.querySelectorAll('.kode-collab-contact')).some(b=>b.textContent.includes('Team'))`)
 await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-contact')).find(b=>b.textContent.includes('Team'))?.click()`)
 await wait(`document.querySelector('.kode-collab-composer textarea')`)

 const imSelector='.kode-collab-composer textarea'
 await page.evaluate(`document.querySelector(${JSON.stringify(imSelector)}).focus()`)
 await page.call('Input.insertText',{text:imDraft})
 await page.evaluate(`document.querySelector('[aria-label="切换到 Session 模式"]').click()`)
 await wait(`document.querySelector('[data-composer-input]')?.isContentEditable`)
 assert.equal(await page.evaluate(`document.querySelector('[data-composer-input]').innerText`),nativeDraft)
 await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]').click()`)
 await wait(`document.querySelector('.kode-collab-composer textarea')`)
 assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(imSelector)}).value`),imDraft)
 assert.deepEqual(await page.evaluate('probeSession()'),sessionBefore)
 assert.deepEqual(await authoritative(),before)
 assert.deepEqual(await page.evaluate('probeErrors'),[])



} finally {
 await desktop?.close();await hub.close()
}
})
