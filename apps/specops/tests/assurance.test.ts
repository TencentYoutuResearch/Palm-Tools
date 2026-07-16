import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { buildAssuranceState, evaluatePatchPolicy } from '../src/domain/assurance.js'
import type { RegistryState } from '../src/domain/commands.js'
import { gitWorkspace } from './helpers.js'

const cleanup: string[] = []
afterEach(async () => Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true }))))

describe('assurance control plane', () => {
  test('builds traceability, completion, impact, risk and health from the registry', async () => {
    const workspace = await gitWorkspace(); cleanup.push(workspace)
    await mkdir(path.join(workspace, 'src'), { recursive: true })
    await writeFile(path.join(workspace, 'src', 'auth.ts'), 'export const auth = true\n')
    const registry: RegistryState = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      documents: [
        { id: 'auth/policy', kind: 'spec', document_class: 'normative', spec_type: 'policy', title: 'Auth policy', status: 'active', path: '.specops/specs/auth.md', paths: ['src/auth.ts'], verifies: ['test'] },
        { id: 'auth/fix', kind: 'bug', document_class: 'work_item', work_type: 'bugfix', title: 'Fix auth', status: 'proposed', path: '.specops/changes/auth-fix', paths: ['src/auth.ts'], verifies: ['test'], targets: ['auth/policy'] },
      ],
    }
    const state = await buildAssuranceState(workspace, registry)
    expect(state.spec_graph.edges).toContainEqual({ from: 'auth/fix', to: 'auth/policy', relation: 'targets' })
    expect(state.product_graph.nodes[0]?.path).toBe('src/auth.ts')
    expect(state.completion_contracts[0]?.pass_condition.gate_status).toBe('failed')
    expect(state.impact.find((item) => item.subject === 'auth/policy')?.affected_specs).toEqual(['auth/fix'])
    expect(state.risk.find((item) => item.subject === 'auth/policy')?.score).toBeGreaterThan(0)
    expect(state.health.mapped_spec_rate).toBe(100)
  })

  test('blocks protected files and assertion weakening', () => {
    expect(evaluatePatchPolicy(['tests/acceptance/golden/auth.test.ts'], '- expect(auth).toBe(true)\n+ const auth = true')).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'protected_file_change', severity: 'error' }),
      expect.objectContaining({ code: 'test_assertion_reduction', severity: 'error' }),
    ]))
  })
})
