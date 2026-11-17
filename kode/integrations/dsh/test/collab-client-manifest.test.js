import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('collaboration arrives after the installed sidebar and composer client modules', async () => {
  const read = async name => JSON.parse(await readFile(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8'))
  const [collab, sidebar, composer] = await Promise.all([read('collab'), read('sidebar'), read('composer')])
  assert.ok(collab.dsh.client.inject.includes(sidebar.name))
  assert.ok(collab.dsh.client.inject.includes(composer.name))
  assert.ok(!collab.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'))
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  for (const pkg of [collab, sidebar, composer]) assert.ok(patch.includes(`name: '${pkg.name}'`))
})
