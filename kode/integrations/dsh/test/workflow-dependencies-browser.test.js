import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedHub } from './support/isolated-hub.js'
import { conversationTeam } from './support/conversation-team.js'
import { headlessBrowser } from './support/headless-browser.js'
import { collabRenderPage } from './support/collab-render-page.js'
import { registerCollabTeams } from '../src/collab-api.js'
import { registerConversation } from '../src/conversation-route.js'
import { registerTeamActivation } from '../src/team-activation-route.js'

test('activation review displays the exact frozen dependency source, permissions and escaped instructions', {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_BROWSER_BIN, timeout: 45000,
}, async () => {
  const hub = await isolatedHub('dependency-browser'), profile = await mkdtemp(join(tmpdir(), 'kode-dependency-browser-'))
  let browser, server, activations = 0
  try {
    const call = (path, body) => hub.client.call('/api/v1/messaging/' + path, body)
    const team = await conversationTeam(hub), ref = row => ({ id: row.id, version: row.version, hash: row.hash })
    const instructions = 'Retain independent review.\n<script>globalThis.untrustedDependencyExecuted=true</script>'
    const artifact = await call('project-configs', { id: 'reviewed-method', version: '1', spec: { kind: 'workflow_dependency', artifact: {
      kind: 'skill', source: 'fixture://reviewed-project/method', source_version: '1', instructions,
      content_hash: createHash('sha256').update(instructions).digest('hex'), hosts: [hub.node], tools: ['kode_artifact_capture'], capabilities: ['read'], network: false,
    } } })
    const flow = (await call('workflows/flow/versions/1')).pack; flow.version = 'dependency'; flow.stages[0].execution.dependencies = [ref(artifact)]
    const workflow = await call('workflows', flow)
    const deliveryConfig = (await call('project-configs/delivery/versions/1')).config; deliveryConfig.version = 'dependency'; deliveryConfig.spec.workflow = ref(workflow)
    const delivery = await call('project-configs', deliveryConfig)
    const spec = structuredClone(team.spec); spec.workflow_pack_refs = [ref(workflow)]; spec.delivery_bindings[0].workflow = ref(workflow); spec.delivery_bindings[0].delivery_policy = ref(delivery)
    await call('teams', { id: team.id, request_id: 'bind-method', expected_revision: team.revision, spec })
    const budget = await call('budgets/budget'), routes = new Map()
    const ctx = { webServer: { register: route => routes.set(route.path, route) }, connection: { admit: req => req.headers['x-fixture-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }
    const config = { backendClient: { async call(path, body) { if (body && path.endsWith('/activation')) activations++; return hub.client.call(path, body) } } }
    for (const register of [registerCollabTeams, registerConversation, registerTeamActivation]) register(ctx, config)
    server = createServer(async (req, res) => {
      try {
        const route = routes.get(new URL(req.url, 'http://localhost').pathname)
        if (route) return await route.handler(req, res)
        if (await collabRenderPage(req, res)) return
        res.writeHead(404); res.end()
      } catch { if (!res.headersSent) res.writeHead(500); res.end() }
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    browser = await headlessBrowser(process.env.KODE_TEST_BROWSER_BIN, profile)
    const page = await browser.page(`http://127.0.0.1:${server.address().port}`)
    await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    const wait = expression => page.evaluate(`(async()=>{const end=Date.now()+10000;while(Date.now()<end){if(${expression})return;await new Promise(r=>setTimeout(r,25))}throw Error('Dependency UI timeout')})()`)
    const button = text => `Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(text)}&&!button.disabled)`
    const click = async text => { await wait(button(text)); await page.evaluate(`${button(text)}.click()`) }
    await wait('globalThis.fixture'); await click('IM'); await wait(`document.querySelector('.kode-collab-contact-name')`)
    await page.evaluate(`document.querySelector('.kode-collab-contact-name').click()`)
    await click('团队管理'); await click('核对激活条件')
    await wait(`document.querySelector('.kode-collab-dependencies')`)
    const text = await page.evaluate(`document.querySelector('.kode-collab-dependencies').innerText`)
    for (const value of [artifact.hash, artifact.config.spec.artifact.content_hash, 'fixture://reviewed-project/method', 'kode_artifact_capture', hub.node]) assert.ok(text.includes(value), value)
    await page.evaluate(`document.querySelector('.kode-collab-dependencies summary').click()`)
    assert.equal(await page.evaluate(`document.querySelector('.kode-collab-dependencies pre').textContent`), instructions)
    assert.equal(await page.evaluate(`globalThis.untrustedDependencyExecuted===undefined`), true)
    await page.evaluate(`document.querySelector('.kode-collab-dependencies').scrollIntoView({block:'center'})`)
    const screenshot = await page.call('Page.captureScreenshot', { format: 'png' })
    await writeFile('/tmp/superagent-workflow-dependencies-review.png', Buffer.from(screenshot.data, 'base64'))
    assert.equal(activations, 0); assert.deepEqual(await call('budgets/budget'), budget)
  } finally {
    await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await rm(profile, { recursive: true, force: true }); await hub.close()
  }
})
