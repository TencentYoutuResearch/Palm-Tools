import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { compileAgentContext } from '../src/domain/agent-runtime.js'
import { productAdapterNodes, structuredSpecNodes } from '../src/domain/graph-adapters.js'
import { buildHarnessHealth, loadHarnessRules, saveHarnessRules } from '../src/domain/harness-evolution.js'
import type { RunRecord } from '../src/domain/run.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))
async function root(): Promise<string> { const value = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), 'specops-platform-'))); roots.push(value); return value }

describe('Harness platform services', () => {
  it('compiles role-scoped context without unrelated transcripts', async () => {
    const workspace = await root()
    await mkdir(path.join(workspace, '.specops', 'changes', 'demo'), { recursive: true })
    await writeFile(path.join(workspace, '.specops', 'changes', 'demo', 'proposal.md'), '# Proposal\n\nImplement demo.')
    const run = {
      run_id: 'run', worktree_path: workspace, change_id: 'demo', current_task: 0, iteration: 1, max_iterations: 8,
      tasks: [{ id: 'task-1', title: 'Build demo', prompt: 'Implement it', verify: [] }],
    } as unknown as RunRecord
    const context = await compileAgentContext(run, 'builder')
    expect(context.content).toContain('Role: builder')
    expect(context.content).toContain('proposal.md')
    expect(context.excluded).toContain('unrelated transcripts')
    expect(context.hash).toHaveLength(64)
  })

  it('extracts structured Spec and ProductGraph nodes through adapters', async () => {
    const workspace = await root()
    await mkdir(path.join(workspace, '.specops', 'specs'), { recursive: true })
    await mkdir(path.join(workspace, 'src'), { recursive: true })
    await writeFile(path.join(workspace, '.specops', 'specs', 'demo.md'), '# Screen\n\n- User clicks Submit\n- API returns success')
    await writeFile(path.join(workspace, 'src', 'page.ts'), `button.onclick = submit\nrouter.post('/api/demo', handler)\ntest('works', () => {})`)
    const spec = await structuredSpecNodes(workspace, [{ id: 'demo', kind: 'spec', title: 'Demo', status: 'active', path: '.specops/specs/demo.md', paths: [], verifies: [] }])
    const product = await productAdapterNodes(workspace, ['src/page.ts'])
    expect(spec.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(['action', 'api']))
    expect(product.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(['action', 'api', 'test']))
  })

  it('versions Harness rules and calculates empty-workspace health', async () => {
    const workspace = await root()
    const defaults = await loadHarnessRules(workspace)
    expect(defaults.rules.some((rule) => rule.mode === 'shadow')).toBe(true)
    await saveHarnessRules(workspace, { ...defaults, version: '1.1.0' })
    expect((await loadHarnessRules(workspace)).version).toBe('1.1.0')
    expect(await buildHarnessHealth(workspace)).toMatchObject({ total_runs: 0, failed_gate_rate: 0 })
  })
})
