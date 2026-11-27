import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotConnectors, CONNECTOR_CATALOG, MCP_APP_CATALOG, resolveMcpAppUrl, buildWatchSpecForConnector, connectorHowToAsk } from '../src/bot-connectors.js'

function mockBackend() {
  const docs = new Map()
  const watches = new Map()
  const events = []
  let watchSeq = 1
  return {
    docs,
    watches,
    events,
    async call(path, body) {
      if (path.startsWith('/api/v1/messaging/workbench/documents/')) {
        const key = decodeURIComponent(path.split('/').pop())
        const entry = docs.get(key) ?? { revision: 0, value: null }
        if (!body) return entry
        const next = { revision: entry.revision + 1, value: body.value }
        docs.set(key, next)
        return next
      }
      if (path === '/api/v1/messaging/workbench/watches') {
        if (!body) return { watches: [...watches.values()], runs: [] }
        if (body.action === 'upsert') {
          const id = body.id ?? `w_${watchSeq++}`
          watches.set(id, { id, bot: body.bot, enabled: body.enabled, spec: body.spec })
          return { saved: id, watches: [...watches.values()] }
        }
        if (body.action === 'toggle') {
          const w = watches.get(body.id)
          if (w) w.enabled = body.enabled
          return { watches: [...watches.values()] }
        }
        if (body.action === 'delete') {
          watches.delete(body.id)
          return { watches: [...watches.values()] }
        }
        if (body.action === 'run') {
          events.push({ kind: 'watch_run', id: body.id })
          return { started: true }
        }
      }
      if (path === '/api/v1/messaging/workbench/events') {
        events.push(body)
        return { accepted: true }
      }
      throw new Error(`unexpected backend path: ${path}`)
    },
  }
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    end(text) { this.body = JSON.parse(text) },
  }
}

test('webhook connector binds watch, verifies Bearer secret, publishes event, and rotates secret', async () => {
  const backend = mockBackend()
  const store = new BotConnectors(backend, { execFile: async () => ({ stdout: '', stderr: '' }) })
  const bot = { id: 'b1', name: '值班助手' }
  const saved = await store.upsert(bot, { type: 'webhook', name: 'CI 告警', config: { events_hint: 'build fail' } })
  assert.ok(saved.id.startsWith('conn_'))
  assert.ok(saved.secret && saved.secret.length >= 32)
  assert.equal(saved.webhook_path, `/api/kode/bot-webhooks/${saved.id}`)
  assert.equal(backend.watches.size, 1)
  const watch = [...backend.watches.values()][0]
  assert.equal(watch.spec.on.topic, 'webhook/event')
  assert.equal(watch.spec.on.match.connector_id, saved.id)

  const post = async (path, headers, payload) => {
    const res = mockRes()
    await store.handleWebhook({
      method: 'POST',
      url: path,
      headers,
      async *[Symbol.asyncIterator]() { if (payload !== undefined) yield typeof payload === 'string' ? payload : JSON.stringify(payload) },
    }, res)
    return res
  }

  // Wrong secret -> 401
  assert.equal((await post(saved.webhook_path, { authorization: 'Bearer wrong' }, { ok: 1 })).statusCode, 401)

  // Valid secret -> 202 and publishes webhook/event
  const ok = await post(saved.webhook_path, { authorization: `Bearer ${saved.secret}` }, { repo: 'palm', status: 'failed' })
  assert.equal(ok.statusCode, 202)
  assert.equal(backend.events.length, 1)
  assert.equal(backend.events[0].topic, 'webhook/event')
  assert.equal(backend.events[0].payload.connector_id, saved.id)
  assert.equal(backend.events[0].payload.data.repo, 'palm')

  // Paused connector -> 409 and watch toggled off
  await store.toggle(saved.id, false)
  assert.equal(backend.watches.get(saved.watch_id).enabled, false)
  assert.equal((await post(saved.webhook_path, { authorization: `Bearer ${saved.secret}` }, {})).statusCode, 409)

  // Re-enable + rotate secret -> old secret fails, new secret succeeds
  await store.toggle(saved.id, true)
  const rotated = await store.rotateSecret(saved.id)
  assert.notEqual(rotated.secret, saved.secret)
  assert.equal((await post(saved.webhook_path, { authorization: `Bearer ${saved.secret}` }, {})).statusCode, 401)
  assert.equal((await post(saved.webhook_path, { 'x-kode-webhook-secret': rotated.secret }, { ping: true })).statusCode, 202)

  // Delete cleans up both record and backing watch
  await store.remove(saved.id)
  assert.equal(backend.watches.size, 0)
  assert.equal((await store.readAll()).length, 0)
})

test('wecom, github, and team connectors bind matching Kode watch specs and sync WeCom chats', async () => {
  const backend = mockBackend()
  const wecomConfig = { enabled: true, watched_chats: [] }
  const wecom = {
    config: wecomConfig,
    status: async () => ({ installed: true, authorized: true, bot_id: 'bot_wx' }),
    configure: async patch => { Object.assign(wecomConfig, patch) },
  }
  const store = new BotConnectors(backend, {
    wecom,
    execFile: async () => ({ stdout: 'Logged in to github.com account marxwang (keyring)\n', stderr: '' }),
  })
  const env = await store.environment()
  assert.equal(env.wecom.authorized, true)
  assert.equal(env.github.authenticated, true)
  assert.equal(env.github.account, 'marxwang')

  const bot = { id: 'b2', name: '大管家', default_cwd: '/repo' }
  const wx = await store.upsert(bot, { type: 'wecom', config: { chat_id: 'wr_group_1', chat_name: '研发群' } })
  assert.equal(wecomConfig.watched_chats.length, 1)
  assert.equal(wecomConfig.watched_chats[0].chat_id, 'wr_group_1')
  assert.equal(backend.watches.get(wx.watch_id).spec.on.topic, 'wecom/message')
  assert.equal(backend.watches.get(wx.watch_id).spec.on.match.chat_id, 'wr_group_1')

  const gh = await store.upsert(bot, { type: 'github', config: { repo: 'acme/app', workspace: '/repo', branch: 'main', watch_commits: true } })
  assert.equal(backend.watches.get(gh.watch_id).spec.on.topic, 'git.commit')
  assert.equal(backend.watches.get(gh.watch_id).spec.on.match.workspace, '/repo')
  assert.match(connectorHowToAsk(gh, bot.name), /acme\/app/)

  const team = await store.upsert(bot, { type: 'team', config: { room: 'ops', mode: 'mention' } })
  assert.equal(backend.watches.get(team.watch_id).spec.on.topic, 'kode.team/mention')
  assert.equal(backend.watches.get(team.watch_id).spec.on.match.room, 'ops')
  assert.ok(CONNECTOR_CATALOG.some(row => row.type === 'slack'))
  assert.ok(CONNECTOR_CATALOG.some(row => row.type === 'discord'))
  assert.ok(CONNECTOR_CATALOG.some(row => row.type === 'linear'))
  assert.ok(CONNECTOR_CATALOG.some(row => row.type === 'google'))
  assert.ok(CONNECTOR_CATALOG.some(row => row.type === 'mcp'))
  assert.equal(buildWatchSpecForConnector({ id: 'c1', type: 'slack', name: 'Slack', config: { instructions: 'hi' } }).on.topic, 'webhook/event')
  assert.equal(buildWatchSpecForConnector({ id: 'c2', type: 'discord', name: 'Discord', config: { channel: '#ops' } }).on.topic, 'webhook/event')
})

test('Orca official MCP app catalog resolves region/host variables and custom MCP URLs', async () => {
  assert.ok(MCP_APP_CATALOG.length >= 19, 'includes Orca official MCP apps')
  assert.equal(resolveMcpAppUrl('datadog', { site: 'datadoghq.eu' }), 'https://mcp.datadoghq.eu/v1/mcp')
  assert.equal(resolveMcpAppUrl('gitlab', { host: 'https://git.corp.example/' }), 'https://git.corp.example/api/v4/mcp')
  assert.equal(resolveMcpAppUrl('notion', {}), 'https://mcp.notion.com/mcp')

  const backend = mockBackend()
  const store = new BotConnectors(backend, { execFile: async () => { throw new Error('no gh') } })
  const bot = { id: 'b3', name: '值班助手' }
  const savedApp = await store.upsert(bot, { type: 'mcp', config: { app_id: 'sentry' } })
  assert.equal(savedApp.name, 'Sentry')
  assert.equal(savedApp.config.app_id, 'sentry')
  assert.equal(savedApp.config.url, 'https://mcp.sentry.dev/mcp')
  assert.equal(savedApp.watch_id, null, 'MCP apps do not need a background watch')
  assert.match(connectorHowToAsk(savedApp, bot.name), /mcp\.sentry\.dev/)

  const custom = await store.upsert(bot, { type: 'mcp', name: '内部工具', config: { url: 'https://tools.internal.example/mcp' } })
  assert.equal(custom.config.url, 'https://tools.internal.example/mcp')

  await assert.rejects(() => store.upsert(bot, { type: 'mcp', config: { url: 'ftp://bad.example' } }), /http/)
})

test('BotConnectors falls back to local file when older kode-bridge rejects bot-connectors document with 400', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kode-bot-connectors-'))
  const storageFile = join(dir, 'dsh-bot-connectors.json')
  try {
    const watches = new Map()
    let watchSeq = 1
    const oldBackend = {
      async call(path, body) {
        if (path.startsWith('/api/v1/messaging/workbench/documents/')) {
          throw Object.assign(new Error('kode backend (400): unknown workbench document'), { status: 400 })
        }
        if (path === '/api/v1/messaging/workbench/watches') {
          if (body?.action === 'upsert') {
            const id = body.id ?? `w_${watchSeq++}`
            watches.set(id, { id, bot: body.bot, enabled: body.enabled, spec: body.spec })
            return { saved: id, watches: [...watches.values()] }
          }
          if (body?.action === 'toggle') {
            const w = watches.get(body.id)
            if (w) w.enabled = body.enabled
            return { watches: [...watches.values()] }
          }
          if (body?.action === 'delete') {
            watches.delete(body.id)
            return { watches: [...watches.values()] }
          }
        }
        throw new Error(`unexpected path: ${path}`)
      },
    }
    const wecomConfig = { enabled: false, watched_chats: [] }
    const wecom = {
      config: wecomConfig,
      status: async () => ({ installed: true, authorized: true, bot_id: 'bot_wx' }),
      saveConfig: async patch => { Object.assign(wecomConfig, patch); return wecomConfig },
    }
    const store1 = new BotConnectors(oldBackend, { wecom, storageFile, execFile: async () => ({ stdout: '', stderr: '' }) })
    const bot = { id: 'b_old', name: '测试伙伴', default_cwd: '/repo' }
    const saved = await store1.upsert(bot, { type: 'wecom', config: { chat_id: 'wr_1', chat_name: '测试群' } })
    assert.equal(wecomConfig.watched_chats.length, 1)
    assert.equal(wecomConfig.watched_chats[0].chat_id, 'wr_1')

    // Explicit empty workspace on github connector should not fall back to bot.default_cwd.
    const gh = await store1.upsert(bot, { type: 'github', config: { repo: 'org/repo', workspace: '', watch_commits: true } })
    assert.equal(gh.config.workspace, '')
    assert.equal(watches.get(gh.watch_id).spec.on.topic, 'webhook/event')

    // Fresh store instance reads persisted connectors from fallback file and toggles cleanly.
    const store2 = new BotConnectors(oldBackend, { wecom, storageFile, execFile: async () => ({ stdout: '', stderr: '' }) })
    const loaded = await store2.readAll()
    assert.equal(loaded.length, 2)
    await store2.toggle(saved.id, false)
    assert.equal((await store2.readAll()).find(row => row.id === saved.id).enabled, false)

    // After upgrading to a backend that accepts workbench documents, migration preserves local records.
    const upgradedBackend = mockBackend()
    const store3 = new BotConnectors(upgradedBackend, { wecom, storageFile, execFile: async () => ({ stdout: '', stderr: '' }) })
    assert.equal((await store3.readAll()).length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('test() dispatches watch_run for git.commit/schedule connectors, validates Google cron, enables WeCom polling, and removeForBot cleans watches', async () => {
  const backend = mockBackend()
  const wecomConfig = { enabled: false, watched_chats: [] }
  const wecom = {
    config: wecomConfig,
    status: async () => ({ installed: true, authorized: true, bot_id: 'bot_wx' }),
    saveConfig: async patch => { Object.assign(wecomConfig, patch); return wecomConfig },
  }
  const store = new BotConnectors(backend, { wecom, execFile: async () => ({ stdout: '', stderr: '' }) })
  const bot = { id: 'b_audit', name: '巡检助手', default_cwd: '/repo' }

  // Adding an enabled WeCom connector enables polling automatically
  const wx = await store.upsert(bot, { type: 'wecom', config: { chat_id: 'wr_ops', chat_name: '运维群' } })
  assert.equal(wecomConfig.enabled, true)

  // GitHub with local git.commit watch does not expose a dead webhook URL and test() runs the watch directly
  const gh = await store.upsert(bot, { type: 'github', config: { repo: 'org/app', workspace: '/repo', watch_commits: true } })
  assert.equal(gh.webhook_path, undefined)
  const ghTest = await store.test(gh.id)
  assert.equal(ghTest.mode, 'watch_run')
  assert.equal(backend.events.at(-1).kind, 'watch_run')
  assert.equal(backend.events.at(-1).id, gh.watch_id)
  assert.equal((await store.readAll()).find(row => row.id === gh.id).event_count, 1)

  // Invalid Google cron is rejected clearly instead of silently dropped
  await assert.rejects(() => store.upsert(bot, { type: 'google', config: { schedule_cron: '每天9点' } }), /Cron/)

  // Valid Google schedule connector uses watch_run on test()
  const gg = await store.upsert(bot, { type: 'google', config: { schedule_cron: '0 9 * * 1-5' } })
  assert.equal(gg.webhook_path, undefined)
  assert.equal((await store.test(gg.id)).mode, 'watch_run')

  // Paused connector cannot be test-triggered
  await store.toggle(gg.id, false)
  await assert.rejects(() => store.test(gg.id), /已暂停/)

  // Deleting the backing watch manually and re-saving the connector recreates a fresh watch
  backend.watches.delete(wx.watch_id)
  const origCall = backend.call.bind(backend)
  backend.call = async (path, body) => {
    if (path === '/api/v1/messaging/workbench/watches' && body?.action === 'upsert' && body.id && !backend.watches.has(body.id)) {
      throw Object.assign(new Error('这个关注已不存在'), { status: 404 })
    }
    return origCall(path, body)
  }
  const wxEdited = await store.upsert(bot, { id: wx.id, type: 'wecom', name: '运维群2', config: { chat_id: 'wr_ops' } })
  assert.ok(wxEdited.watch_id && wxEdited.watch_id !== wx.watch_id)
  assert.ok(backend.watches.has(wxEdited.watch_id))

  // removeForBot deletes all backing watches for that bot
  assert.equal(backend.watches.size, 3)
  await store.removeForBot(bot.id)
  assert.equal(backend.watches.size, 0)
  assert.equal((await store.readAll()).length, 0)
})

test('deduplicates identical connector targets, normalizes GitHub URLs, prunes orphan connector watches, and syncs watch toggle/delete', async () => {
  const backend = mockBackend()
  const store = new BotConnectors(backend, { execFile: async () => ({ stdout: '', stderr: '' }) })
  const bot = { id: 'b_dedup', name: '柚子PM', default_cwd: '/repo' }

  const gh1 = await store.upsert(bot, { type: 'github', config: { repo: 'https://github.com/TencentYoutuResearch/Palm-Tools.git', workspace: '/repo', watch_commits: true, instructions: 'v1' } })
  assert.equal(gh1.config.repo, 'TencentYoutuResearch/Palm-Tools')
  assert.equal(backend.watches.size, 1)

  // Re-adding the exact same GitHub repo + workspace updates the existing connector & watch instead of creating a duplicate
  const gh2 = await store.upsert(bot, { type: 'github', config: { repo: 'TencentYoutuResearch/Palm-Tools', workspace: '/repo', watch_commits: true, instructions: 'v2' } })
  assert.equal(gh2.id, gh1.id)
  assert.equal(gh2.watch_id, gh1.watch_id)
  assert.equal(backend.watches.size, 1)
  assert.equal(backend.watches.get(gh2.watch_id).spec.do, 'v2')

  // Simulate orphaned `连接器 · ...` watches left over from earlier failed requests + one manual user watch
  backend.watches.set('w_orphan_1', { id: 'w_orphan_1', bot: bot.id, enabled: true, spec: { name: '连接器 · 企业微信', on: { topic: 'wecom/message' }, do: 'x' } })
  backend.watches.set('w_orphan_2', { id: 'w_orphan_2', bot: bot.id, enabled: true, spec: { name: '连接器 · GitHub', on: { topic: 'git.commit' }, do: 'x' } })
  backend.watches.set('w_manual', { id: 'w_manual', bot: bot.id, enabled: true, spec: { name: 'kode代码', on: { topic: 'session.exited' }, do: 'summary' } })

  const pruned = await store.pruneOrphanWatches([...backend.watches.values()])
  assert.deepEqual(pruned.sort(), ['w_orphan_1', 'w_orphan_2'])
  assert.equal(backend.watches.has('w_manual'), true, 'manual watch is untouched')
  assert.equal(backend.watches.has(gh2.watch_id), true, 'active connector watch is kept')

  // Toggling or deleting from the Watches tab syncs back to the connector store
  await store.syncByWatchToggle(gh2.watch_id, false)
  assert.equal((await store.readAll())[0].enabled, false)
  await store.removeByWatchId(gh2.watch_id)
  assert.equal((await store.readAll()).length, 0)
})
