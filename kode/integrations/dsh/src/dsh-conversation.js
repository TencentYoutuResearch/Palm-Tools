/** Optional dsh Agent, backed by the official ACP application in its own process. */
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { load, dump } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

export const name = 'kode-dsh-conversation'
export const inject = ['kodeAgents', 'agentPresets', 'loader', 'llm', 'sessionProjections', 'agentDefaultModel']
export async function apply(ctx, config = {}) {
  const resolve = createRequire(import.meta.url).resolve
  const root = await mkdtemp(join(tmpdir(), 'kode-harness-acp-'))
  ctx.effect(() => () => rm(root, { recursive: true, force: true }), 'kode.dsh-acp-config')
  const settingsId = await ctx.loader.create({ name: '@deepseek-ai/dsh-client-ui-settings-models' })
  ctx.effect(() => async () => { const fiber = ctx.loader.resolve(settingsId).fiber; ctx.loader.remove(settingsId); await fiber?.dispose() }, 'kode.dsh-model-settings')
  const presets = []
  // These are selection declarations. The real compositions run in the ACP
  // process, so none of their prompt/tool plugins mount into external Agents.
  for (const id of ['standard', 'minimal', 'ptc', 'cordis']) {
    const patch = load(await readFile(resolve(`@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`), 'utf8'), { schema: entryListSchema })
    const definition = patch.flatMap(row => row.insert ?? []).find(row => row.config?.id === id)?.config
    if (definition) presets.push(await ctx.agentPresets.register({ id, name: definition.name, order: definition.order, plugins: [] }))
  }
  let counter = 0
  const unregister = ctx.kodeAgents.registerRuntime('dsh', {
    name: 'DeepSeek Harness', executable: config.executable ?? process.execPath, uiChannel: 'native',
    async nativeProfile(profile, agent) {
      const selection = ctx.agentDefaultModel.currentSelection()
      const providers = ctx.llm.listProviders().filter(provider => !provider.id.startsWith('kode-agent-'))
      const provider = providers.find(provider => provider.id === selection.provider) ?? providers[0]
      if (!provider) throw new Error('请先在 Agent 设置中配置 dsh 模型提供商。')
      const models = await ctx.llm.listModels(provider.id)
      const model = models.find(model => model.id === selection.model) ?? models[0]
      if (!model) throw new Error('dsh 模型提供商没有可用模型。')
      const preset = agent && ctx.sessionProjections.stateOf(agent.session, 'agentPreset')
      const policy = agent?.ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
      const approval = agent?.ctx.get('approval')?.effectivePolicy?.(agent.session)
      const patch = []
      for (const entry of ctx.loader.entries()) if (entry.options.name === '@deepseek-ai/dsh-llm-pi-ai' && entry.options.config) patch.push({ id: entry.options.id, config: entry.options.config })
      patch.push({ id: 'acp', config: { provider: provider.id, model: model.id } },
        { id: 'agent-default-model', config: { provider: provider.id, model: model.id } },
        { id: 'agent-preset-registry', config: { default: preset && preset !== 'kode-native' ? preset : 'standard' } },
        { id: 'sandbox-policy', config: { mode: policy?.mode ?? 'read-only', workspaceRoot: agent?.session.header.cwd ?? process.cwd() } },
        { id: 'approval', config: { policy: approval ?? 'ask' } })
      const path = join(root, `${++counter}.yml`)
      await writeFile(path, dump(patch, { schema: entryListSchema }), { mode: 0o600 })
      return { ...profile, type: 'custom', protocol: 'acp', executable: config.executable ?? process.execPath,
        args: [...(config.args ?? [process.argv[1]]), '--profile', config.profile ?? 'acp', '--patch', path],
        env: { ...profile.env }, startupTimeoutMs: 60000, policyManagedByHost: true, fixedPolicy: { mode: policy?.mode ?? 'read-only', approval: approval ?? 'ask' } }
    },
  })
  ctx.effect(() => async () => {
    await unregister()
    await ctx.kodeAgents.adapter.closeType('dsh')
    for (const dispose of presets.reverse()) await dispose()
  }, 'kode.dsh-conversation')
}
