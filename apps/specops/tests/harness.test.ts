import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  builtinBackendProfile,
  loadPluginManifests,
  parseWorkflowStages,
  resolveAgentBackendProfile,
  validatePluginManifest,
  workflowKindForDocumentKind,
} from '../src/domain/harness.js'
import { gitWorkspace } from './helpers.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })))
})

describe('Harness plugin and workflow contracts', () => {
  test('validates a declaration-only plugin manifest', () => {
    expect(validatePluginManifest({
      schema_version: 1,
      id: 'community.flutter-verifier',
      version: '1.2.0',
      kind: 'verifier',
      capabilities: ['emulator.launch', 'ui.interact', 'screenshot.capture'],
    })).toMatchObject({
      id: 'community.flutter-verifier',
      kind: 'verifier',
      capabilities: ['emulator.launch', 'ui.interact', 'screenshot.capture'],
    })
  })

  test('rejects malformed manifests and workflow stages', () => {
    expect(() => validatePluginManifest({
      schema_version: 1,
      id: '../escape',
      version: 'latest',
      kind: 'backend',
      capabilities: [],
    })).toThrow('plugin id has an invalid format')
    expect(() => parseWorkflowStages(['plan', 'swarm'], 'workflow.feature.stages')).toThrow('unknown stage: swarm')
    expect(() => parseWorkflowStages(['plan', 'plan'], 'workflow.feature.stages')).toThrow('duplicate stages')
  })

  test('uses conservative capabilities for backends without structured semantic events', () => {
    expect(builtinBackendProfile('codebuddy').capabilities).toContain('conversation.ask')
    expect(builtinBackendProfile('codebuddy').capabilities).toContain('conversation.plan')
    expect(builtinBackendProfile('codex').capabilities).not.toContain('conversation.ask')
    expect(workflowKindForDocumentKind('bug')).toBe('bug')
    expect(workflowKindForDocumentKind('change')).toBe('feature')
  })

  test('loads user plugin declarations and validates backend capability claims', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    const directory = path.join(workspace, '.specops', 'plugins')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'custom-cli.json'), `${JSON.stringify({
      schema_version: 1,
      id: 'company.custom-cli',
      version: '1.0.0',
      kind: 'backend',
      capabilities: ['session.create', 'conversation.ask'],
    })}\n`)

    expect(await loadPluginManifests(workspace)).toHaveLength(1)
    await expect(resolveAgentBackendProfile(workspace, 'custom', {
      plugin: 'company.custom-cli',
      capabilities: ['session.create', 'conversation.ask'],
    })).resolves.toMatchObject({ plugin: 'company.custom-cli' })
    await expect(resolveAgentBackendProfile(workspace, 'custom', {
      plugin: 'company.custom-cli',
      capabilities: ['conversation.plan'],
    })).rejects.toThrow('capabilities not provided')
  })
})
