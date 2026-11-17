/** Disposable Team walkthrough data. No runtime, provider, execution or daily state. */
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalTeamProposal } from './team-role-prompts.js'

const PREFIX = '/api/v1/messaging/'
const handles = new WeakSet()
const denied = () => Object.assign(Error('演示模式不允许执行、模型调用或外部发送'), { status: 403, code: 'DEMO_OPERATION_BLOCKED' })
const definitions = [
  ['product', '产品体验团队', [['design', '体验设计'], ['review', '交互走查']], '梳理频道导航、设置编辑与空状态。'],
  ['quality', '质量验证团队', [['test', '测试设计'], ['evidence', '证据检查']], '设计回归检查清单，区分已验证与未验证。'],
  ['delivery', '交付协作团队', [['plan', '任务规划'], ['docs', '文档整理']], '演示角色职责与团队设置，不执行交付。'],
]

export function demoTeamCommands(scope) {
  return definitions.map(([id, name, roles, purpose]) => ({
    id: `demo-${id}`, request_id: `demo-create-${id}`, expected_revision: 0,
    spec: canonicalTeamProposal({ name: `【演示】${name}`, purpose: `【演示数据】${purpose} 无模型、无执行权限。`, kind: 'coordinator',
      workspace_refs: [{ host_id: scope.host_id, workspace_id: scope.workspace_id, root_ref: scope.root_ref }],
      execution_targets: [], coordinator_targets: [], workflow_pack_refs: [],
      coordinator_prompt: '【演示】协调角色仅供配置走查，不代表已运行或已完成任何任务。',
      workers: roles.map(([worker, role]) => ({ id: worker, role, responsibilities: [purpose], role_prompt: `【演示】${role}的可编辑职责说明。`, allowed_target_ids: [], required_capabilities: [], workspace_refs: [], max_parallel: 1 })),
      grant_id: null, budget_policy_id: null, scheduling_policy_id: null,
      limits: { max_active_assignments: 1, max_active_runs: 1 }, proactive_mode: 'off',
    }),
  }))
}

/** Preparation only. Caller owns startup/shutdown and removes root after shutdown.
 * Use these paths for every DSH state/prefs file too; never inherit daily config.
 */
export async function prepareTeamDemo() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-team-demo-')))
  const node = `demo-${randomUUID()}`, workspacePath = join(root, 'workspace')
  await mkdir(workspacePath)
  const configPath = join(root, 'hub.json'), tokenFile = join(root, 'admin.token')
  await writeFile(configPath, JSON.stringify({ node_id: node, database: join(root, 'ledger.sqlite'), peers: [] }), { mode: 0o600 })
  await writeFile(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 })
  const guiStatePath = join(root, 'gui-state.json')
  await writeFile(guiStatePath, JSON.stringify({ config_path: join(root, 'fixture-config.toml') }), { mode: 0o600 })
  const environment = Object.freeze({ KODE_GUI_STATE_PATH: guiStatePath, KODE_CLOUD_SYNC_CONFIG: join(root, 'cloud-sync.json'), KODE_MEMORY_ROOT: join(root, 'memory') })
  const handle = Object.freeze({ root, node, workspacePath, configPath, tokenFile, environment })
  handles.add(handle)
  return handle
}

function safeSpec(spec) {
  return spec && spec.name?.startsWith('【演示】') && spec.proactive_mode === 'off'
    && ['execution_targets', 'coordinator_targets', 'workflow_pack_refs'].every(k => Array.isArray(spec[k]) && spec[k].length === 0)
    && (!spec.delivery_bindings || spec.delivery_bindings.length === 0)
    && ['grant_id', 'budget_policy_id', 'scheduling_policy_id'].every(k => spec[k] == null)
    && !spec.coordinator_startup && Array.isArray(spec.workers)
    && spec.workers.every(w => Array.isArray(w.allowed_target_ids) && !w.allowed_target_ids.length)
}

/** Defense in depth for an isolated demo instance, not a mixed-namespace proxy.
 * Register ONLY browsing/settings/message routes. Never install agent runtime,
 * provider plugins, native session creation or unwrapped backend routes.
 */
export function guardTeamDemoClient(client, { scope, teamIds, surfaceIds }) {
  const teams = new Set(teamIds), surfaces = new Set(surfaceIds)
  const sameScope = value => ['home_hub', 'host_id', 'workspace_id', 'root_ref'].every(k => value?.[k] === scope[k])
  return Object.freeze({ call: async (path, body) => {
    if (typeof path !== 'string' || !path.startsWith(PREFIX) || /[%#\\]/.test(path)) throw denied()
    const [route, query = ''] = path.slice(PREFIX.length).split('?')
    let allowed = false
    if (body === undefined) {
      const parts = route.split('/')
      allowed = route === 'node' || route === 'teams' || route === 'workbench/workspaces'
        || (parts[0] === 'teams' && teams.has(parts[1]) && (parts.length === 2 || (parts.length === 3 && ['activation', 'work-runs', 'events'].includes(parts[2]))))
        || (route === 'collaboration/surfaces' && sameScope(Object.fromEntries(new URLSearchParams(query))))
        || (parts[0] === 'collaboration' && parts[1] === 'surfaces' && surfaces.has(parts[2]) && parts.length === 4 && ['messages', 'threads', 'tasks'].includes(parts[3]))
    } else if (!query) {
      const parts = route.split('/')
      allowed = route === 'teams' && teams.has(body.id) && safeSpec(body.spec) && body.spec.workspace_refs?.length === 1 && ['host_id', 'workspace_id', 'root_ref'].every(k => body.spec.workspace_refs[0][k] === scope[k])
      if (parts[0] === 'collaboration' && parts[1] === 'surfaces' && surfaces.has(parts[2])) {
        if (parts.length === 3) allowed = sameScope(body.scope) && body.team_ids?.length > 0 && body.team_ids.every(id => teams.has(id))
        if (parts.length === 4 && parts[3] === 'messages') allowed = Array.isArray(body.mentions) && body.mentions.length === 0
      }
    }
    if (!allowed) throw denied()
    return client.call(path, body)
  } })
}

/** Accepts only a fresh handle allocated here and the matching loopback Hub.
 * Samples are owner-authored fixture text, never fabricated model results.
 */
export async function seedTeamDemo(handle, client) {
  if (!handles.has(handle)) throw Error('Fresh disposable demo handle required')
  const url = new URL(client.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw denied()
  const call = (path, body) => client.call(PREFIX + path, body)
  if ((await call('node')).node_id !== handle.node) throw Error('Demo Hub identity mismatch; nothing seeded')
  const directory = await call('teams?limit=1'), catalog = await call('workbench/workspaces')
  if (!Array.isArray(directory.items) || !Array.isArray(catalog.workspaces) || directory.items.length || catalog.workspaces.length) throw Error('Demo Hub must be empty')
  // Consume once before mutations; failed/uncertain seeds require a new namespace.
  handles.delete(handle)
  await call('workbench/workspaces', { action: 'create', path: handle.workspacePath, title: '【演示】团队走查' })
  const workspace = (await call('workbench/workspaces')).workspaces.find(w => w.path === handle.workspacePath)
  if (!workspace) throw Error('Demo workspace registration missing')
  const scope = { home_hub: handle.node, host_id: handle.node, workspace_id: workspace.id, root_ref: handle.workspacePath }
  const commands = demoTeamCommands(scope), teams = []
  for (const command of commands) teams.push(await call('teams', command))
  const surfaceIds = ['demo-planning', 'demo-quality', 'demo-private']
  for (const [i, id] of surfaceIds.entries()) {
    await call(`collaboration/surfaces/${id}`, { request_id: `create-${id}`, expected_revision: 0, scope, kind: i === 2 ? 'dm' : 'channel', title: ['【演示】产品讨论', '【演示】质量走查', '【演示】产品私信'][i], team_ids: [teams[i === 2 ? 0 : i].id], enabled: true })
    await call(`collaboration/surfaces/${id}/messages`, { request_id: `sample-${id}`, expected_revision: 1, content: '【演示示例消息，非模型输出】这里可浏览讨论和编辑团队职责；没有启动模型、任务执行或外部发送。', mentions: [] })
  }
  return { scope, teams, surfaceIds, backendClient: guardTeamDemoClient(client, { scope, teamIds: teams.map(t => t.id), surfaceIds }) }
}

/** Additive same-Hub walkthrough. Caller supplies one dedicated existing directory
 * and keeps seedKey/path stable on reruns. Never pass the real source workspace.
 * Does not replace the Host client or globally restrict the user's real data.
 * Unknown writes are read back once, never blindly retried with new identities.
 */
export async function seedTeamDemoScope(client, { expectedNodeId, workspacePath, seedKey = 'team-walkthrough-v1' }) {
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(seedKey) || typeof workspacePath !== 'string' || !workspacePath.startsWith('/') || workspacePath.includes('\0')) throw Error('Dedicated demo workspace and stable seed key required')
  // Match the Hub's canonical filesystem identity (notably /var -> /private/var on macOS).
  try { workspacePath = await realpath(workspacePath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const origin = new URL(client.url)
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) throw denied()
  const call = (path, body) => client.call(PREFIX + path, body)
  const node = await call('node')
  if (!expectedNodeId || node.node_id !== expectedNodeId) throw Error('Demo Hub identity mismatch; nothing seeded')
  const namespace = 'demo-' + createHash('sha256').update(JSON.stringify([expectedNodeId, workspacePath, seedKey])).digest('hex').slice(0, 20)
  const title = `【演示】团队走查 · ${namespace.slice(5, 13)}`
  const recover = async (write, read) => { try { return await write() } catch (error) { const found = await read(); if (found) return found; throw error } }
  const findWorkspace = async () => {
    const catalog = await call('workbench/workspaces')
    if (!Array.isArray(catalog.workspaces)) throw Error('Workspace directory unavailable')
    const matches = catalog.workspaces.filter(w => w.path === workspacePath)
    if (matches.length > 1 || matches.some(w => w.title !== title)) throw Error('Workspace path already belongs to nonmatching data; nothing replaced')
    return matches[0]
  }
  let workspace = await findWorkspace()
  if (!workspace) {
    await recover(() => call('workbench/workspaces', { action: 'create', path: workspacePath, title }), findWorkspace)
    workspace = await findWorkspace()
  }
  if (!workspace) throw Error('Demo workspace creation unconfirmed; inspect before retry')
  const scope = { home_hub: expectedNodeId, host_id: expectedNodeId, workspace_id: workspace.id, root_ref: workspacePath }
  const equalScope = value => Object.keys(scope).every(k => value?.[k] === scope[k])
  const teams = []
  for (const command of demoTeamCommands(scope)) {
    command.id = `${namespace}-${command.id.slice(5)}`
    command.request_id = `${command.id}-create-v1`
    const read = async () => {
      let team
      try { team = await call(`teams/${command.id}`) } catch (error) { if (error.status === 404) return null; throw error }
      if (team.id !== command.id || team.home_hub !== expectedNodeId || !team.spec?.name?.startsWith('【演示】')
        || !safeSpec(team.spec) || team.spec.workspace_refs?.length !== 1
        || !['host_id','workspace_id','root_ref'].every(k => team.spec.workspace_refs[0][k] === scope[k])
        || team.active_revision != null || team.eligible_for_execution === true) throw Error('Existing demo identity changed or became executable; no overwrite')
      let activation
      try { activation = await call(`teams/${command.id}/activation`) } catch (error) { if (error.status !== 404) throw error }
      if (activation && activation.active !== false) throw Error('Demo activation state is not inactive; no write allowed')
      return team
    }
    const team = await read() ?? await recover(() => call('teams', command), read)
    teams.push(team)
  }
  const surfaceIds = [`${namespace}-planning`, `${namespace}-quality`, `${namespace}-private`]
  const listSurfaces = async () => {
    const page = await call('collaboration/surfaces?' + new URLSearchParams(scope))
    if (!Array.isArray(page.items)) throw Error('Demo surface directory unavailable')
    return page.items
  }
  for (const [i,id] of surfaceIds.entries()) {
    const kind = i === 2 ? 'dm' : 'channel', teamId = teams[i === 2 ? 0 : i].id
    const read = async () => {
      const row = (await listSurfaces()).find(s => s.id === id)
      if (row && (!equalScope(row.scope) || row.kind !== kind || row.team_ids?.length !== 1 || row.team_ids[0] !== teamId || !row.title?.startsWith('【演示】'))) throw Error('Demo surface identity changed; no overwrite')
      return row
    }
    const surface = await read() ?? await recover(() => call(`collaboration/surfaces/${id}`, { request_id: `${id}-create-v1`, expected_revision: 0, scope, kind, title: ['【演示】产品讨论','【演示】质量走查','【演示】产品私信'][i], team_ids: [teamId], enabled: true }), read)
    const content = `【演示示例消息，非模型输出】${id}：这里可浏览讨论和编辑团队职责；没有启动模型、任务执行或外部发送。`
    const findMessage = async () => {
      let after = 0
      for (let page = 0; page < 100; page++) {
        const result = await call(`collaboration/surfaces/${id}/messages?limit=50&after=${after}`)
        if (!Array.isArray(result.items)) throw Error('Demo message directory unavailable')
        const found = result.items.find(m => m.content === content && m.actor?.kind === 'human' && m.actor?.id === 'local_owner')
        if (found) return found
        if (!result.has_more) return null
        if (!Number.isSafeInteger(result.next_cursor) || result.next_cursor <= after) throw Error('Invalid demo message cursor')
        after = result.next_cursor
      }
      throw Error('Demo history exceeds bounded recovery; no write attempted')
    }
    if (!await findMessage()) {
      // Seed receipt command remains immutable even if later configuration changes.
      if (surface.revision !== 1) throw Error('Demo surface changed before sample was confirmed; no message added')
      await recover(() => call(`collaboration/surfaces/${id}/messages`, { request_id: `${id}-sample-v1`, expected_revision: 1, content, mentions: [] }), findMessage)
    }
  }
  return { namespace, workspace, scope, teams, surfaceIds, nativeConversationSamples: false }
}
