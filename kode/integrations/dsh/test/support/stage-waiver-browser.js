/** Actual owner routes, shipped UI and Hub; only a committed HTTP response is fault-injected. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessBrowser } from './headless-browser.js'
import { collabRenderPage } from './collab-render-page.js'
import { registerCollabTeams, registerCollabRuns } from '../../src/collab-api.js'
import { registerConversation } from '../../src/conversation-route.js'
import { registerConversationRead } from '../../src/conversation-read-route.js'
import { registerWorkRun } from '../../src/work-run-route.js'
import { registerWorkStageWaiver } from '../../src/work-stage-waiver-route.js'
export async function waiveStageInBrowser(hub, run, stageId) {
  const profile = await mkdtemp(join(tmpdir(), 'kode-human-native-browser-'))
  let browser, server, page, first, writes = 0
  const commands = [], routes = new Map()
  try {
    const ctx = { webServer: { register: route => routes.set(route.path, route) }, connection: { admit: req => req.headers['x-fixture-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }
    const client = { call: async (path, body) => {
      const result = await hub.client.call(path, body)
      if (body && path.endsWith('/waiver')) {
        commands.push(body); writes++
        if (writes === 1) { first = result; throw Error('fixture lost committed owner response') }
        assert.deepEqual(result, first)
      }
      return result
    } }
    for (const register of [registerCollabTeams, registerCollabRuns, registerConversation, registerConversationRead, registerWorkRun, registerWorkStageWaiver]) register(ctx, { backendClient: client })
    server = createServer(async (req, res) => { try {
      const route = routes.get(new URL(req.url, 'http://localhost').pathname)
      if (route) return await route.handler(req, res)
      if (await collabRenderPage(req, res)) return
      res.writeHead(404); res.end()
    } catch { if (!res.headersSent) res.writeHead(500); res.end() } })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    const wait = expr => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expr})return true;await new Promise(r=>setTimeout(r,30))}throw Error('Native waiver UI timed out: '+${JSON.stringify(expr)}+'; '+document.body.innerText)})()`)
    const click = text => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)});if(button&&!button.disabled){button.click();return}await new Promise(r=>setTimeout(r,30))}throw Error('Decision action not ready: '+${JSON.stringify(text)}+'; '+document.body.innerText)})()`)
    const open = async () => {
      await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='工作过程')`)
      await click('工作过程'); await wait(`document.querySelector('.kode-collab-run')`)
      await click('查看详情'); await wait(`document.querySelector('.kode-collab-stage-waiver')`)
    }
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await wait('globalThis.fixture'); await click('IM'); await wait(`document.querySelector('.kode-collab-contact-name')`)
    await page.evaluate(`document.querySelector('.kode-collab-contact-name').click()`); await open()
    await click('核对阶段豁免')
    await wait(`document.querySelector('.kode-collab-stage-waiver textarea')`)
    assert.equal(writes, 0)
    await click('取消豁免'); assert.equal(writes, 0)
    await click('核对阶段豁免')
    await wait(`document.querySelector('.kode-collab-stage-waiver textarea')`)
    await page.evaluate(`document.querySelector('.kode-collab-stage-waiver textarea').focus()`)
    const reason = '已核对当前产物，本次暂不执行独立评审'
    await page.call('Input.insertText', { text: reason })
    await click('核对豁免决定'); assert.equal(writes, 0)
    assert.equal((await hub.client.call(`/api/v1/messaging/work-runs/${run.id}`)).revision, run.revision)
    if (process.env.KODE_TEST_WAIVER_SCREENSHOT_PATH) {
      await page.evaluate(`document.querySelector('.kode-collab-stage-waiver').scrollIntoView({block:'center'})`)
      const shot = await page.call('Page.captureScreenshot', { format: 'png' })
      await writeFile(process.env.KODE_TEST_WAIVER_SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'))
    }
    await click('确认豁免此阶段')
    await wait(`document.body.innerText.includes('操作尚未确认')`)
    assert.equal(writes, 1)
    await page.evaluate('globalThis.fixture = undefined'); await page.call('Page.reload'); await wait('globalThis.fixture'); await open()
    await wait(`document.body.innerText.includes('原决定原因：')`)
    assert.ok((await page.evaluate(`document.body.innerText`)).includes(reason))
    await click('恢复原豁免决定'); await wait(`document.body.innerText.includes('豁免决定已保存')`)
    assert.equal(writes, 1, 'receipt lookup recovers the committed decision without another POST')
    assert.equal(first.stages.find(stage => stage.stage_id === stageId).state, 'waived')
    assert.equal(first.completion_authorized, false)
    assert.equal(commands[0].reason, reason)
    return { command: commands[0], receipt: first }
  } catch (error) {
    if (page && process.env.KODE_TEST_WAIVER_SCREENSHOT_PATH) {
      const shot = await page.call('Page.captureScreenshot', { format: 'png' }).catch(() => null)
      if (shot) await writeFile(process.env.KODE_TEST_WAIVER_SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'))
      await writeFile(process.env.KODE_TEST_WAIVER_SCREENSHOT_PATH + '.txt', await page.evaluate('document.body.innerText').catch(() => 'unavailable'))
    }
    throw error
  } finally {
    await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await rm(profile, { recursive: true, force: true })
  }
}
