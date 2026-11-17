/** Actual SidebarRoot and production IM components; geometry and business data are fixture-owned. */
import test from 'node:test'
import {build} from 'esbuild'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collabRenderPage } from './support/collab-render-page.js'
import { headlessBrowser } from './support/headless-browser.js'

test('unified groups retain native workspaces, global navigation, footer and main draft', {
  skip: !process.env.KODE_TEST_BROWSER_BIN, timeout: 40000,
}, async () => {
  const bundle=await build({entryPoints:['packages/collab/client-source.js'],bundle:true,loader:{'.png':'dataurl'},format:'cjs',platform:'browser',external:['react','react-dom','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives','@kode/dsh-composer'],write:false})
  const client=process.env.KODE_TEST_SHIPPED_COLLAB==='1'?await readFile(new URL('../packages/collab/client.js',import.meta.url),'utf8'):`window.__ModuleLoader__.load({id:'@kode/dsh-collab',factory(require){const module={exports:{}},exports=module.exports;${bundle.outputFiles[0].text};return module.exports}})`
  const profile = await mkdtemp(join(tmpdir(), 'kode-native-sidebar-'))
  let browser, server
  const team = { id: 'team', superagent_id: 'super', conversation_id: 'dm', home_hub: 'home', spec: { name: '测试团队', kind: 'coordinator' },
    contact: { preference: { revision: 0, pinned: false, archived: false, archived_through_sequence: 0 }, archived: false, needs_attention: false, latest_sequence: 0, unread_count: 0, last_activity_at: 0, attention: { decisions: 0, resources: 0, stopping: 0, active_runs: 0 } } }
  try {
    server = createServer(async (req, res) => {
      const send = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
      const url = new URL(req.url, 'http://localhost')
      if(url.pathname==='/fixture-collab.js'){res.setHeader('content-type','text/javascript');res.end(client);return}
      if (url.pathname === '/api/kode/collaboration' && url.searchParams.get('path') === 'surfaces') {
        const scope=Object.fromEntries(['home_hub','host_id','workspace_id','root_ref'].map(key=>[key,url.searchParams.get(key)]))
        return send({scope,items:['channel','dm'].map(kind=>({id:'native-'+kind,scope,kind,title:kind==='channel'?'项目频道':'项目私信',team_ids:[],revision:1,enabled:true}))})
      }
      if (url.pathname === '/api/kode/collab/teams') return send({ home_hub: 'home', projection: 'contact_directory', archived: false,
        order: 'pinned_attention_unread_recent', items: [team], next_cursor: null })
      if (url.pathname === '/api/kode/conversation/messages') return send({ home_hub: 'home', team_id: 'team', conversation_id: 'dm', items: [], has_more: false, next_cursor: null })
      if (url.pathname === '/api/kode/conversation/read-state') return send({ home_hub: 'home', team_id: 'team', conversation_id: 'dm', principal_id: 'local_owner', through_sequence: 0, latest_sequence: 0, unread_count: 0 })
      if (url.pathname === '/api/kode/collab/runs') return send({ home_hub: 'home', team_id: 'team', items: [], next_cursor: null })
      if (await collabRenderPage(req, res)) return
      res.writeHead(404); res.end('{}')
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    const wait = expr => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expr})return;await new Promise(r=>setTimeout(r,30))}throw Error('Native sidebar timed out: '+JSON.stringify({body:document.body.innerText,errors:window.fixtureErrors}))})()`)
  const enterCollaboration=async()=>{await wait(`document.querySelector('.kode-collab-mode-switch button')`);if(await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').getAttribute('aria-label').includes('会话')`)){await page.evaluate(`document.querySelector('.kode-collab-mode-switch button').click()`);await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('协作'))`);await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('协作')).click()`)}}
    const click = label => page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}).click()`)
    await enterCollaboration()
    assert.equal(await page.evaluate(`document.querySelectorAll('button[aria-label="新建会话"]').length`),0,'collaboration does not duplicate the per-project session action')
    await wait(`globalThis.fixture && document.querySelector('[data-sidebar-section=channels]')`)
    for (const label of ['插件','Kode','自动化任务','设置']) {
      assert.ok(await page.evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')===${JSON.stringify(label)})`), label+': '+JSON.stringify(await page.evaluate(`Array.from(document.querySelectorAll('button')).map(b=>({text:b.textContent,label:b.getAttribute('aria-label')}))`)))
    }
    await page.evaluate(`(()=>{const d=document.querySelector('[data-sidebar-section=channels]');if(!d.open)d.querySelector('summary').click()})()`)
    await wait(`document.querySelector('[data-sidebar-row=team] [data-row-title]')`)
    assert.equal(await page.evaluate(`!!document.querySelector('.fixture-native-workspaces')`),true)
    assert.equal(await page.evaluate(`fixture.sidebarComponent===fixture.ctx.slots.entries('sidebar')[0].component`),true,'native SidebarRoot component was not wrapped/replaced')
    for (const label of ['插件','Kode','自动化任务','设置']) {
      assert.ok(await page.evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')===${JSON.stringify(label)})`), label+' remains in IM')
    }
    assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll('[data-sidebar-section]')).map(n=>n.dataset.sidebarSection)`),['channels'])
    await page.evaluate(`document.querySelector('[data-sidebar-row=team] [data-row-title]').click()`)
    await wait(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]')`)
    await page.evaluate(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]').focus()`)
    await page.call('Input.insertText',{text:'侧栏切换应保留这份草稿'})
    await page.evaluate(`document.querySelector('[data-sidebar-section=channels] summary').click()`)
    await wait(`document.querySelector('.fixture-native-workspaces')`)
    assert.equal(await page.evaluate(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]').textContent`),'侧栏切换应保留这份草稿')
    await page.evaluate(`(()=>{const d=document.querySelector('[data-sidebar-section=channels]');if(!d.open)d.querySelector('summary').click()})()`)
    await wait(`document.querySelector('[data-sidebar-row=team] [data-row-title]')`)
    await click('收起侧边栏')
    await wait(`document.querySelector('.kode-collab-unified-sidebar')?.dataset.wide==='false'`)
    assert.equal(await page.evaluate(`document.querySelector('#fixture-frame').getBoundingClientRect().width>=56`),true)
    assert.equal(await page.evaluate(`document.querySelectorAll('.kode-collab-mode-switch').length`),1,'collapsed native shell keeps exactly one mode control, not a parallel navigation tree')
    assert.equal(await page.evaluate(`(()=>{const b=document.querySelector('.kode-collab-mode-switch button'),r=b.getBoundingClientRect();return b.tabIndex>=0&&r.width>0&&r.height>0})()`),true,'the mode route remains keyboard reachable when collapsed')
    assert.equal(await page.evaluate(`fixture.sidebarComponent===fixture.ctx.slots.entries('sidebar')[0].component`),true)
    assert.equal(await page.evaluate(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]').textContent`),'侧栏切换应保留这份草稿')
    await click('打开侧边栏')
    await wait(`document.querySelector('[data-sidebar-row=team] [data-row-title]')`)
    await click('Kode')
    await wait(`document.querySelector('[data-fixture-panel="kode-settings"]')`)
    assert.ok(await page.evaluate(`!!document.querySelector('[data-sidebar-row=team] [data-row-title]')`),'global panel does not replace IM navigation')
    assert.equal(await page.evaluate(`fixture.created()`),0,'navigation does not create sessions')
    await page.evaluate(`document.querySelector('[data-sidebar-row=team] [data-row-title]').click()`)
    await wait(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]')`)
    assert.equal(await page.evaluate(`document.querySelector('.kode-collab-composer [role=textbox][contenteditable=true]').textContent`),'侧栏切换应保留这份草稿')
    await page.evaluate(`(()=>{const section=document.querySelector('[data-sidebar-section=channels]');if(!section.open)section.querySelector('summary').click()})()` )
    await wait(`document.querySelector('[data-sidebar-section=channels]').open`)
    await page.evaluate(`(()=>{const at=Date.now()-60000,s=fixture.workspaceData.sessions;s.publish({...s.getSnapshot(),ids:['native-row'],byId:{'native-row':{id:'native-row',displayTitle:'原生会话',title:'原生会话',cwd:'/fixture/project',createdAt:new Date(at).toISOString(),updatedAt:at,blank:false,running:false,runningSubagentCount:0,retainedBy:{},projectionValues:{}}}});const w=fixture.workspaceData.workspaces;w.publish({...w.getSnapshot(),items:[{workspaceId:'project',title:'原项目标题',path:'/fixture/project',sessionIds:['native-row'],createdAt:new Date(at).toISOString()}]})})()`)
    const channelRow=`document.querySelector('[data-current-workspace-scope] [data-sidebar-section=channels] [data-sidebar-row=channel]')`,directRow=`document.querySelector('[data-current-workspace-scope] [data-sidebar-section=direct] [data-sidebar-row=team],[data-current-workspace-scope] [data-sidebar-section=direct] [data-sidebar-row=dm]')`
    await wait(`document.querySelector('[data-row-key^="workspace:"]')&&${channelRow}&&${directRow}`)
    const metric=row=>`(()=>{const r=${row};return {height:r.getBoundingClientRect().height,font:getComputedStyle(r.querySelector('[data-row-title],span:nth-child(2)')).fontSize}})()`
    const channel=await page.evaluate(metric(channelRow)),direct=await page.evaluate(metric(directRow))
    // The project menu opens the full native manager (session mode) without leaving the draft.
    await page.evaluate(`document.querySelector('[data-project-scope] button[aria-label^="项目操作"]').click()`)
    await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(b=>b.textContent.includes('在会话模式中管理'))`)
    await page.evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent.includes('在会话模式中管理')).click()`)
    await wait(`document.querySelector('.fixture-native-workspaces').getBoundingClientRect().height>0`)
    await page.evaluate(`document.querySelector('.fixture-native-workspaces [data-row-key="workspace:project"]').click()`)
    await wait(`document.querySelector('.fixture-native-workspaces [data-row-key="session:native-row"]')?.getBoundingClientRect().height>0`)
    const native=await page.evaluate(metric(`document.querySelector('.fixture-native-workspaces [data-row-key="session:native-row"]')`))
    const rows={projectAbove:await page.evaluate(`document.querySelector('.fixture-native-workspaces').getBoundingClientRect().height>0`),title:await page.evaluate(`document.querySelector('.fixture-native-workspaces').innerText`)}
    // Channel, DM and native Session rows share one row anatomy and density.
    assert.deepEqual(channel,native,'channel rows follow native Session density')
    assert.deepEqual(direct,native,'DM rows follow native Session density')
    assert.ok(rows.projectAbove)
    assert.ok(rows.title.includes('原项目标题'),JSON.stringify(rows))
    assert.deepEqual(await page.evaluate('fixtureErrors'),[])
  } finally {
    await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)) }
    await rm(profile,{recursive:true,force:true})
  }
})
