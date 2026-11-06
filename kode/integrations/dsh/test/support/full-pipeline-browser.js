/** Complete released desktop shell connected to actual native Host/Hub execution. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { fullDesktopProfile } from './full-desktop-profile.js'
export async function fullPipelineBrowser(hub,onInput){
 let sends=0
 const desktop=await fullDesktopProfile(hub),{page,root}=desktop,close=desktop.close
 try {
  await page.call('Page.addScriptToEvaluateOnNewDocument',{source:`globalThis.probeErrors=[];addEventListener('error',e=>probeErrors.push(e.message));addEventListener('unhandledrejection',e=>probeErrors.push(String(e.reason)))`})
  await page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false})
  await page.evaluate(`globalThis.probeErrors=[];addEventListener('error',e=>probeErrors.push(e.message));addEventListener('unhandledrejection',e=>probeErrors.push(String(e.reason)));globalThis.desktopSends=0;const original=fetch;globalThis.fetch=async(...args)=>{const result=await original(...args);if(String(args[0]).split('?')[0]==='/api/kode/conversation/messages'&&args[1]?.method==='POST'&&result.ok){desktopSends++;globalThis.desktopInput=await result.clone().json()}return result}`)
  const ready=()=>page.evaluate(`!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='继续')`)
  for(let i=0;i<400&&!await ready();i++)await new Promise(r=>setTimeout(r,50))
  assert.equal(await ready(),true,'first-launch notice must be ready before interaction')
  await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='继续').click()`)
    const wait = async expression => {try{return await page.evaluate(`(async()=>{const until=Date.now()+15000;while(Date.now()<until){if(${expression})return;await new Promise(r=>setTimeout(r,25))}const e=document.querySelector('.kode-collab-composer textarea');throw Error('Pipeline state timeout: '+JSON.stringify({body:document.body.innerText.slice(0,1500),draft:e?.value,disabled:e?.disabled,rect:e?.getBoundingClientRect().toJSON(),ancestors:e?Array.from((function*(n){while(n){yield n;n=n.parentElement}})(e)).map(n=>({tag:n.tagName,inert:n.inert,hidden:n.hidden,aria:n.getAttribute('aria-hidden'),style:getComputedStyle(n).display})):[],dialogs:Array.from(document.querySelectorAll('dialog')).map(d=>({open:d.open,modal:d.matches(':modal'),html:d.outerHTML.slice(0,500)})),focus:document.activeElement?.tagName,focusProbe:globalThis.focusProbe,sameNode:e===globalThis.probeElement,oldConnected:globalThis.probeElement?.isConnected}))})()`)}catch(error){const shot=await page.call('Page.captureScreenshot',{format:'png'}).catch(()=>null);if(shot)await writeFile('/tmp/superagent-full-pipeline-failure.png',Buffer.from(shot.data,'base64'));throw error}}

    const button=label=>`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`
 if(process.env.KODE_TEST_FULL_DESKTOP_NO_WORKSPACE!=='1'){
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

 }
    await wait(`!document.querySelector('dialog[open], [role=dialog][aria-modal=true]')`)
    await wait(`document.querySelector('[aria-label="切换到 IM 模式"]')||document.querySelector('[aria-label="切换到 Session 模式"]')`)
    await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]')?.click()`)
    await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='展开')?.click()`)
    await wait(`document.querySelector('.kode-collab-contact-name')`)
    await page.evaluate(`document.querySelector('.kode-collab-contact-name').click()`)
    await wait(`document.querySelector('.kode-collab-composer textarea')`)
    return {
      async switchDuring(runId) {
        const before=await hub.client.call('/api/v1/messaging/work-runs/'+runId)
        assert.notEqual(before.state,'completed');assert.ok(before.stages.some(s=>s.assignment_id),'real Worker assignment exists')
        const grant=await hub.client.call('/api/v1/messaging/team-grants/grant')
        for(let i=0;i<3;i++){
          await page.evaluate(`document.querySelector('[aria-label="切换到 Session 模式"]').click()`)
          await wait(`document.querySelector('[data-composer-input]')`)
          await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]').click()`)
          await wait(`document.querySelector('.kode-collab-composer textarea')`)
        }
        assert.deepEqual(await hub.client.call('/api/v1/messaging/work-runs/'+runId),before)
        assert.deepEqual(await hub.client.call('/api/v1/messaging/team-grants/grant'),grant)
      },
      async send(content) {
        await page.call('Page.bringToFront')
        await page.evaluate(`const e=document.querySelector('.kode-collab-composer textarea');e.scrollIntoView({block:'center'});globalThis.focusProbe={};globalThis.probeElement=e;document.addEventListener('focusin',v=>{focusProbe.lastFocus=v.target.tagName});document.addEventListener('focusout',v=>{focusProbe.lastBlur=v.target.tagName});e.focus();focusProbe.immediate=document.activeElement===e` )
        await wait(`document.activeElement===document.querySelector('.kode-collab-composer textarea')`)
        const rect=await page.evaluate(`(()=>{const r=document.querySelector('.kode-collab-composer textarea').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
        await page.call('Input.dispatchMouseEvent',{type:'mousePressed',...rect,button:'left',clickCount:1})
        await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',...rect,button:'left',clickCount:1})
        await page.call('Input.insertText', { text: content })
        await wait(`document.querySelector('.kode-collab-composer textarea').value===${JSON.stringify(content)}&&!document.querySelector('.kode-collab-composer button[type="submit"]').disabled`)
        await page.evaluate(`document.querySelector('.kode-collab-composer button[type="submit"]').click()`)
        await wait(`document.body.innerText.includes('Hub 已接收')`)
        const human=await page.evaluate('globalThis.desktopInput');assert.ok(human);sends=await page.evaluate('desktopSends');assert.equal(sends,1);onInput(human);return human
      },
      async verifyResult({ reload = false } = {}) {
        if (reload) {
          await page.call('Page.reload')
          await wait(`document.querySelector('[aria-label="切换到 IM 模式"]')||document.querySelector('[aria-label="切换到 Session 模式"]')`)
          await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]')?.click()`)
          await wait(`document.querySelector('.kode-collab-contact-name')`)
          await page.evaluate(`document.querySelector('.kode-collab-contact-name').click()`)
        }
        await wait(`Array.from(document.querySelectorAll('.kode-collab-message-content')).some(node => node.textContent.includes('Implementation, independent review and verification completed.'))`)
        await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '工作过程').click()`)
        await wait(`document.querySelector('.kode-collab-run')`)
        await page.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === '查看详情').click()`)
        await wait(`document.querySelector('.kode-collab-run-detail')?.innerText.includes('Hub 已确认交付')`)
        assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-stage-evidence').length`), 3)
        await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-evidence-detail button')).forEach(button => button.click())`)
        await wait(`document.querySelectorAll('.kode-collab-evidence-detail').length === 3 && Array.from(document.querySelectorAll('.kode-collab-evidence-detail')).every(node => node.innerText.includes('这是已记录的证据'))`)
        const evidence = await page.evaluate(`Array.from(document.querySelectorAll('.kode-collab-evidence-detail')).map(node => node.innerText)`)
        assert.ok(evidence.some(text => text.includes('补丁哈希')))
        assert.equal(evidence.filter(text => text.includes('结论：通过')).length, 2)
        assert.ok(evidence.some(text => text.includes('退出码：0')))
        assert.equal(sends,1)
        assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-contact-name').length`), 1, 'Workers are not IM contacts')
        assert.deepEqual(await page.evaluate('globalThis.probeErrors'), [])
      }, close,
    }
  } catch (error) { const ui=await page.evaluate(`document.body.innerText.slice(0,1800)`).catch(()=>'<unavailable>');await close();throw new Error('Full pipeline browser failed: '+ui,{cause:error}) }
}
