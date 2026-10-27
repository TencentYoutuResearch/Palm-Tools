import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpSession } from '../src/acp-session.js'
const fixture = fileURLToPath(new URL('./fixture-acp-server.js', import.meta.url))
const tools = [{ name: 'kode_sessions_list', description: 'List sessions', parameters: { type: 'object', properties: {} } }]
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events }
test('ACP supports independent profiles, scoped MCP tools, permissions, models, followups and native restoration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-acp-')), log = join(root, 'requests.jsonl')
  const profile = label => ({ type: 'custom', executable: process.execPath, args: [fixture], env: { KODE_ACP_FIXTURE_LABEL: label, KODE_ACP_FIXTURE_LOG: log } })
  let toolCalls = 0, permissions = 0, mode = 'read-only'
  const handlers = { policy: () => ({ mode }), tool: async () => { toolCalls++; return { success: true, contentItems: [{ type: 'inputText', text: 'owned session directory' }] } }, approve: async () => { permissions++; return false } }
  const a = new AcpSession(profile('one'), root, handlers), b = new AcpSession(profile('two'), root, handlers)
  let resumed
  try {
    const [id, same] = await Promise.all([a.open({}, tools), b.open({}, tools)])
    assert.equal(id, same)
    const [first, second] = await Promise.all([collect(a.turn([{ type: 'text', text: 'APPROVAL TOOL first' }], { model: 'fixture-large' })), collect(b.turn([{ type: 'text', text: 'second' }]))])
    assert.equal(toolCalls, 1); assert.equal(permissions, 1)
    assert.equal(first.find(e => e.method === 'item/agentMessage/delta').params.delta, 'one: APPROVAL TOOL first')
    assert.equal(second.find(e => e.method === 'item/agentMessage/delta').params.delta, 'two: second')
    mode = 'workspace-write'
    await collect(a.turn([{ type: 'text', text: 'followup' }]))
    mode = 'read-only'
    await a.close()
    resumed = new AcpSession(profile('one'), root, handlers)
    await resumed.open({ threadId: id }, tools)
    const again = await collect(resumed.turn([{ type: 'text', text: 'restored followup' }]))
    assert.equal(again.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join(''), 'one: restored followup')
    const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(records.some(r => r.method === 'session/set_mode' && r.params.modeId === 'plan'))
    assert.ok(records.some(r => r.method === 'session/set_mode' && r.params.modeId === 'agent'))
    assert.ok(records.filter(r => ['session/new', 'session/load'].includes(r.method)).every(r => r.params.cwd === root), 'ACP workspace is the owning session directory')
    assert.ok(records.some(r => r.method === 'session/set_config_option' && r.params.value === 'fixture-large'))
    assert.ok(records.some(r => r.method === 'session/load' && r.params.sessionId === id))
    assert.equal(records.find(r => r.method === 'permission-result').params.outcome.optionId, 'deny')
  } finally { await Promise.all([a.close(), b.close(), resumed?.close()]); await rm(root, { recursive: true, force: true }) }
})
test('ACP cancellation closes the owned process and missing resume capability never starts a replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-acp-cancel-'))
  const profile = { type: 'custom', executable: process.execPath, args: [fixture] }
  const session = new AcpSession(profile, root), unsupported = new AcpSession({ ...profile, env: { KODE_ACP_NO_RESUME: '1' } }, root)
  try {
    await session.open({}, [])
    const controller = new AbortController()
    const task = collect(session.turn([{ type: 'text', text: 'WAIT' }], { signal: controller.signal }))
    const timer = setTimeout(() => controller.abort(new Error('cancel fixture')), 50)
    await assert.rejects(task, /cancel fixture/); clearTimeout(timer)
    assert.equal(session.rpc.closed, true)
    await assert.rejects(unsupported.open({ threadId: 'saved' }, []), /cannot restore/)
  } finally { await Promise.all([session.close(), unsupported.close()]); await rm(root, { recursive: true, force: true }) }
})
for (const type of ['claude', 'cursor','codebuddy']) test(`installed ${type} supports ACP models, MCP configuration and read-only mode without inference`, { skip: !process.env[`KODE_TEST_${type.toUpperCase()}_EXECUTABLE`] }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-native-acp-'))
  const env = type === 'claude' ? { CLAUDE_CONFIG_DIR: root, ANTHROPIC_API_KEY: 'local-protocol-fixture-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } : {}
  const session = new AcpSession({ type, executable: process.env[`KODE_TEST_${type.toUpperCase()}_EXECUTABLE`], args: [], env }, root, {
    policy: () => ({ mode: 'read-only' }), tool: async () => { throw new Error('No inference or tool execution expected during discovery') },
  })
  try {
    await session.open({}, tools, AbortSignal.timeout(20000))
    const option = session.state.configOptions?.find(o => o.category === 'model' || o.id === 'model')
    const model = option?.options.flatMap(o => o.options ?? [o])[0]
    assert.ok(model?.value, 'native model discovery must return a selectable model')
    await session.configure(model.value, AbortSignal.timeout(15000))
    assert.ok(['plan', 'ask', 'read-only'].includes(session.state.modes.currentModeId))
    assert.ok(session.proxy)
  } finally { await session.close(); await rm(root, { recursive: true, force: true }) }
})
