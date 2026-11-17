import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {readFile,mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {headlessBrowser} from './support/headless-browser.js'
import {collabRenderPage} from './support/collab-render-page.js'
test('Orbit adds a workspace without leaving mode, retains delayed picker and confirms full path before one registration',{skip:!process.env.KODE_TEST_BROWSER_BIN,timeout:60000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'kode-orbit-project-'));let browser,server
 try{
 const source=(await readFile('src/agent-client.js','utf8')).replace('return { createAgentControlsFacade, createWorkspaceFacade, createAppearanceFacade','return { ProjectArrival, createAgentControlsFacade, createWorkspaceFacade, createAppearanceFacade')
 const bundle=await build({entryPoints:['packages/collab/client-source.js'],bundle:true,loader:{'.png':'dataurl'},format:'cjs',platform:'browser',external:['react','react-dom','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives','@kode/dsh-composer'],write:false})
 const collab=`window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}};const exports=module.exports;${bundle.outputFiles[0].text};return module.exports}})`
 const mount=`
 window.projectFlowTest={creates:[],opens:[],mounts:0,unmounts:0};
 function NativePicker({open,onPicked}){const alive=React.useRef(true),armed=React.useRef(false);React.useEffect(()=>{projectFlowTest.mounts++;return()=>{alive.current=false;projectFlowTest.unmounts++}},[]);React.useEffect(()=>{if(!open){armed.current=false;return}if(armed.current)return;armed.current=true;new Promise(resolve=>projectFlowTest.resolve=resolve).then(path=>{if(alive.current)onPicked(path)})},[open]);return null}
 const entry={component:NativePicker,options:{priority:0},inject:()=>({pick:()=>{}})},entries=[entry];const pickerSlots={subscribe:()=>()=>{},entries:()=>entries};
 const projectRoot=document.createElement('div');document.body.append(projectRoot);modules['react-dom/client'].createRoot(projectRoot).render(h(plugins['@kode/dsh/client'].ProjectArrival,{slots:pickerSlots,workspaces:{create:async({path})=>{projectFlowTest.creates.push(path);return {workspaceId:'created',title:'kode',path}},rename:async()=>{}},uiWorkspace:{openWorkspace:async id=>projectFlowTest.opens.push(id)}}));
 `
 server=createServer(async(req,res)=>{
  if(req.url==='/fixture-kode-client.js'){res.setHeader('content-type','text/javascript');res.end(source);return}
  if(req.url==='/fixture-collab.js'){res.setHeader('content-type','text/javascript');res.end(collab);return}
  if(req.url.startsWith('/api/kode/project-hosts')){res.setHeader('content-type','application/json');res.end(JSON.stringify({current:'local',hosts:[{id:'local',name:'此计算机',workspaces:[]}]}));return}
  const end=res.end.bind(res);if(req.url==='/')res.end=html=>end(html.replace("plugins['@kode/dsh-collab'].apply(ctx);ctx.uiRenderer.mount",mount+"plugins['@kode/dsh-collab'].apply(ctx);ctx.uiRenderer.mount"))
  if(await collabRenderPage(req,res))return;res.writeHead(503);res.end('{}')
 });server.listen(0,'127.0.0.1');await once(server,'listening')
 browser=await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile);const page=await browser.page(`http://127.0.0.1:${server.address().port}/`)
 await page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:960,deviceScaleFactor:1,mobile:false})
 const wait=expr=>page.evaluate(`(async()=>{const end=Date.now()+12000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,20))}throw Error('Project flow timeout '+JSON.stringify(window.fixtureErrors))})()`)
 const click=text=>page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)}).click()`)
 await wait(`document.querySelector('.kode-collab-mode-switch button')`)
 await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`)
 await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`)
 await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)
 await wait(`document.querySelector('.kode-scoped-workspace-heading button[aria-label="添加工作区"]')`)
 await page.evaluate(`document.querySelector('.kode-scoped-workspace-heading button[aria-label="添加工作区"]').click()`)
 await wait(`document.querySelector('.kode-project-dialog')`)
 await page.evaluate(`document.querySelector('button[aria-label="源文件夹"]').click()`)
 await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('在此电脑上添加文件夹'))`)
 const ax=await page.call('Accessibility.getFullAXTree')
 assert.ok(ax.nodes.some(node=>!node.ignored&&node.role?.value==='menuitem'&&node.name?.value.includes('在此电脑上添加文件夹')),'actual native Modal/Menu items must be exposed in AX')
 await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('在此电脑上添加文件夹')).click()`)
 await click('添加文件夹');await wait(`typeof projectFlowTest.resolve==='function'`)
 assert.ok(await page.evaluate(`document.querySelector('.kode-project-dialog').textContent.includes('正在等待系统文件夹选择器')`))
 assert.equal(await page.evaluate(`projectFlowTest.creates.length`),0)
 assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='输入完整路径').disabled`),true)
 assert.equal(await page.evaluate(`projectFlowTest.unmounts`),0)
 await page.evaluate(`projectFlowTest.resolve('/fixture/selected/kode')`)
 await wait(`document.querySelector('.kode-project-path')?.textContent==='/fixture/selected/kode'`)
 assert.equal(await page.evaluate(`projectFlowTest.creates.length`),0,'choosing a folder is not permission to register it')
 assert.ok(await page.evaluate(`document.querySelector('.kode-collab-mode-switch').textContent.includes('Kode Orbit')`))
 await page.evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认路径并创建项目');b.click();b.click()})()`);await wait(`projectFlowTest.creates.length===1&&!document.querySelector('.kode-project-dialog')`)
 assert.deepEqual(await page.evaluate(`projectFlowTest.creates`),['/fixture/selected/kode'])
 assert.deepEqual(await page.evaluate(`projectFlowTest.opens`),[],'Orbit does not navigate to native session mode')
 assert.ok(await page.evaluate(`document.querySelector('.kode-collab-mode-switch').textContent.includes('Kode Orbit')`))
 await page.evaluate(`document.querySelector('.kode-scoped-workspace-heading button[aria-label="添加工作区"]').click()`)
 await wait(`document.querySelector('.kode-project-dialog')`)
 await click('输入完整路径')
 const input=async value=>page.evaluate(`(()=>{const e=document.querySelector('[aria-label="完整目录路径"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
 await input('../relative');await click('预览完整路径')
 assert.ok(await page.evaluate(`document.querySelector('.kode-project-dialog').textContent.includes('请输入以 / 开头')`))
 assert.equal(await page.evaluate(`projectFlowTest.creates.length`),1)
 await input('/fixture/manual path/kode');await click('预览完整路径')
 await wait(`document.querySelector('.kode-project-path')?.textContent==='/fixture/manual path/kode'`)
 assert.equal(await page.evaluate(`projectFlowTest.creates.length`),1,'preview must not register')
 await input('/fixture/changed/kode')
 assert.equal(await page.evaluate(`!!document.querySelector('.kode-project-path')`),false,'editing invalidates confirmation preview')
 assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认路径并创建项目').disabled`),true)
 await click('预览完整路径')
 await page.evaluate(`new Promise(resolve=>setTimeout(resolve,400))`)
 const shots=resolve('../../../artifacts/project-path-fallback-20261110');await mkdir(shots,{recursive:true});await writeFile(join(shots,'fixture-manual-path.png'),Buffer.from((await page.call('Page.captureScreenshot',{format:'png'})).data,'base64'))
 await page.evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认路径并创建项目');b.click();b.click()})()`)
 await wait(`projectFlowTest.creates.length===2&&!document.querySelector('.kode-project-dialog')`)
 assert.deepEqual(await page.evaluate(`projectFlowTest.creates`),['/fixture/selected/kode','/fixture/changed/kode'])
 assert.deepEqual(await page.evaluate(`fixtureErrors`),[])
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await rm(profile,{recursive:true,force:true})}
})
