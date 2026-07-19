import { describe, expect, test, vi } from 'vitest'

import { ModelDiscoveryService, discoverClaudeModels, discoverCodeBuddyModels } from '../src/domain/model-discovery.js'

describe('backend model discovery', () => {
  test('CodeBuddy parses its stream-json get_available_models control response', async () => {
    const probe = vi.fn(async () => ({
      stdout: JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: 'models-1', response: { availableModels: [
          { modelId: 'claude-sonnet-5', name: 'Claude-Sonnet-5', description: 'Newest' },
          { modelId: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
        ] } },
      }),
      stderr: '', version: '2.124.0',
    }))
    await expect(discoverCodeBuddyModels('codebuddy', probe)).resolves.toMatchObject({
      backend: 'codebuddy', source: 'codebuddy-control', version: '2.124.0', custom_allowed: true,
      models: [
        { id: 'claude-sonnet-5', label: 'Claude-Sonnet-5', description: 'Newest' },
        { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
      ],
    })
  })

  test('Claude exposes stable aliases plus the configured model only when --model is supported', async () => {
    const probe = vi.fn(async (_command: string, args: readonly string[]) => ({
      stdout: args.includes('--version') ? '2.1.154 (Claude Code)' : '--print\n--model <model>\n',
      stderr: '',
    }))
    await expect(discoverClaudeModels('claude', probe, 'claude-enterprise-1')).resolves.toMatchObject({
      backend: 'claude', source: 'claude-cli-aliases', version: '2.1.154', custom_allowed: true,
      models: [
        { id: 'default', label: 'Default' },
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'opus', label: 'Opus' },
        { id: 'haiku', label: 'Haiku' },
        { id: 'claude-enterprise-1', label: 'claude-enterprise-1' },
      ],
    })
  })

  test('does not claim Claude model selection when the installed CLI lacks --model', async () => {
    const result = await discoverClaudeModels('claude-internal', async () => ({ stdout: '--print\n', stderr: '' }))
    expect(result.models).toEqual([])
    expect(result.custom_allowed).toBe(false)
    expect(result.warning).toContain('--model')
  })

  test('deduplicates concurrent discovery and caches successful results', async () => {
    const discover = vi.fn(async () => ({ backend: 'codex', source: 'codex-app-server' as const, version: '2', custom_allowed: true, models: [] }))
    const service = new ModelDiscoveryService({ codex: discover }, 60_000)
    const [first, second] = await Promise.all([service.discover('codex'), service.discover('codex')])
    expect(first).toEqual(second)
    expect(discover).toHaveBeenCalledTimes(1)
    await service.discover('codex')
    expect(discover).toHaveBeenCalledTimes(1)
    await service.discover('codex', true)
    expect(discover).toHaveBeenCalledTimes(2)
  })
})
