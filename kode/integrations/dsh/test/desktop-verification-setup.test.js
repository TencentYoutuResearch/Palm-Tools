/** Full released dsh shell -> fresh Builder draft -> owner command review, no inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { realpath,writeFile } from 'node:fs/promises'
import { isolatedHub } from './support/isolated-hub.js'
import { fullDesktopProfile } from './support/full-desktop-profile.js'
test('full desktop fresh Builder draft registers owner verification command and recovers lost response after reload',{skip:!process.env.KODE_TEST_DSH_RUNTIME_MODULES||!process.env.KODE_TEST_BROWSER_BIN||!process.env.KODE_TEST_BACKEND_URL,timeout:60000},async()=>{
 const hub=await isolatedHub('desktop-verification');let desktop
 try{
  desktop=await fullDesktopProfile(hub);const {page}=desktop
  await page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false})
  const wait=predicate=>page.evaluate(`(async()=>{const end=Date.now()+12000;while(!(${predicate})){if(Date.now()>end)throw Error('Desktop verification UI timeout: '+document.body.innerText.slice(0,1600));await new Promise(r=>setTimeout(r,25))}})()`)
  const button=label=>`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`
  const click=label=>page.evaluate(`${button(label)}.click()`)
  await wait(button('继续'));await click('继续')
  await wait(`!document.querySelector('dialog[open],[role=dialog][aria-modal=true]')`)
  await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]')?.click()`)
  await page.evaluate(`document.querySelector('[aria-label="展开联系人"]')?.click()`)
  await wait(button('团队搭建助手'));await click('团队搭建助手')
  await wait(`document.querySelector('.kode-collab-builder-create textarea')`)
  await page.evaluate(`document.querySelector('.kode-collab-builder-create textarea').focus()`)
  await page.call('Input.insertText',{text:'UI command setup fixture'})
  await wait(button('保存目标并继续'));await click('保存目标并继续')
  await wait(`Array.from(document.querySelectorAll('summary')).some(e=>e.textContent==='配置本机验证命令')`)
  const openReview=async()=>{await page.evaluate(`Array.from(document.querySelectorAll('summary')).find(e=>e.textContent==='配置本机验证命令').click()`);await wait(`document.querySelector('.kode-collab-verification-setup button')&&!document.querySelector('.kode-collab-verification-setup button').disabled`)}
  await openReview()
  for(const [label,text] of [['命令标识','review-smoke'],['可执行文件绝对路径',await realpath(process.execPath)],['参数（JSON 数组）','["--version"]']]){
   await page.evaluate(`(()=>{const e=Array.from(document.querySelectorAll('.kode-collab-verification-setup label')).find(e=>e.textContent===${JSON.stringify(label)}).querySelector('input');e.focus();e.select()})()`)
   await page.call('Input.insertText',{text})
  }
  await page.evaluate(`globalThis.commandPosts={preview:0,confirm:0};const original=fetch;globalThis.fetch=async(...args)=>{const res=await original(...args);if(String(args[0])==='/api/kode/verification/review'&&args[1]?.method==='POST'){const action=JSON.parse(args[1].body).action;commandPosts[action]++;if(action==='confirm'&&res.ok){await res.clone().json();throw Error('fixture committed registration reply lost')}}return res}`)
  await click('核对验证命令');await wait(button('确认登记此命令'))
  assert.deepEqual(await page.evaluate('commandPosts'),{preview:1,confirm:0})
  await click('返回修改');await click('核对验证命令');await wait(button('确认登记此命令'))
  await click('确认登记此命令');await wait(button('恢复原命令登记'))
  assert.deepEqual(await page.evaluate('commandPosts'),{preview:2,confirm:1})
  const query='/api/kode/verification/definitions?runner_id=local&command_id=review-smoke&revision=1'
  const read=()=>page.evaluate(`fetch(${JSON.stringify(query)}).then(async r=>{if(!r.ok)throw Error('registry read failed');return r.json()})`)
  const registered=await read();assert.equal(registered.execution_performed,false)
  await page.call('Page.reload')
  await wait(`document.querySelector('[aria-label="切换到 Session 模式"]')||document.querySelector('[aria-label="切换到 IM 模式"]')`)
  await page.evaluate(`document.querySelector('[aria-label="切换到 IM 模式"]')?.click();document.querySelector('[aria-label="展开联系人"]')?.click()`)
  await wait(button('团队搭建助手'));await click('团队搭建助手')
  await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('UI command setup fixture · 草案'))`)
  await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('UI command setup fixture · 草案')).click()`)
  await wait(`Array.from(document.querySelectorAll('summary')).some(e=>e.textContent==='配置本机验证命令')`)
  await openReview();await wait(button('恢复原命令登记'));await click('恢复原命令登记')
  await wait(`document.querySelector('.kode-collab-verification-setup').innerText.includes('验证命令已登记。')`)
  assert.deepEqual(await read(),registered)
  assert.deepEqual((await hub.client.call('/api/v1/messaging/teams')).items,[])
  await page.evaluate(`document.querySelector('.kode-collab-verification-setup').scrollIntoView({block:'start'})`)
  const screenshot=await page.call('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/superagent-desktop-verification-504.png',Buffer.from(screenshot.data,'base64'))
 }finally{await desktop?.close();await hub.close()}
})
