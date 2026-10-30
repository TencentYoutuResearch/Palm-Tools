import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

test('default composition exposes built-in dsh and preserves official settings and trajectory', async () => {
  const patch = load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema })
  const builtin = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'kode-dsh-conversation')
  assert.ok(builtin)
  assert.notEqual(builtin.disabled, true)
  for (const id of ['ui-settings-models', 'ui-settings-web-search', 'ui-trajectory']) {
    assert.notEqual(patch.find(row => row.id === id)?.disabled, true, id)
  }
  const client = await readFile(new URL('../src/agent-client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(client, /function AgentTrajectory|function AgentSettingsShell/)
  const host = await readFile(new URL('../src/dsh-conversation.js', import.meta.url), 'utf8')
  assert.doesNotMatch(host, /loader\.create\(['"]@deepseek-ai\/dsh-client-ui-settings-models/)
})
