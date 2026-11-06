import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { isolatedHub } from './support/isolated-hub.js'

test('workflow evidence rules pin artifact sources, independent review and configured verification scenarios', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('workflow-evidence')
  try {
    const path = '/api/v1/messaging/workflows'
    const stage = (id, requires, produces, independent_from = []) => ({ id, role: 'custom', requires, produces, independent_from })
    const pack = { id: 'delivery', version: '1', inputs: ['request'], stages: [stage('build', ['request'], ['snapshot']), stage('assess', ['build'], ['review'], ['build']), stage('exercise', ['assess'], ['checks'])], completion_stages: ['exercise'],
      evidence_rules: { snapshot: { kind: 'artifact', repository_binding: 'primary' }, review: { kind: 'review', artifact_output: 'snapshot' }, checks: { kind: 'verification', artifact_output: 'snapshot', command_binding: 'regression', environment_binding: 'local', required_scenarios: ['smoke', 'acceptance'] } } }
    const validate = input => hub.client.call(`${path}/validate`, input)
    assert.equal((await validate(pack)).evidence_rules_declared, true)
    for (const mutate of [
      p => delete p.evidence_rules.review,
      p => { p.evidence_rules.extra = { kind: 'artifact', repository_binding: 'primary' } },
      p => { p.evidence_rules.checks.artifact_output = 'review' },
      p => { p.evidence_rules.review.artifact_output = 'missing' },
      p => { p.stages[1].independent_from = [] },
      p => { p.evidence_rules.checks.required_scenarios = [] },
      p => { p.evidence_rules.checks.required_scenarios = ['same', 'same'] },
      p => { p.evidence_rules.checks.command_binding = 'sh -c arbitrary' },
    ]) {
      const bad = structuredClone(pack); mutate(bad); await assert.rejects(validate(bad))
    }
    const stored = await hub.client.call(path, pack)
    assert.equal(stored.hash_format, 'kode.workflow.evidence.v2')
    assert.equal(stored.eligible_for_execution, false)
    const reordered = structuredClone(pack); reordered.evidence_rules.checks.required_scenarios.reverse()
    assert.deepEqual(await hub.client.call(path, reordered), stored)
    const changed = structuredClone(pack); changed.evidence_rules.checks.command_binding = 'other'
    await assert.rejects(hub.client.call(path, changed), /immutable/)
    changed.version = '2'
    assert.notEqual((await hub.client.call(path, changed)).hash, stored.hash)
    const scoped = structuredClone(pack); scoped.version = 'scoped'
    scoped.stages.forEach(s => { s.execution = { repository_binding: 'primary', capabilities: ['read'], tools: ['inspect', 'report'], network: false } })
    scoped.stages[0].execution.capabilities.push('workspace_write')
    assert.equal((await validate(scoped)).execution_scopes_declared, true)
    const scopeRecord = await hub.client.call(path, scoped)
    assert.equal(scopeRecord.hash_format, 'kode.workflow.execution.v3')
    const scopeRetry = structuredClone(scoped)
    scopeRetry.stages[0].execution.capabilities.reverse(); scopeRetry.stages[1].execution.tools.reverse()
    assert.deepEqual(await hub.client.call(path, scopeRetry), scopeRecord)
    for (const mutate of [
      p => { p.stages[1].execution.capabilities.push('workspace_write') },
      p => { p.stages[2].execution.capabilities.push('commit') },
      p => { p.stages[0].execution.capabilities.push('read') },
      p => { p.stages[0].execution.tools.push('inspect') },
      p => { p.stages[0].execution.capabilities = ['workspace_write'] },
      p => { p.stages[1].execution.repository_binding = 'other' },
      p => { p.stages[0].execution.command = 'sh -c arbitrary' },
      p => { delete p.evidence_rules },
    ]) { const bad = structuredClone(scoped); mutate(bad); await assert.rejects(validate(bad)) }
    const scopeChange = structuredClone(scoped); scopeChange.stages[0].execution.network = true
    await assert.rejects(hub.client.call(path, scopeChange), /immutable/)
    scopeChange.version = 'scoped-2'
    assert.notEqual((await hub.client.call(path, scopeChange)).hash, scopeRecord.hash)
    const assessed = structuredClone(scoped); assessed.version = 'assessed'
    assessed.stages[0].execution.task_tag = 'implementation'
    const assessedRecord = await hub.client.call(path, assessed)
    assert.equal(assessedRecord.hash_format, 'kode.workflow.execution.v4')
    assert.notEqual(assessedRecord.hash, scopeRecord.hash)
    const wrongTag = structuredClone(assessed); wrongTag.stages[0].execution.task_tag = 'invalid tag'
    await assert.rejects(validate(wrongTag))
    const changedTag = structuredClone(assessed); changedTag.stages[0].execution.task_tag = 'review'
    await assert.rejects(hub.client.call(path, changedTag), /immutable|different|conflict/)
    const partial = structuredClone(scoped); delete partial.stages[2].execution
    assert.equal((await validate(partial)).execution_scopes_declared, false)
    const graphOnly = structuredClone(pack); delete graphOnly.evidence_rules; graphOnly.version = 'graph'
    const legacy = await hub.client.call(path, graphOnly)
    assert.equal(legacy.hash_format, 'kode.workflow.graph.v1')
    assert.equal((await validate(graphOnly)).evidence_rules_declared, false)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(`${path}/delivery/versions/1`), stored)
    assert.deepEqual(await hub.client.call(`${path}/delivery/versions/scoped`), scopeRecord)
  } finally { await hub.close() }
})

test('workflow preflight validates configured graphs without authorizing execution', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('workflow-home')
  try {
    const path = '/api/v1/messaging/workflows/validate'
    const stage = (id, requires) => ({ id, role: 'worker', requires, produces: ['evidence'], independent_from: [] })
    const pack = { id: 'custom', version: '1', inputs: ['request'], stages: [stage('publish', ['inspect']), stage('inspect', ['request'])], completion_stages: ['publish'] }
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    await assert.rejects(hub.client.forSession(registration.owner_token).call(path, pack), /403/)
    const valid = await hub.client.call(path, pack)
    assert.equal(valid.structurally_valid, true)
    assert.equal(valid.eligible_for_execution, false)
    assert.deepEqual(valid.topological_order, ['inspect', 'publish'])
    await assert.rejects(hub.client.call(path, { ...pack, arbitrary_script: 'execute' }), /422/)
    await assert.rejects(hub.client.call(path, { ...pack, completion_stages: ['inspect'] }), /unaccounted/)
    await assert.rejects(hub.client.call(path, { ...pack, stages: [stage('inspect', ['publish']), stage('publish', ['inspect'])] }), /cycle/)
    const reviewed = structuredClone(pack)
    reviewed.stages[0].independent_from = ['inspect']
    reviewed.stages[0].on_reject = { target: 'inspect', max_reworks: 2 }
    assert.equal((await hub.client.call(path, reviewed)).structurally_valid, true)
    reviewed.stages[0].on_reject.target = 'publish'
    await assert.rejects(hub.client.call(path, reviewed), /ancestor/)
    assert.deepEqual((await hub.client.call('/api/v1/messaging/teams')).items, [], 'validation does not create teams')
  } finally { await hub.close() }
})

test('workflow versions are immutable, canonical and durable across lost replies and restart', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('workflow-store-home')
  try {
    const path = '/api/v1/messaging/workflows'
    const pack = { id: 'custom', version: '1', inputs: ['request'], stages: [
      { id: 'build', role: 'author', requires: ['request'], produces: ['snapshot', 'report'], independent_from: [], on_reject: null },
    ], completion_stages: ['build'] }
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    await assert.rejects(worker.call(path, pack), /403/)
    const first = await hub.client.call(path, pack)
    const canonical = structuredClone(pack); canonical.stages[0].produces.sort()
    assert.equal(first.hash, createHash('sha256').update(`kode.workflow.graph.v1\n${JSON.stringify(canonical)}`).digest('hex'))
    assert.equal(first.home_hub, hub.node)
    assert.equal(first.eligible_for_execution, false)
    assert.deepEqual(await hub.client.call(path, canonical), first, 'set ordering does not create another revision or audit event')
    const changed = structuredClone(pack); changed.stages[0].role = 'another-role'
    await assert.rejects(hub.client.call(path, changed), /immutable/)
    const race = await Promise.allSettled([pack, changed].map(p => hub.client.call(path, { ...p, version: '2' })))
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1)
    assert.match(race.find(r => r.status === 'rejected').reason.message, /immutable/)
    const latest = race.find(r => r.status === 'fulfilled').value
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(`${path}/custom/versions/1`), first)
    assert.deepEqual(await hub.client.call(`${path}/custom/versions/2`), latest)
    assert.deepEqual(await hub.client.call(path, pack), first)
    const audit = await hub.client.call(`${path}/custom/events?after=0`)
    assert.deepEqual(audit.events.map(e => e.data.version), ['1', '2'])
    assert.deepEqual((await hub.client.call(`${path}/custom/events?after=${audit.events[0].seq}`)).events.map(e => e.data.version), ['2'])
    await assert.rejects(worker.call(`${path}/custom/versions/1`), /403/)
    await assert.rejects(worker.call(`${path}/custom/events`), /403/)
    await assert.rejects(hub.client.call(`${path}/custom/versions/missing`), /404/)
  } finally { await hub.close() }
})
