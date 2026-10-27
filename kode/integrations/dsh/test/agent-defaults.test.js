import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
import { agentDefaults, builtinProfiles } from '../src/agent-defaults.js'

test('Host defaults resolve installed CLIs and stay separate from custom configuration CRUD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-default-agents-'))
  try {
    for (const name of ['codex', 'claude', 'cursor-agent']) {
      const file = join(root, name); await writeFile(file, '#!/bin/sh\nexit 0\n'); await chmod(file, 0o700)
    }
    const types = await agentDefaults(root)
    assert.equal(types.cursor.executable, join(root, 'cursor-agent'), 'never use the Cursor GUI launcher')
    assert.equal(types.codex.executable, join(root, 'codex'))
    const profiles = await new AgentProfiles(join(root, 'profiles.json')).open()
    await profiles.ensureBuiltins(builtinProfiles(types))
    assert.equal(profiles.list().filter(p => p.origin === 'builtin').length, 4)
    assert.equal(profiles.list().filter(p => p.origin === 'custom').length, 0)
    const custom = await profiles.save({ name: 'Company Codex', type: 'codex', executable: 'tcodex', origin: 'builtin' })
    assert.equal(custom.origin, 'custom', 'API inputs cannot grant built-in status')
    await profiles.bind('active', custom.id)
    await profiles.ensureBuiltins(builtinProfiles(await agentDefaults(`${root}${delimiter}/missing`)))
    assert.equal(profiles.get(custom.id).executable, 'tcodex')
    await assert.rejects(profiles.remove('builtin-codex'), /不能删除/)
    await assert.rejects(profiles.save({ ...profiles.get('builtin-codex'), executable: 'replacement' }), /不能修改/)
    await profiles.remove(custom.id)
    assert.equal(profiles.binding('active').profile.executable, 'tcodex')
    const reopened = await new AgentProfiles(profiles.path).open()
    assert.equal(reopened.get('builtin-codex').origin, 'builtin')
    assert.equal(reopened.list().filter(p => p.origin === 'custom').length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
