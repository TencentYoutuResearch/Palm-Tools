import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeInput } from '../src/native-input.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter, profileRoute } from '../src/agent-runtime.js'
const bytes = Buffer.from('verified image bytes')
const ref = { attachmentId: 'fixture', mediaType: 'image/png', bytes: bytes.length, width: 2, height: 2 }
const collect = async stream => { for await (const _ of stream) {} }

test('official attachment bytes map to native Codex paths and ACP image blocks in message order', async () => {
  let reads = 0
  const attachments = { imageHostPath: () => '/immutable/image.png', readImage: async value => { assert.equal(value, ref); reads++; return { ref, data: bytes } } }
  const messages = [{ content: [{ type: 'text', text: 'Look' }, { type: 'image', attachment: ref }] }]
  const before = structuredClone(messages)
  assert.deepEqual(await nativeInput(messages, { attachments, codex: true }), [{ type: 'text', text: 'Look' }, { type: 'localImage', path: '/immutable/image.png' }])
  assert.deepEqual((await nativeInput(messages, { attachments, codex: false }))[1], { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') })
  const remoteStore = { ...attachments, imageHostPath: () => undefined }
  assert.deepEqual((await nativeInput(messages, { attachments: remoteStore, codex: true }))[1], { type: 'image', url: `data:image/png;base64,${bytes.toString('base64')}` })
  assert.equal(reads, 3); assert.deepEqual(messages, before)
  await assert.rejects(nativeInput(messages, { codex: true }), /附件服务/)
  await assert.rejects(nativeInput(messages, { codex: true, attachments: { ...attachments, readImage: async () => { throw new Error('digest mismatch') } } }), /digest mismatch/)
})

for (const type of ['codex', 'custom']) test(`${type} preserves image capability, mixed input and restart references`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-image-input-')), log = join(root, 'wire.jsonl')
  const fixture = fileURLToPath(new URL(type === 'codex' ? './fixture-codex-server.js' : './fixture-acp-server.js', import.meta.url))
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'images', name: 'Images', type, executable: process.execPath, args: [fixture], env: { KODE_ACP_IMAGES: '1', KODE_ACP_FIXTURE_LOG: log, KODE_FIXTURE_RPC_LOG: log } }])
  const attachments = { imageHostPath: () => join(root, 'image.png'), readImage: async () => ({ ref, data: bytes }) }
  const agent = { id: 'images', session: { header: { cwd: root }, append() {} }, ctx: { attachments, parallel: async () => {}, get: name => name === 'attachments' ? attachments : undefined } }
  const ctx = { agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', seq: 1 } }) } }
  let adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative() {} })
  const message = id => ({ role: 'user', source: { kind: 'user' }, id, content: [{ type: 'text', text: 'Describe $fixture-skill' }, { type: 'image', attachment: ref }] })
  try {
    const models = await adapter.listModels(profileRoute('images'))
    const model = models[0].id
    assert.ok((await adapter.resolveModel(profileRoute('images'), model)).inputModalities.includes('image'))
    await collect(adapter.stream({ provider: profileRoute('images'), sessionId: 'images', model, messages: [message('one')], signal: AbortSignal.timeout(5000) }))
    await adapter.close()
    adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative() {} })
    await collect(adapter.stream({ provider: profileRoute('images'), sessionId: 'images', model, messages: [message('two')], signal: AbortSignal.timeout(5000) }))
    const rows = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    const turns = rows.filter(row => row.method === (type === 'codex' ? 'turn/start' : 'session/prompt'))
    assert.equal(turns.length, 2)
    for (const turn of turns) {
      const input = turn.params.input ?? turn.params.prompt
      assert.equal(input[0].text, 'Describe $fixture-skill')
      if (type === 'codex') { assert.equal(input[1].type, 'localImage'); assert.equal(input[2].type, 'skill') }
      else assert.deepEqual(input[1], { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') })
    }
    assert.ok(rows.some(row => row.method === (type === 'codex' ? 'thread/resume' : 'session/load')))
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }) }
})

test('ACP without an advertised image capability remains text-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-no-images-'))
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'text', name: 'Text', type: 'custom', executable: process.execPath, args: [fileURLToPath(new URL('./fixture-acp-server.js', import.meta.url))] }])
  const adapter = new AgentRuntimeAdapter({}, profiles)
  try { assert.deepEqual((await adapter.listModels(profileRoute('text')))[0].inputModalities, ['text']) }
  finally { await adapter.close(); await rm(root, { recursive: true, force: true }) }
})
