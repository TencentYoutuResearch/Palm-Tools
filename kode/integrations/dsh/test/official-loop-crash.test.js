/** Actual process death during a tool body, durable journal recovery and refusal to replay. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { realpath, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedHub } from './support/isolated-hub.js'

test('official Host SIGKILL retains partial effects and recovers uncertainty without reclaiming its old lease', {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE, timeout: 30000,
}, async () => {
  const hub = await isolatedHub('official-crash')
  let child
  const kill = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  }
  try {
    const root = await realpath(hub.root)
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'crash', worker: { node_id: hub.node, session_id: 'worker' }, grant_required: true })
    const scope = { team_id: 'team', revision: 1, target: { host: hub.node, workspace: 'fixture', root }, capabilities: ['workspace_write'], tools: ['fixture_effect'], network: false, budget_ids: [] }
    await hub.client.call('/api/v1/messaging/team-grants', { expected_revision: 0, policy: { id: 'grant', team_id: 'team', enabled: true, expires_at: Date.now() + 60000, targets: [scope.target], capabilities: scope.capabilities, tools: scope.tools, network: false, budget_ids: [] } })
    await hub.client.call(`/api/v1/messaging/operations/${op.id}/grant`, { expected_revision: op.revision, binding: { grant_id: 'grant', attempt: 1, epoch: 1, scope } })
    const start = mode => new Promise((resolve, reject) => {
      child = fork(fileURLToPath(new URL('./fixture-official-loop-crash.js', import.meta.url)), [mode, root, hub.url, join(root, 'admin.token'), hub.node, op.id], {
        execPath: process.env.KODE_TEST_HOST_NODE, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      })
      const timer = setTimeout(() => done(new Error('Official child fixture timed out')), 15000)
      const exited = () => done(new Error('Official child exited before evidence'))
      const message = result => result.type === 'failed' ? done(new Error(`Official child failed: ${mode}/${result.stage}/${result.code}`)) : done(null, result)
      const done = (error, result) => { clearTimeout(timer); child.off('exit', exited); child.off('message', message); error ? reject(error) : resolve(result) }
      child.once('exit', exited); child.once('message', message)
    })
    const effect = await start('start')
    assert.deepEqual(effect, { type: 'effect', calls: 1, effects: 1 })
    await kill()
    assert.equal(await readFile(join(root, 'effects.txt'), 'utf8'), 'effect\n')
    const before = JSON.parse(await readFile(join(root, 'profiles.json'), 'utf8'))
    assert.equal(before.bindings.worker.officialTools.partial.status, 'started')
    const recovered = await start('recover')
    assert.equal(recovered.type, 'recovered'); assert.equal(recovered.rejected, true)
    assert.equal(recovered.calls, 0); assert.equal(recovered.effects, 0)
    assert.equal(recovered.status, 'uncertain'); assert.equal(recovered.reason, 'host_restarted')
    assert.equal(recovered.home_reconciled, true); assert.ok(Number.isSafeInteger(recovered.home_sequence))
    assert.equal(recovered.agentAbsent, true); assert.equal(recovered.sessionAbsent, true)
    assert.equal(await readFile(join(root, 'effects.txt'), 'utf8'), 'effect\n')
    assert.notEqual((await hub.client.call(`/api/v1/messaging/operations/${op.id}`)).state, 'reported')
  } finally { await kill(); await hub.close() }
})
