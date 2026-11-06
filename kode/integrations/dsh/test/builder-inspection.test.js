import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { inspectBuilderWorkspace, registerBuilderInspection } from '../src/builder-inspection.js'

test('Builder inspects only explicitly selected registered project documents without executing them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-builder-inspection-'))
  try {
    const project = join(root, 'project'); await mkdir(project)
    const registry = { list: () => [{ id: 'selected', path: project }] }
    const content = '# Project\nRun a build only after approval.\n'
    await writeFile(join(project, 'README.md'), content)
    await writeFile(join(project, 'package.json'), '{"scripts":{"test":"must-not-execute"}}')
    const result = await inspectBuilderWorkspace(registry, { workspace_id: 'selected', paths: ['README.md', 'package.json', 'Cargo.toml'] })
    assert.equal(result.eligible_for_execution, false)
    assert.deepEqual(result.facts.map(f => f.status), ['observed', 'observed', 'missing'])
    assert.equal(result.facts[0].content, content)
    assert.equal(result.facts[0].sha256, createHash('sha256').update(content).digest('hex'))
    assert.equal(result.facts[0].trust, 'untrusted_project_data')
    assert.ok(result.facts[0].observed_at > 0)
    for (const paths of [['../README.md'], ['.env'], ['/tmp/README.md'], ['README.md', 'README.md'], []]) {
      await assert.rejects(inspectBuilderWorkspace(registry, { workspace_id: 'selected', paths }), /invalid inspection/)
    }
    await assert.rejects(inspectBuilderWorkspace(registry, { workspace_id: 'other', paths: ['README.md'] }), /unavailable/)
    await assert.rejects(inspectBuilderWorkspace(registry, { workspace_id: 'selected', paths: ['README.md'], root }), /invalid inspection/)
    const outside = join(root, 'unselected'); await writeFile(outside, 'fixture-only-unselected-content')
    await symlink(outside, join(project, 'AGENTS.md'))
    await link(outside, join(project, 'CLAUDE.md'))
    await writeFile(join(project, 'Makefile'), 'x'.repeat(65537))
    await writeFile(join(project, 'pyproject.toml'), Buffer.from([0xff, 0x00]))
    const denied = await inspectBuilderWorkspace(registry, { workspace_id: 'selected', paths: ['AGENTS.md', 'CLAUDE.md', 'Makefile', 'pyproject.toml'] })
    assert.deepEqual(denied.facts.map(f => f.status), ['symlink_denied', 'unsupported_file', 'too_large', 'not_text'])
    assert.doesNotMatch(JSON.stringify(denied), /fixture-only-unselected-content/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Builder inspection route checks owner and explicit POST before accessing the registry', async () => {
  let route, kind = 'worker', status, body, reads = 0
  const ctx = { webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind } } }) }, get: () => { reads++; throw new Error('private filesystem detail') } }
  registerBuilderInspection(ctx)
  const res = { writeHead: value => { status = value }, end: value => { body = JSON.parse(value) } }
  const req = { method: 'POST', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield JSON.stringify({ workspace_id: 'selected', paths: ['README.md'] }) } }
  await route.handler(req, res); assert.equal(status, 403); assert.equal(reads, 0)
  kind = 'owner'
  await route.handler({ ...req, method: 'GET' }, res); assert.equal(status, 405); assert.equal(reads, 0)
  await route.handler(req, res); assert.equal(status, 400); assert.equal(reads, 1)
  assert.doesNotMatch(JSON.stringify(body), /private filesystem/)
})
