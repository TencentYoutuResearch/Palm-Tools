import test from 'node:test'
import assert from 'node:assert/strict'
import { WeComBridge, registerWeComApi, runWeComTool } from '../src/wecom-bridge.js'

test('WeComBridge probes auth, lists sessions/messages, sends markdown, and publishes new wecom/message events without replaying history', async () => {
  const calls = [], events = []
  let pollRound = 0
  const runner = async args => {
    calls.push(args)
    if (args[0] === 'auth') return { stdout: 'Status: authorized\nBot ID: aib-bot-1\n', stderr: '' }
    if (args[0] === 'message' && args[1] === 'aibot' && args[2] === 'sessions') {
      return { stdout: JSON.stringify({ sessions: [{ chat_id: 'wr-room-1', name: '研发群', chat_type: 'group' }] }), stderr: '' }
    }
    if (args[0] === 'chat' && args[1] === 'messages') {
      pollRound++
      const msgs = pollRound === 1
        ? [{ msg_id: 'm-old', sender: 'alice', sender_name: 'Alice', content: '历史消息', msg_type: 'text', send_time: '2026-11-25 16:00:00' }]
        : [
            { msg_id: 'm-old', sender: 'alice', sender_name: 'Alice', content: '历史消息', msg_type: 'text', send_time: '2026-11-25 16:00:00' },
            { msg_id: 'm-bot', sender: 'aib-bot-1', sender_name: 'Bot', content: '机器人自己的回复', msg_type: 'text', send_time: '2026-11-25 16:01:00' },
            { msg_id: 'm-new', sender: 'bob', sender_name: 'Bob', content: '请帮我查一下今天的构建失败原因', msg_type: 'text', send_time: '2026-11-25 16:02:00' },
          ]
      return { stdout: JSON.stringify({ messages: msgs }), stderr: '' }
    }
    if (args[0] === 'message' && args[1] === 'aibot' && args[2] === 'send') {
      return { stdout: JSON.stringify({ errcode: 0, errmsg: 'ok' }), stderr: '' }
    }
    return { stdout: '{}', stderr: '' }
  }
  const backend = {
    async call(path, body) {
      if (path === '/api/v1/messaging/workbench/events') { events.push(body); return { topic: body.topic } }
      return { revision: 0, value: null }
    },
  }
  const bridge = new WeComBridge(backend, { runner, binary: 'wecom-cli' })
  const status = await bridge.status()
  assert.equal(status.installed, true)
  assert.equal(status.authorized, true)
  assert.equal(status.bot_id, 'aib-bot-1')

  // First poll seeds existing history without triggering bots
  const seeded = await bridge.pollOnce({ seed: true })
  assert.equal(seeded.published, 0)
  assert.equal(events.length, 0)

  // Second poll publishes only the new user message (ignores old and bot-authored messages)
  const second = await bridge.pollOnce()
  assert.equal(second.published, 1)
  assert.equal(events.length, 1)
  assert.equal(events[0].topic, 'wecom/message')
  assert.equal(events[0].payload.chat_id, 'wr-room-1')
  assert.equal(events[0].payload.sender_name, 'Bob')
  assert.match(events[0].payload.content, /构建失败/)

  // Agent tool send
  const sent = await runWeComTool(bridge, 'wecom_message_send', { chat_id: 'wr-room-1', content: '**已定位根因**' })
  assert.equal(sent.ok, true)
  const sendCall = calls.at(-1)
  assert.deepEqual(sendCall.slice(0, 5), ['message', 'aibot', 'send', '--chat-id', 'wr-room-1'])
})

test('WeComBridge surfaces verbatim help_message on errcode 850003 and registerWeComApi enforces owner auth', async () => {
  const help = '当前机器人「消息」使用权限已过期\n请点击授权链接重新授权'
  const bridge = new WeComBridge(null, {
    binary: 'wecom-cli',
    runner: async args => args[0] === 'auth'
      ? { stdout: 'Status: authorized\nBot ID: b1\n', stderr: '' }
      : { stdout: JSON.stringify({ errcode: 850003, errmsg: 'authorization expired', help_message: help }), stderr: '' },
  })
  const sessions = await bridge.listSessions()
  assert.equal(sessions.errcode, 850003)
  assert.equal(sessions.help_message, help)
  assert.equal(bridge.authNotice, help)

  let handler, owner = false
  registerWeComApi({
    webServer: { register(route) { handler = route.handler; return () => {} } },
    connection: { admit: () => ({ peer: { principal: { kind: owner ? 'owner' : 'session' } } }) },
  }, bridge)
  const callApi = async (method = 'GET', body = null) => {
    let statusCode = 200, text = ''
    const req = { method, url: '/api/kode/wecom', async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body) } }
    const res = { set statusCode(c) { statusCode = c }, get statusCode() { return statusCode }, setHeader() {}, end(v) { text = v } }
    await handler(req, res)
    return { statusCode, body: JSON.parse(text) }
  }
  assert.equal((await callApi()).statusCode, 403)
  owner = true
  const ok = await callApi('GET')
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.body.auth_notice, help)
})
