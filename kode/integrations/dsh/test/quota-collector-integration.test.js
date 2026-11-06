/** Real isolated Hub and spawned protocol fixture; no provider requests. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BackendClient } from '../src/backend-client.js'
import { CodexSession } from '../src/codex-session.js'
import { prepareQuotaCollector } from '../src/quota-collector.js'
const url = process.env.KODE_TEST_BACKEND_URL, tokenFile = process.env.KODE_TEST_TOKEN_FILE

test('actual idle executor quota reaches Hub then account change revokes the pinned resource', { skip: !url || !tokenFile }, async () => {
  const admin = new BackendClient(url, (await readFile(tokenFile, 'utf8')).trim())
  const { node_id: host } = await admin.call('/api/v1/messaging/node')
  const account = `quota-${randomUUID()}`, profile = `profile-${randomUUID()}`
  await admin.call('/api/v1/messaging/resource-accounts', { id: account, expected_epoch: 0, enabled: true })
  await admin.call('/api/v1/messaging/resource-bindings', { host, profile, account_id: account, account_epoch: 1, expected_revision: 0 })
  const collector = await prepareQuotaCollector(admin, host, profile)
  let done, fail, sampled
  const finished = new Promise((resolve, reject) => { done = resolve; fail = reject })
  const session = new CodexSession({ executable: process.execPath, args: [fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))], env: { KODE_FIXTURE_QUOTA: '1', KODE_FIXTURE_QUOTA_ACCOUNT_CHANGE: '1' } }, process.cwd(), { quota: async observation => {
    try {
      await collector.publish(observation)
      const snapshot = await admin.call(`/api/v1/messaging/quota-snapshots?host=${encodeURIComponent(host)}&profile=${encodeURIComponent(profile)}`)
      if (observation.status === 'reported') sampled = snapshot
      if (observation.account_changed) done(snapshot)
    } catch (error) { fail(error) }
  } })
  let timer
  try {
    await session.open({}, [], AbortSignal.timeout(5000))
    const revoked = await Promise.race([finished, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Quota publication timed out')), 5000) })])
    assert.equal(sampled.account_id, account)
    assert.equal(sampled.buckets[0].windows[0].window.used_percent, 75)
    assert.equal(revoked.status, 'binding_changed')
    assert.equal(session.active, undefined)
    const restarted = await prepareQuotaCollector(admin, host, profile)
    assert.equal((await restarted.publish(session.quota)).status, 'binding_unavailable')
  } finally { clearTimeout(timer); await session.close() }
})
