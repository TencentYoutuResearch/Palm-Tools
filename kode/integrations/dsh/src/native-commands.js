/** Session-scoped commands use dsh's existing slash menu and command lifecycle. */
import { randomUUID } from 'node:crypto'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { profileRevision, profileRoute } from './agent-profiles.js'
import { resolveAdvertisedModel } from './model-alias.js'

// These commands own a CLI window, login, or a different conversation identity.
// ACP advertising a terminal command does not give this inline view that UI.
export const terminalOnlyCommands = new Set(['clear', 'new', 'fork', 'branch', 'background', 'bg', 'fork-bg', 'web', 'login', 'logout', 'exit', 'quit', 'keybindings', 'remote-control', 'gateway', 'multitask'])
const shared = [
  { name: 'help', description: '查看当前 Agent 可用的命令' },
  { name: 'status', description: '查看当前 Agent、模型、工作区和权限' },
  { name: 'model', description: '查看或切换当前会话的模型', input: { hint: '模型名称或标识；留空查看列表' } },
  { name: 'mode', description: '查看或选择 Agent 公布的运行模式', input: { hint: '模式标识；留空查看列表' } },
  { name: 'shell', description: '在当前工作区直接执行终端命令，也可输入 !命令', input: { hint: '终端命令' } },
  { name: 'rename', description: '重命名当前会话', input: { hint: '会话名称' } },
  { name: 'diff', description: '查看当前工作区的 Git 差异' },
  { name: 'stop', description: '停止当前会话正在执行的任务' },
  { name: 'new', description: '在当前工作区使用相同 Agent 新建会话，保留当前会话' },
]
export function commandDescriptors(capabilities) {
  const names = new Set(shared.map(row => row.name)), rows = [...shared]
  for (const command of capabilities.commands ?? []) {
    if (terminalOnlyCommands.has(command.name)) continue
    // The pinned dsh registry accepts lowercase ASCII names. Namespaced CLI
    // commands retain their original spelling when dispatched and in /help.
    const name = command.name.replaceAll(':', '-')
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || names.has(name)) continue
    names.add(name)
    rows.push({ name, nativeName: command.name, kind: command.kind ?? 'command', description: `${name === command.name ? '' : `/${command.name} · `}${command.description ?? ''}`, ...(command.input ? { input: { hint: command.input.hint ?? '参数', ...(command.kind === 'skill' ? { attachments: true } : {}) } } : {}) })
  }
  return rows
}
export function selectedModel(agent) {
  const state = agent.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
  return state?.pending ?? state?.next ?? state?.lastUsed ?? agent.options
}
export function humanInput(message) {
  if (!['user', 'human'].includes(message.source?.kind) || message.content.some(part => part.type !== 'text')) return undefined
  return message.content.map(part => part.text).join('\n').trim()
}
export function enqueueCommand(agent, line, attachments = []) {
  agent.followup({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: line }, ...attachments] })
}
export async function mountNativeCommands(agent, service, profile) {
  if (!agent.ctx.inject || !profile || profile.type === 'dsh') return
  const key = profileRevision(profile), previous = service.commandOwners.get(agent.id)
  if (previous?.agent === agent && previous.key === key) return previous.ready.promise
  const owner = { agent, key, ready: Promise.withResolvers() }
  owner.dispose = async () => { await owner.ready.promise; await owner.fork?.dispose() }
  service.commandOwners.set(agent.id, owner)
  await previous?.dispose()
  if (service.commandOwners.get(agent.id) !== owner) { owner.ready.resolve(); return }
  try { owner.fork = agent.ctx.inject(['commands'], async ctx => {
    let capabilities = { commands: [], modes: [] }
    let descriptors, releases = []
    const update = commands => {
      const advertised = [...commands]
      if (['codex', 'claude'].includes(profile.type) || profile.protocol === 'codex') advertised.push({ name: 'resume', description: '恢复原生历史会话' })
      if (profile.type === 'claude' && !advertised.some(row => row.name === 'autocompact')) advertised.push({ name: 'autocompact', description: '设置当前 Claude 会话的原生自动压缩', input: { hint: 'on | off | status' }, localAction: 'claude-autocompact' })
      descriptors = commandDescriptors({ ...capabilities, commands: advertised })
      for (const release of releases.splice(0)) release()
      for (const descriptor of descriptors) releases.push(ctx.commands.register({
      definitionId: `@kode/dsh/native/${descriptor.kind === 'skill' ? 'skill/' : ''}${descriptor.name}`, ...descriptor,
      handler: async ({ agent: receiving, rawInput, signal, attachments = [] }) => {
        if (receiving !== agent) throw new Error('Command belongs to another conversation')
        signal.throwIfAborted()
        const input = rawInput.trim(), selection = selectedModel(agent)
        if (descriptor.name === 'help') return { kind: 'success', text: descriptors.map(row => `/${row.nativeName ?? row.name} — ${row.description}`).join('\n') }
        if (descriptor.name === 'status') return { kind: 'success', text: `${profile.name}\n模型：${selection.model}\n工作区：${agent.session.header.cwd}\n权限：${agent.ctx.get('sandboxPolicy')?.resolve({ session: agent.session })?.mode ?? 'read-only'}` }
        if (descriptor.name === 'rename') {
          if (!input || input.length > 160) throw new Error('请输入 1–160 字符的会话名称。')
          await service.adapter.renameSession?.(agent, input, signal)
          await agent.ctx.get('sessionController').rename({ sessionId: agent.id, title: input })
          await service.adapter.onThread?.(agent)
          return { kind: 'success', text: `会话已重命名为「${input}」。` }
        }
        if (descriptor.name === 'stop') { agent.ctx.get('sessionController').cancel({ sessionId: agent.id }); return { kind: 'success', text: '已停止当前任务。' } }
        if (descriptor.name === 'resume') return { kind: 'error', text: '请在 dsh 的 /resume 菜单中选择要恢复的原生会话。' }
        if (descriptor.name === 'new') return { kind: 'error', text: '/new 需要前端的新建会话入口。' }
        if (descriptor.name === 'diff') { if (input) throw new Error('/diff 不接受参数。'); enqueueCommand(agent, '!git diff --no-ext-diff && git diff --cached --no-ext-diff'); await agent.ctx.sessions.flush(agent.session); return { kind: 'success' } }
        if (descriptor.name === 'autocompact' && profile.type === 'claude' && !commands.some(row => row.name === 'autocompact')) {
          const current = agent.session.snapshotEvents().findLast(event => event.type === 'plugin:kode/autocompact')?.data.enabled
          if (!input || input === 'status') return { kind: 'success', text: `自动压缩：${current == null ? '跟随 Claude 配置' : current ? '开启' : '关闭'}。使用 /autocompact on 或 off 设置当前会话。` }
          if (!['on', 'off'].includes(input)) throw new Error('使用 /autocompact on、off 或 status。')
          appendPluginRecord(agent.session, 'plugin:kode/autocompact', { enabled: input === 'on' }); await agent.ctx.sessions.flush(agent.session)
          return { kind: 'success', text: `当前会话后续请求${input === 'on' ? '启用' : '关闭'} Claude 原生自动压缩。` }
        }
        if (descriptor.name === 'plan' && profile.type === 'codex') {
          if (input && !['on', 'off', 'status'].includes(input)) throw new Error('使用 /plan on、off 或 status。')
          const current = agent.session.snapshotEvents().findLast(event => event.type === 'plugin:kode/collaboration-mode')?.data.enabled ?? false
          if (input === 'status') return { kind: 'success', text: `Codex 计划模式：${current ? '开启' : '关闭'}。` }
          const enabled = input ? input === 'on' : !current
          appendPluginRecord(agent.session, 'plugin:kode/collaboration-mode', { enabled }); await agent.ctx.sessions.flush(agent.session)
          return { kind: 'success', text: `后续请求${enabled ? '使用' : '退出'} Codex 原生计划模式。` }
        }
        if (descriptor.name === 'model') {
          const models = await service.adapter.listModels(profileRoute(profile.id), profile)
          if (!input) return { kind: 'success', text: models.map(row => `${row.id === selection.model ? '✓ ' : ''}${row.name} (${row.id})`).join('\n') }
          const model = resolveAdvertisedModel(models, input)
          agent.selectModel({ ...selection, model }); await agent.ctx.sessions.flush(agent.session)
          return { kind: 'success', text: `当前会话的后续请求使用 ${model}。` }
        }
        if (descriptor.name === 'mode') {
          if (!input) return { kind: 'success', text: capabilities.modes.length ? capabilities.modes.map(mode => `${mode.id} — ${mode.name}`).join('\n') : '此 Agent 未公布独立运行模式，请使用会话的权限设置。' }
          if (!capabilities.modes.some(mode => mode.id === input)) throw new Error('请选择此 Agent 公布的模式。')
          const policy = agent.ctx.get('sandboxPolicy')?.resolve({ session: agent.session }) ?? { mode: 'read-only' }
          if (!modeAllowed(input, policy.mode)) throw new Error('该模式超出当前会话权限，请先在权限菜单调整访问范围。')
          appendPluginRecord(agent.session, 'plugin:kode/native-mode', { mode: input, policy: policy.mode })
          await agent.ctx.sessions.flush(agent.session)
          return { kind: 'success', text: `后续请求使用 ${input} 模式。` }
        }
        if (descriptor.name === 'shell' && !input) throw new Error('请输入要执行的终端命令。')
        enqueueCommand(agent, descriptor.name === 'shell' ? `!${rawInput.trimStart()}` : `${descriptor.kind === 'skill' && (profile.type === 'codex' || profile.protocol === 'codex') ? '$' : '/'}${descriptor.nativeName ?? descriptor.name}${input ? ` ${input}` : ''}`, attachments)
        await agent.ctx.sessions.flush(agent.session)
        return { kind: 'success' }
      },
      }))
    }
    owner.update = update
    update([])
    try { capabilities = await service.adapter.capabilities(profileRoute(profile.id), profile, agent.session.header.cwd); update(capabilities.commands) }
    catch (error) { ctx.logger.warn('Native command discovery failed: %s', error.message) }
    finally { owner.ready.resolve() }
  }) } catch(error) { owner.ready.resolve(); throw error }
  owner.dispose = () => owner.fork.dispose()
  return owner.ready.promise
}
export function modeAllowed(mode, policy) {
  if (policy === 'danger-full-access') return true
  if (['bypassPermissions', 'fullAccess', 'yolo', 'auto'].includes(mode)) return false
  return policy !== 'read-only' || ['plan', 'ask', 'read-only'].includes(mode)
}
