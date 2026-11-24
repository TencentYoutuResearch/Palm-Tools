import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseEntryYaml, stringifyEntryYaml } from '@deepseek-ai/cordis-plugin-include'
test('current Include round-trips the ACP patch', () => {
  const patch = [{ id: 'acp', config: { provider: 'fixture', model: 'test' } }]
  assert.deepEqual(parseEntryYaml(stringifyEntryYaml(patch)), patch)
})
test('conversation imports current Include API without legacy fallback', async () => {
  const source = await readFile(new URL('../src/dsh-conversation.js', import.meta.url), 'utf8')
  assert.match(source, /import \{ stringifyEntryYaml \}/)
  assert.doesNotMatch(source, /entryListSchema|js-yaml/)
  await import('../src/dsh-conversation.js')
})
