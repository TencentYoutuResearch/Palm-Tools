import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessBrowser } from './support/headless-browser.js'
import { collabRenderPage } from './support/collab-render-page.js'

test('real React question chooser keeps A/B distinct, hides empty state, and shows stale selection without silently retargeting', {
  skip: !process.env.KODE_TEST_BROWSER_BIN, timeout: 45000,
}, async () => {
  const bundle = (await build({ entryPoints: ['packages/collab/conversation-questions.js'], bundle: true, format: 'cjs', platform: 'browser', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false })).outputFiles[0].text
  const profile = await mkdtemp(join(tmpdir(), 'conversation-questions-')); let browser, server
  try {
    server = createServer(async (req, res) => {
      if (req.url === '/question-test.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle); return }
      if (await collabRenderPage(req, res)) return
      res.writeHead(404); res.end()
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    const wait = expression => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expression})return;await new Promise(r=>setTimeout(r,20))}throw Error('Question UI condition not reached')})()`)
    await wait('globalThis.fixture')
    await page.evaluate(`(async()=>{
      const React=__KODE_TEST_MODULES__.react,h=React.createElement,module={exports:{}},code=await(await fetch('/question-test.js')).text();
      new Function('require','module','exports',code)(name=>{if(name!=='react'&&name!=='@deepseek-ai/dsh-client-ui-primitives')throw Error(name);return __KODE_TEST_MODULES__[name]},module,module.exports);
      const team={home_hub:'home',id:'team',conversation_id:'conversation'};
      globalThis.questionProbe={target:null,items:['a','b'].map(id=>({run_id:'run-'+id,assignment_id:'assignment-'+id,question_request_id:'question-'+id,run_title:'需求 '+id.toUpperCase(),questions:[{id:'scope',question:'确认 '+id.toUpperCase()+' 的范围？',options:[{label:'只读',description:'不执行变更'}]}]}))};
      const request=async()=>({home_hub:team.home_hub,team_id:team.id,conversation_id:team.conversation_id,items:questionProbe.items});
      function Probe(){const[target,setTarget]=React.useState(null);return h('div',{className:'kode-collab-composer'},h(module.exports.ConversationQuestions,{team,target,request,onSelect:value=>{questionProbe.target=value;setTarget(value)}}))}
      fixture.ctx.slots.register({name:'main',key:'question-probe'},()=>h(Probe));fixture.ctx.layout.selectPanel('question-probe');
    })()`)
    await wait(`document.querySelector('[aria-label="选择要回答的问题"]')`)
    assert.equal(await page.evaluate(`document.querySelector('select[aria-label="本条消息用途"]')`), null)
    assert.match(await page.evaluate(`document.querySelector('[aria-label="选择要回答的问题"]').textContent`), /需求 A.*需求 B/s)
    await page.evaluate(`document.querySelector('button[aria-label="回答 需求 B"]').click()`)
    await wait(`questionProbe.target?.run_id==='run-b'`)
    assert.deepEqual(await page.evaluate('questionProbe.target'), { run_id: 'run-b', assignment_id: 'assignment-b', question_request_id: 'question-b' })
    await page.evaluate(`questionProbe.items=questionProbe.items.slice(0,1);document.querySelector('button[aria-label="刷新问题"]').click()`)
    await wait(`document.querySelector('[role="alert"]')?.textContent.includes('已不在待回答列表')`)
    assert.equal(await page.evaluate('questionProbe.target.run_id'), 'run-b')
    for (const [width, height] of [[1280, 900], [390, 844]]) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      const bounds = await page.evaluate(`(()=>{const section=document.querySelector('[aria-label="选择要回答的问题"]');return {width:section.clientWidth,scrollWidth:section.scrollWidth,height:section.getBoundingClientRect().height,viewport:innerHeight}})()`)
      assert.ok(bounds.scrollWidth <= bounds.width + 1, JSON.stringify({width,...bounds})); assert.ok(bounds.height <= bounds.viewport * .31)
      if (process.env.KODE_QUESTION_SCREENSHOT_DIR) { const { data } = await page.call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(process.env.KODE_QUESTION_SCREENSHOT_DIR, `conversation-questions-${width}.png`), Buffer.from(data, 'base64')) }
    }
    await page.evaluate(`[...document.querySelectorAll('button')].find(node=>node.textContent==='取消关联').click()`)
    await wait('questionProbe.target===null')
    await page.evaluate(`questionProbe.items=[];document.querySelector('button[aria-label="刷新问题"]').click()`)
    await wait(`!document.querySelector('[aria-label="选择要回答的问题"]')`)
    assert.equal(await page.evaluate(`document.body.textContent.includes('本条消息用途')`), false)
    assert.equal(await page.evaluate(`document.body.textContent.includes('普通消息（不回答任何问题）')`), false)
    assert.deepEqual(await page.evaluate('fixtureErrors'), [])
  } finally { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } await rm(profile, { recursive: true, force: true }) }
})
