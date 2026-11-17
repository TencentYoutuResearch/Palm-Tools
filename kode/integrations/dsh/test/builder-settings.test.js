import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAgentPreferences } from '../src/local-agent-preferences.js'
import { BUILDER_PLANNING_PROMPT, BUILDER_PLANNING_PROMPT_VERSION } from '../src/builder-planning-prompt.js'
import { nativeRoleInstructions } from '../src/native-role-prompt.js'
import { createBuilderSettings, readBuilderPrompt, registerBuilderSettings, normalizeBuilderPrompt, builderPromptSnapshot, assertBuilderPromptJournal, BUILDER_PROMPT_RECORD } from '../src/builder-settings.js'
test('Builder settings persist locally, preserve other preferences, CAS and lost-response retries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kode-builder-settings-')); t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'preferences.json'), preferences = await new LocalAgentPreferences(path).open()
  await preferences.setModel('cli', { model: 'fixture-model' })
  const settings = createBuilderSettings(preferences), first = await settings.read()
  assert.equal(first.system_prompt, '')
  assert.equal(first.default_system_prompt, BUILDER_PLANNING_PROMPT)
  assert.equal(first.default_system_prompt_version, BUILDER_PLANNING_PROMPT_VERSION)
  assert.equal(first.prompt_mode, 'append')
  assert.equal(nativeRoleInstructions(null, { nativePlanning: true, builderPrompt: builderPromptSnapshot(first.system_prompt) }), first.default_system_prompt)
  const command = { expected_revision: first.revision, system_prompt: '先明确目标，再规划角色。' }
  const saved = await settings.save(command)
  assert.equal(saved.revision, first.revision + 1)
  assert.equal(saved.default_system_prompt, first.default_system_prompt)
  assert.equal(saved.prompt_mode, 'append')
  assert.equal(Object.hasOwn(preferences.snapshot(), 'default_system_prompt'), false)
  assert.ok(nativeRoleInstructions(null, { nativePlanning: true, builderPrompt: builderPromptSnapshot(saved.system_prompt) }).startsWith(saved.default_system_prompt + '\n\n'))
  assert.deepEqual(await settings.save(command), saved)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  const cold = await new LocalAgentPreferences(path).open(), settings2 = createBuilderSettings(cold)
  assert.deepEqual(await settings2.read(), saved)
  assert.equal(cold.selectionFor('cli').model, 'fixture-model')
  const snapshot = await readBuilderPrompt({ localPreferences: cold })
  assert.equal(snapshot.text, command.system_prompt); assert.equal(snapshot.revision, saved.revision)
  await assert.rejects(settings2.save({ ...command, system_prompt: 'Different stale change' }), { code: 'BUILDER_SETTINGS_CONFLICT' })
  const reset = await settings2.save({ expected_revision: saved.revision, system_prompt: '' })
  assert.equal(reset.system_prompt, ''); assert.equal(snapshot.text, command.system_prompt)
  assert.equal(reset.default_system_prompt, first.default_system_prompt)
  assert.equal(nativeRoleInstructions(null, { nativePlanning: true, builderPrompt: builderPromptSnapshot(reset.system_prompt) }), reset.default_system_prompt)
  for (const field of ['default_system_prompt', 'default_system_prompt_version', 'prompt_mode']) {
    await assert.rejects(settings2.save({ expected_revision: reset.revision, system_prompt: '', [field]: 'replacement' }), { code: 'INVALID_REQUEST' })
  }
  assert.deepEqual(await settings2.read(), reset)
})
test('Builder prompt validation and journal reject corruption without adopting old conversations', () => {
  for (const value of [null, undefined, 12, '\0', ' ', '\ud800', '中'.repeat(5334)]) assert.throws(() => normalizeBuilderPrompt(value))
  assert.equal(normalizeBuilderPrompt('中'.repeat(5333)).length, 5333)
  const snapshot = builderPromptSnapshot('Only plan', 2)
  assertBuilderPromptJournal([], undefined)
  assertBuilderPromptJournal([{ type: BUILDER_PROMPT_RECORD, data: snapshot }], snapshot)
  assert.throws(() => assertBuilderPromptJournal([], snapshot))
  assert.throws(() => assertBuilderPromptJournal([{ type: BUILDER_PROMPT_RECORD, data: snapshot }], undefined))
  assert.throws(() => assertBuilderPromptJournal([{ type: BUILDER_PROMPT_RECORD, data: { ...snapshot, text: 'changed' } }], snapshot))
})
test('settings endpoint admits only owner and reports unknown writes as uncertain', async () => {
  let handler, calls = 0, owner = false
  const ctx = { webServer: { register(route) { handler = route.handler } }, connection: { admit: () => ({ peer: { principal: { kind: owner ? 'owner' : 'peer' } } }) } }
  registerBuilderSettings(ctx, { read: async () => { calls++; return {} }, save: async () => { calls++; throw Error('Disk sync uncertain') } })
  const request = method => ({ method, headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from('{"expected_revision":0,"system_prompt":"test"}') } })
  const res = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
  await handler(request('GET'), res); assert.equal(res.status, 403); assert.equal(calls, 0)
  owner = true; await handler(request('POST'), res); assert.equal(res.status, 405)
  await handler(request('PUT'), res); assert.equal(res.status, 409); assert.equal(res.body.code, 'BUILDER_SETTINGS_UNCERTAIN')
})
