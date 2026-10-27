import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendClient } from '../src/backend-client.js'
import { BackendAgentProfiles, BackendDocument } from '../src/backend-state.js'
const url = process.env.KODE_TEST_BACKEND_URL, tokenFile = process.env.KODE_TEST_TOKEN_FILE
test('Kode backend configuration migrates once and shares immutable CLI bindings across frontend adapters', { skip: !url || !tokenFile }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-shared-state-'))
  const client = new BackendClient(url, (await readFile(tokenFile, 'utf8')).trim())
  try {
    const first = await new BackendAgentProfiles(client, join(root, 'old.json')).open([{ id: 'shared-profile', name: 'Portable Codex', type: 'codex', executable: 'tcodex' }])
    await first.bind('saved-native-session', 'shared-profile')
    await first.patchBinding('saved-native-session', { threadId: 'native-thread' })
    const second = await new BackendAgentProfiles(client, join(root, 'another-frontend.json')).open([])
    assert.equal(second.binding('saved-native-session').threadId, 'native-thread')
    await second.remove('shared-profile')
    await first.reload()
    assert.equal(first.list().some(p => p.id === 'shared-profile'), false)
    assert.equal(first.binding('saved-native-session').profile.executable, 'tcodex')
    const a = new BackendDocument(client, 'session-index'), b = new BackendDocument(client, 'session-index')
    await a.read(); await b.read(); await a.write({ sessions: [] })
    await assert.rejects(b.write({ sessions: ['stale'] }), /configuration changed/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
