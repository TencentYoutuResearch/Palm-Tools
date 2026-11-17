/** The real ui-workspace shortcut commands own search/add; IM only reveals their group. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collabRenderPage } from './support/collab-render-page.js'
import { headlessBrowser } from './support/headless-browser.js'

for (const legacy of [false, true]) test(`native workspace requests reveal Sessions without replacing its state machine (legacy occupant=${legacy})`, {
  skip: !process.env.KODE_TEST_BROWSER_BIN, timeout: 35000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(),'kode-sidebar-shortcut-'))
  let browser, server
  try {
    // Use current source in memory; do not overwrite the generated production bundle.
    const bundle = await build({ entryPoints: ['packages/collab/client-source.js'], bundle: true, loader: {'.png': 'dataurl'}, format: 'cjs', platform: 'browser',
      external: ['react','react-dom','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives','@kode/dsh-composer'], write: false })
    const client = `window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}};const exports=module.exports;${bundle.outputFiles[0].text};return module.exports}})`
    server = createServer(async (req,res) => {
      const path = new URL(req.url,'http://localhost').pathname
      if (path === '/fixture-collab.js') { res.setHeader('content-type','text/javascript'); res.end(client); return }
      if (path === '/api/kode/collab/teams') {
        res.setHeader('content-type','application/json')
        res.end(JSON.stringify({ home_hub:'home', projection:'contact_directory', archived:false, order:'pinned_attention_unread_recent',items:[],next_cursor:null })); return
      }
      const originalEnd = res.end.bind(res)
      if (path === '/') res.end = html => {
        html = html.replace('register:()=>()=>{}', 'register:command=>{(window.fixtureNativeCommands??=new Map()).set(command.id,command);return()=>fixtureNativeCommands.delete(command.id)}')
        if (legacy) html = html.replace("plugins['@kode/dsh-collab'].apply(ctx);", "ctx.slots.register({name:'sidebar.workspaces',locale:'workspace',priority:-100},()=>h('p',{className:'legacy-workspace-occupant'},'Legacy workspace'));plugins['@kode/dsh-collab'].apply(ctx);")
        return originalEnd(html)
      }
      if (await collabRenderPage(req,res)) return
      res.writeHead(404); res.end('{}')
    })
    server.listen(0,'127.0.0.1'); await once(server,'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN,profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    const wait = expr => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,25))}throw Error('Workspace visibility timed out: '+JSON.stringify({body:document.body.innerText,errors:window.fixtureErrors}))})()`)
    await wait(`globalThis.fixture`)
    if(legacy)await wait(`document.querySelector('.legacy-workspace-occupant')`)
    else{
      await wait(`document.querySelector('.fixture-native-workspaces button[aria-label="视图选项"]')`)
      await page.evaluate(`(()=>{window.originalWorkspaceNode=document.querySelector('.fixture-native-workspaces');return true})()`)
      await page.evaluate(`(()=>{void fixtureNativeCommands.get('session.search').resolve({modal:null}).run();return true})()`)
      await wait(`document.activeElement?.placeholder==='搜索会话名称'`)
      assert.equal(await page.evaluate(`document.querySelector('.fixture-native-workspaces')===originalWorkspaceNode`),true)
      await page.evaluate(`(()=>{void fixtureNativeCommands.get('workspace.add').resolve({modal:null}).run();return true})()`)
      assert.equal(await page.evaluate(`document.querySelector('.fixture-native-workspaces')===originalWorkspaceNode`),true)
    }
    assert.equal(await page.evaluate('fixture.created()'),0)
    assert.deepEqual(await page.evaluate('fixtureErrors'),[])
  } finally {
    await browser?.close()
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
    await rm(profile,{recursive:true,force:true})
  }
})
