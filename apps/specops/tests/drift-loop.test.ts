import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readLatestDriftReport, runDriftLoop } from '../src/domain/drift-loop.js'
import { gitWorkspace } from './helpers.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('Drift Loop', () => {
  it('persists a stable report and creates repair tasks', async () => {
    const root = await gitWorkspace(); roots.push(root)
    await writeFile(path.join(root, 'specops.toml'), ['schema_version = 1', '', '[project]', 'name = "demo"', ''].join('\n'))
    await mkdir(path.join(root, '.specops', 'specs'), { recursive: true })
    await writeFile(path.join(root, '.specops', 'specs', 'demo.md'), [
      '---', 'schema_version: 2', 'id: demo/capability', 'kind: spec', 'document_class: normative',
      'spec_type: capability', 'title: Demo', 'status: active', 'paths:', '  - src/missing.ts', 'verifies: []', '---', '', '# Demo', '', 'Must exist.',
    ].join('\n'))
    const first = await runDriftLoop(root, 'manual')
    expect(first.changed).toBe(true)
    expect(first.report.status).toBe('repair_required')
    expect(first.report.repair_tasks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'path', subject: 'demo/capability:src/missing.ts' })]))
    const second = await runDriftLoop(root, 'schedule')
    expect(second.changed).toBe(false)
    expect((await readLatestDriftReport(root))?.id).toBe(first.report.id)
  })
})
