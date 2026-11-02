import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { CHAT_SETTINGS_NAMESPACE, Config } from '@deepseek-ai/dsh-client-ui-chat'

test('adapted Chat retains the official settings entry addressed by Desktop onboarding', async () => {
  const source = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const patches = yaml.load(source.replaceAll('!!js ', ''))
  const entries = applyEntryPatches([{ id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' }], patches, () => {})
  // EntryGroup.update resolves each id to its last entry before activation.
  const chat = Object.fromEntries(entries.map(row => [row.id, row]))[CHAT_SETTINGS_NAMESPACE]
  assert.equal(chat.name, '@kode/dsh-chat')
  assert.notEqual(chat.disabled, true)
  assert.doesNotThrow(() => Config(chat.config))
  assert.equal(chat.config.transcriptView, 'standard')
})
