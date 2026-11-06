/** Real native directory reader, selected workspace and durable Home observations. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectBuilderWorkspace } from '../src/builder-inspection.js'
import { prepareBuilderDraftInspection } from '../src/builder-draft-inspection.js'
import { isolatedHub } from './support/isolated-hub.js'

test('selected CI and skill observations survive lost replies and restart with immutable earlier inventories', {
  skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000,
}, async () => {
  const hub = await isolatedHub('project-configuration')
  const root = await mkdtemp(join(tmpdir(), 'kode-project-config-'))
  try {
    await mkdir(join(root, '.github/workflows'), { recursive: true })
    await mkdir(join(root, '.agents/skills/check'), { recursive: true })
    await mkdir(join(root, 'skills/plan'), { recursive: true })
    await mkdir(join(root, '.codex-plugin'), { recursive: true })
    await writeFile(join(root, '.github/workflows/check.yml'), 'name: check\n# never execute this fixture\n')
    await writeFile(join(root, '.agents/skills/check/SKILL.md'), '# Check\nProject instructions stay untrusted.\n')
    await writeFile(join(root, 'skills/plan/SKILL.md'), '# Plan\nProject plugin skill.\n')
    await writeFile(join(root, '.codex-plugin/plugin.json'), '{"name":"project-fixture","version":"1"}')
    const registry = { list: () => [{ id: 'selected', path: root }] }
    const workspace = { host_id: hub.node, workspace_id: 'selected', root_ref: root }
    const paths = ['.github/workflows', '.gitlab-ci.yml', 'skills', '.agents/skills', '.codex/skills', '.claude/skills', '.codex-plugin/plugin.json']
    const direct = await inspectBuilderWorkspace(registry, { workspace_id: 'selected', paths })
    assert.equal(direct.schema_version, 2)
    assert.equal(direct.facts.find(fact => fact.path === '.agents/skills/check/SKILL.md').trust, 'untrusted_project_data')
    assert.ok(direct.facts.some(fact => fact.status === 'directory_scanned'))
    assert.equal(direct.facts.find(fact => fact.path === 'skills/plan/SKILL.md').content, '# Plan\nProject plugin skill.\n')
    assert.equal(direct.pending_checks.some(value => value.includes('not_inspected')), false)
    const base = '/api/v1/messaging/superagents/drafts'
    const draft = await hub.client.call(base, { id: 'draft', request_id: 'create', expected_revision: 0, revoked: false,
      interview: { purpose: 'Configure selected project', workspace_refs: [workspace], answers: {}, questions: [], proposed_team: null } })
    const command = { draft_id: draft.id, request_id: 'observe', expected_revision: draft.revision, workspace_id: 'selected', paths }
    const prepared = await prepareBuilderDraftInspection(hub.client, registry, command)
    const saved = await hub.client.call(base, prepared.command)
    assert.deepEqual(saved.interview.inspections[0].pending_checks, direct.pending_checks)
    assert.equal(saved.interview.inspections[0].facts.find(fact => fact.path === '.github/workflows').status, 'directory_scanned')
    await rename(join(root, '.github/workflows/check.yml'), join(root, '.github/workflows/new.yml'))
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(base, prepared.command), saved)
    const refreshed = await prepareBuilderDraftInspection(hub.client, registry, { ...command, request_id: 'refresh', expected_revision: 2, paths: ['.github/workflows'] })
    const facts = refreshed.command.interview.inspections[0].facts
    assert.equal(facts.some(fact => fact.path === '.github/workflows/check.yml'), false)
    assert.ok(facts.some(fact => fact.path === '.github/workflows/new.yml'))
    assert.ok(facts.some(fact => fact.path === '.agents/skills/check/SKILL.md'))
    await hub.client.call(base, refreshed.command)
    await rm(join(root, '.github/workflows'), { recursive: true })
    const removed = await prepareBuilderDraftInspection(hub.client, registry, { ...command, request_id: 'missing-directory', expected_revision: 3, paths: ['.github/workflows'] })
    assert.equal(removed.command.interview.inspections[0].facts.some(fact => fact.path.startsWith('.github/workflows/')), false)
    assert.equal(removed.command.interview.inspections[0].facts.find(fact => fact.path === '.github/workflows').status, 'missing')
    await hub.client.call(base, removed.command)
    assert.deepEqual((await hub.client.call(`${base}/draft/commands/observe`)).receipt, saved)
    assert.deepEqual((await hub.client.call('/api/v1/messaging/teams')).items, [])
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }) }
})

test('native project reader refuses linked ancestors and cannot select credential locations', {
  skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-project-boundary-'))
  try {
    const project = join(root, 'selected'), outside = join(root, 'outside')
    await mkdir(project); await mkdir(outside)
    await writeFile(join(outside, 'SKILL.md'), 'outside-owned-fixture-marker')
    await symlink(outside, join(project, '.agents'))
    const registry = { list: () => [{ id: 'selected', path: project }] }
    const result = await inspectBuilderWorkspace(registry, { workspace_id: 'selected', paths: ['.agents/skills'] })
    assert.equal(result.facts[0].status, 'symlink_denied')
    assert.doesNotMatch(JSON.stringify(result), /outside-owned-fixture-marker/)
    for (const paths of [['.env'], ['.ssh'], ['.agents/skills/../../outside'], ['.github/workflows/private-key.yml']]) {
      await assert.rejects(inspectBuilderWorkspace(registry, { workspace_id: 'selected', paths }), /invalid inspection/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
