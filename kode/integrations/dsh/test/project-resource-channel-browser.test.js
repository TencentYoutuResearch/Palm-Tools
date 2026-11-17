import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {build} from 'esbuild'
import {collabRenderPage} from './support/collab-render-page.js'
import {headlessBrowser} from './support/headless-browser.js'
const require=createRequire(import.meta.url)

test('Chromium, shipped DSH tab renderer and synthetic project bindings: switch, hide unbound, preserve discussion', {skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:60000}, async()=>{
 const fixtures=await mkdtemp(join(tmpdir(),'kode-channel-tabs-fixture-'))
 const out=process.env.KODE_TEST_SCREENSHOTS
 let browser,server
 try{
  const dist=join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')),'dist')
  const index=await readFile(join(dist,'index.html'),'utf8')
  const entry=index.match(/src="\.\/(assets\/index-[^"]+\.js)"/)[1]
  const css=[...index.matchAll(/href="\.\/(assets\/[^"]+\.css)"/g)].map(m=>'<link rel="stylesheet" href="/'+m[1]+'">').join('')
  const native=(await readFile(new URL('../packages/conversation/client.js',import.meta.url),'utf8')).replace('return module.exports;','exports.FixtureTabList = KodeChannelViewTabs; return module.exports;')
  const ui=(await build({stdin:{contents:`import {ChannelProjectResources} from './packages/collab/project-resource-session-tabs.js'; export {ChannelProjectResources};`,resolveDir:process.cwd()},bundle:true,format:'cjs',platform:'browser',external:['react'],write:false})).outputFiles[0].text
  const scope={home_hub:'fixture',host_id:'local',workspace_id:'project-a',root_ref:'/fixture/project-a'}
  const bind=(provider,name)=>({scope,id:provider,surface_id:'bound-channel',audience_revision:1,connection_id:provider,connection_revision:'fixture-1',revision:1,enabled:true,source:{provider,instance:'https://fixture.example',resource:name}})
  const bindings=[bind('tapd','窄屏前端需求'),bind('gongfeng','Kode 验证仓库')]
  const title={tapd:'窄屏下协作侧栏挤压正文',gongfeng:'MR #42 · 修复窄屏侧栏'}
  const surfaceFor=id=>({id,kind:'channel',enabled:true})
  const shell=`<!doctype html><html data-platform="web"><meta charset="utf-8">${css}<style>body{margin:0}main{margin:36px auto;width:min(740px,90vw)}h1{font-size:24px}aside{padding:10px;background:#faf3c2;color:#29240b}</style><main><aside>隔离浏览器验证 · 合成绑定与卡片，不连接真实 TAPD / 工蜂</aside><h1>前端优化频道</h1><div id="root"></div></main><script type="module">import '/${entry}';const modules=globalThis.__KODE_TEST_MODULES__;window.__ModuleLoader__={load(def){window.Native=def.factory(k=>modules[k])}}; const load=p=>new Promise((ok,no)=>Object.assign(document.head.appendChild(document.createElement('script')),{src:p,onload:ok,onerror:no})); await load('/fixture-native.js'); await load('/fixture-resource.js'); const React=modules.react,h=React.createElement,root=modules['react-dom/client'].createRoot(document.getElementById('root'));window.renderChannel=id=>root.render(h(window.ResourceUI.ChannelProjectResources,{key:id,scope:${JSON.stringify(scope)},surface:{id,kind:'channel',enabled:true},TabList:window.Native.FixtureTabList},h('p',null,'原频道讨论保留：先确认窄屏复现。')));renderChannel('bound-channel');</script>`
  server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://localhost')
      if(url.pathname==='/'){res.setHeader('content-type','text/html;charset=utf-8');return res.end(shell)}
      if(url.pathname==='/fixture-native.js'||url.pathname==='/fixture-resource.js'){res.setHeader('content-type','text/javascript');return res.end(url.pathname.includes('native')?native:`{const module={exports:{}};const exports=module.exports;const require=()=>globalThis.__KODE_TEST_MODULES__.react;${ui};window.ResourceUI=module.exports;}`)}
      if(url.pathname==='/api/kode/external-resources'){
        if(req.method!=='GET'){res.writeHead(405);return res.end()}
        res.setHeader('content-type','application/json')
        if(url.searchParams.get('op')==='project'){
          const surface_id=url.searchParams.get('surface_id');for(const [key,value] of Object.entries(scope))assert.equal(url.searchParams.get(key),value)
          return res.end(JSON.stringify({scope,surface_id,audience_revision:1,bindings:surface_id==='bound-channel'?bindings:[],connections:[]}))
        }
        const binding=bindings.find(row=>row.id===url.searchParams.get('binding'));assert.ok(binding)
        const kind=binding.id==='tapd'?'story':'change_request',source=binding.source,id='42'
        return res.end(JSON.stringify({source,binding_revision:1,connection_revision:'fixture-1',dispatch:'disabled',compatibility:'unverified-instance',items:[{source,id,kind,key:JSON.stringify([source.provider,source.instance,source.resource,kind,id]),origin:'external',trusted_instruction:false,dispatch:'disabled',cursor:1,title:title[binding.id],body:'synthetic',native_state:'open',author:'fixture',updated_at:'',url:null}]}))
      }
      if(await collabRenderPage(req,res))return
      res.writeHead(404);res.end()
    }catch(error){res.writeHead(500);res.end(String(error))}
  })
  server.listen(0,'127.0.0.1');await once(server,'listening')
  browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,fixtures)
  const page=await browser.page('http://127.0.0.1:'+server.address().port)
  await page.call('Emulation.setDeviceMetricsOverride',{width:1100,height:680,deviceScaleFactor:1,mobile:false})
  const until=expr=>page.evaluate(`(async()=>{for(let i=0;i<120;i++){if(${expr})return;await new Promise(r=>setTimeout(r,40))}throw Error(document.body.innerText)})()`)
  const tabs=()=>page.evaluate(`[...document.querySelectorAll('[role=tab]')].map(b=>b.textContent)`)
  const click=label=>page.evaluate(`[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent===${JSON.stringify(label)}).click()`)
  const shot=async name=>{if(out)await writeFile(join(out,name+'.png'),Buffer.from((await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'))}
  await until(`document.querySelector('[data-conversation-tabs]')`)
  assert.deepEqual(await tabs(),['讨论','TAPD','工蜂 Git','设置'])
  assert.match(await page.evaluate('document.body.innerText'),/原频道讨论保留/)
  await shot('01-discussion')
  await click('TAPD')
  await until(`document.body.innerText.includes('窄屏下协作侧栏挤压正文')`)
  assert.equal(await page.evaluate(`document.querySelector('[aria-selected="true"]').textContent`),'TAPD')
  await shot('02-tapd')
  await click('工蜂 Git')
  await until(`document.body.innerText.includes('MR #42 · 修复窄屏侧栏')`)
  await shot('03-gongfeng')
  await click('讨论')
  await until(`document.body.innerText.includes('原频道讨论保留')`)
  await page.evaluate('renderChannel("unbound-channel")')
  await until(`document.querySelector('[data-conversation-tabs]')&&document.querySelectorAll('[role=tab]').length===2`)
  assert.deepEqual(await tabs(),['讨论','设置'])
  await shot('04-unbound')
 }finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(fixtures,{recursive:true,force:true})}
})
