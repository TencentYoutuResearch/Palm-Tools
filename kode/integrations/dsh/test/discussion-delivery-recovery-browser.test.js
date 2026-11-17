import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {build} from 'esbuild'
import {headlessBrowser} from './support/headless-browser.js'
import {collabRenderPage} from './support/collab-render-page.js'
test('original row explicit recovery uses native icon and leaves new composer text untouched',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:60000},async()=>{
 const bundle=(await build({entryPoints:['packages/collab/discussion-delivery-recovery.js'],bundle:true,format:'cjs',platform:'browser',external:['react','@deepseek-ai/dsh-client-ui-primitives'],write:false})).outputFiles[0].text
 const profile=await mkdtemp(join(tmpdir(),'kode-recovery-'));let browser,server
 try{server=createServer(async(req,res)=>{if(req.url==='/recovery.js'){res.end(bundle);return}if(await collabRenderPage(req,res))return;res.writeHead(404);res.end()});server.listen(0,'127.0.0.1');await once(server,'listening');browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page('http://127.0.0.1:'+server.address().port)
 const wait=e=>page.evaluate(`(async()=>{for(let i=0;i<400;i++){if(${e})return;await new Promise(r=>setTimeout(r,25))}throw Error('timeout')})()`)
 await wait('globalThis.fixture')
 await page.evaluate(`(async()=>{const R=__KODE_TEST_MODULES__.react,h=R.createElement,m={exports:{}};new Function('require','module','exports',await(await fetch('/recovery.js')).text())(n=>__KODE_TEST_MODULES__[n],m,m.exports);const binding={binding_id:'binding',native_session_id:'native',first_source_message_id:'source',surface_id:'surface',thread_id:'source',home_hub:'home',workspace:{host_id:'home',workspace_id:'work',root_ref:'/work'}};window.recoveryCalls=[];window.recoveryUpdates=0;const message={actor:{kind:'human',id:'local_owner'},interactive_selection:{workspace_id:'work'},delivery_state:'stored_only',id:'source',surface_id:'surface',thread_id:'source',scope:{home_hub:'home',host_id:'home',workspace_id:'work',root_ref:'/work'}};const request=async(p,b)=>{recoveryCalls.push({path:p,body:b});return b?{state:'published',binding,message_id:'reply'}:{binding,source_message_id:'source',state:'bound',recovery:{recovery_allowed:true,state:'recoverable',native_absent:true,never_claimed:true,automatic_replay_allowed:false}}};fixture.ctx.slots.register({name:'main',key:'recovery'},()=>h('div',null,h('textarea',{'aria-label':'新草稿',defaultValue:'不要清除的新内容'}),h(m.exports.DiscussionDelivery,{message,request,onUpdated:()=>recoveryUpdates++})));fixture.ctx.layout.selectPanel('recovery')})()`)
 await wait(`document.querySelector('[aria-label="核对原请求"]')`)
 assert.equal(await page.evaluate('recoveryCalls.length'),0)
 await page.evaluate(`document.querySelector('[aria-label="核对原请求"]').click()`)
 await wait(`document.querySelector('[aria-label="继续原请求"]')`)
 assert.equal(await page.evaluate('recoveryCalls.length'),1)
 assert.equal(await page.evaluate(`!!document.querySelector('[aria-label="继续原请求"] svg')`),true)
 await page.evaluate(`document.querySelector('[aria-label="继续原请求"]').click()`)
 await wait('recoveryUpdates===1')
 assert.equal(await page.evaluate(`document.querySelector('[aria-label="新草稿"]').value`),'不要清除的新内容')
 assert.deepEqual(await page.evaluate('recoveryCalls.map(x=>x.body?.request_id||"GET")'),['GET','GET','composer-source:source'])
 assert.equal(await page.evaluate(`document.querySelectorAll('.kode-discussion-recovery button').length`),0)
 }finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(profile,{recursive:true,force:true})}
})
