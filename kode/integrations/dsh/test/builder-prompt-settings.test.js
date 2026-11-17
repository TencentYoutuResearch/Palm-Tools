import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Client of owner-only GET/PUT /api/kode/builder/settings; UI imports are inert stubs.
const stub = { name: 'stub', setup(b) { b.onResolve({ filter: /^[^./]/ }, args => ({ path: args.path, namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'const any=new Proxy(function(){},{get:(t,k)=>k==="__esModule"?false:any,apply:()=>any});module.exports=any', loader: 'js' })) } }
const out = await build({ entryPoints: ['packages/collab/builder-prompt-settings.js'], bundle: true, format: 'esm', platform: 'node', plugins: [stub], write: false })
const dir = await mkdtemp(join(tmpdir(), 'builder-prompt-')), file = join(dir, 'builder-prompt.mjs')
await writeFile(file, out.outputFiles[0].text)
const { parseBuilderSettings, readBuilderSettings, saveBuilderSettings } = await import(file)
test.after(() => rm(dir, { recursive: true, force: true }))

const doc = (revision, system_prompt) => ({ version: 1, revision, system_prompt, scope: 'local_host', applies_to: 'new_planning_sessions' })
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body })
const server = responses => { const calls = []; return { calls, fetcher: async (path, init) => { calls.push({ path, method: init.method, body: init.body && JSON.parse(init.body), init }); const next = responses.shift(); if (next instanceof Error) throw next; return next } } }

test('only the exact contract is accepted', () => {
  assert.deepEqual(parseBuilderSettings(doc(3, 'x')), { revision: 3, systemPrompt: 'x', defaultPrompt: null, defaultVersion: null })
  for (const bad of [{ ...doc(1, ''), version: 2 }, { ...doc(1, ''), scope: 'hub' }, { ...doc(1, ''), applies_to: 'all_sessions' }, { ...doc(-1, '') }, { ...doc(1, null) }])
    assert.throws(() => parseBuilderSettings(bad), /无法识别/)
})

test('GET and PUT use the owner route, same-origin, no extra credentials or headers', async () => {
  const s = server([reply(200, doc(2, 'a')), reply(200, doc(3, 'b'))])
  assert.deepEqual(await readBuilderSettings({ fetcher: s.fetcher }), { revision: 2, systemPrompt: 'a', defaultPrompt: null, defaultVersion: null })
  assert.deepEqual(await saveBuilderSettings({ expectedRevision: 2, systemPrompt: 'b' }, { fetcher: s.fetcher }), { revision: 3, systemPrompt: 'b', defaultPrompt: null, defaultVersion: null })
  assert.deepEqual(s.calls.map(c => [c.path, c.method]), [['/api/kode/builder/settings', 'GET'], ['/api/kode/builder/settings', 'PUT']])
  assert.deepEqual(s.calls[1].body, { expected_revision: 2, system_prompt: 'b' }, 'PUT carries only the two fields')
  assert.equal(s.calls[1].init.credentials, 'same-origin'); assert.equal(s.calls[1].init.redirect, 'error')
  assert.deepEqual(Object.keys(s.calls[1].init.headers), ['content-type'])
})

test('conflict and input errors are definite: no verification read, no false save', async () => {
  for (const [status, code] of [[409, 'BUILDER_SETTINGS_CONFLICT'], [400, 'INVALID'], [404, undefined]]) {
    const s = server([reply(status, { error: { code, message: 'no' } })])
    await assert.rejects(saveBuilderSettings({ expectedRevision: 2, systemPrompt: 'b' }, { fetcher: s.fetcher }), e => e.status === status && e.code === code)
    assert.equal(s.calls.length, 1)
  }
  const s = server([])
  await assert.rejects(saveBuilderSettings({ expectedRevision: 2, systemPrompt: 'é'.repeat(8001) }, { fetcher: s.fetcher }), /16000/)
  assert.equal(s.calls.length, 0, 'over-limit never leaves the browser')
})

test('uncertain outcome is decided by GET: held → saved, absent → uncertain with current', async () => {
  const held = server([reply(409, { error: { code: 'BUILDER_SETTINGS_UNCERTAIN' } }), reply(200, doc(3, 'b'))])
  assert.deepEqual(await saveBuilderSettings({ expectedRevision: 2, systemPrompt: 'b' }, { fetcher: held.fetcher }), { revision: 3, systemPrompt: 'b', defaultPrompt: null, defaultVersion: null })
  assert.deepEqual(held.calls.map(c => c.method), ['PUT', 'GET'])
  const absent = server([new TypeError('network'), reply(200, doc(2, 'a'))])
  await assert.rejects(saveBuilderSettings({ expectedRevision: 2, systemPrompt: 'b' }, { fetcher: absent.fetcher }), e => e.uncertain && e.current.revision === 2)
  const unknown = server([reply(500, {}), new TypeError('network')])
  await assert.rejects(saveBuilderSettings({ expectedRevision: 2, systemPrompt: 'b' }, { fetcher: unknown.fetcher }), e => e.uncertain && e.current === null)
  const mismatch = server([reply(200, doc(3, 'other')), reply(200, doc(3, 'other'))])
  await assert.rejects(saveBuilderSettings({ expectedRevision: 2, systemPrompt: 'b' }, { fetcher: mismatch.fetcher }), e => e.uncertain)
})

test('base instruction is read-only data; preference is the append mode, old services omit the base', () => {
  const full = { ...doc(5, 'pref'), default_system_prompt: 'BASE\n安全规则', default_system_prompt_version: 'kode.builder.native-planning.v1', prompt_mode: 'append' }
  assert.deepEqual(parseBuilderSettings(full), { revision: 5, systemPrompt: 'pref', defaultPrompt: 'BASE\n安全规则', defaultVersion: 'kode.builder.native-planning.v1' })
  assert.equal(parseBuilderSettings({ ...full, default_system_prompt: '  ' }).defaultPrompt, null)
  for (const bad of [{ ...full, prompt_mode: 'replace' }, { ...full, default_system_prompt: 3 }, { ...full, default_system_prompt_version: 1 }])
    assert.throws(() => parseBuilderSettings(bad), /无法识别/)
})

test('empty string restores the built-in default through the same PUT', async () => {
  const s = server([reply(200, doc(4, ''))])
  assert.deepEqual(await saveBuilderSettings({ expectedRevision: 3, systemPrompt: '' }, { fetcher: s.fetcher }), { revision: 4, systemPrompt: '', defaultPrompt: null, defaultVersion: null })
  assert.deepEqual(s.calls[0].body, { expected_revision: 3, system_prompt: '' })
})
