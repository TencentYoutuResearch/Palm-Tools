/** Real Host/cloud/native-runtime acceptance test. No model or user configuration is used.
 * Build kode-session-server, kode-sync-server and kode-gui first. Requires installed dsh dependencies.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import net from 'node:net'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..'), project = resolve(plugin, '../..')
const root = await mkdtemp(join(tmpdir(), 'kode-mobile-sync-')), children = []
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, check, description, timeout = 30000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) { try { const value = await read(); if (check(value)) return value } catch (error) { last = error }; await pause(200) }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ''}`)
}
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port }
const backendPort = await freePort(), syncPort = await freePort(), dshPort = await freePort()
const backendUrl = `http://127.0.0.1:${backendPort}`, cloudUrl = `http://127.0.0.1:${syncPort}`, hostUrl = `http://127.0.0.1:${dshPort}`
const adminToken = randomBytes(32).toString('hex'), tokenFile = join(root, 'admin.token'), stateFile = join(root, 'gui-state.json')
const env = { ...process.env, KODE_GUI_STATE_PATH: stateFile, KODE_WORKBENCH_CONNECTION: join(root, 'connection.json'), KODE_DISABLE_AUTO_SETUP: '1', KODE_MEMORY_ROOT: join(root, 'memory'), KODE_CLOUD_SYNC_CONFIG: join(root, 'cloud.json'), KODE_BRIDGE_BIND: '127.0.0.1:0' }
async function start(name, executable, args, extra = {}) {
  const child = spawn(executable, args, { cwd: project, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes }); child.on('error', error => { output += error.message })
  children.push(child)
  return { child, log: () => output, name }
}
async function json(base, path, body, headers = {}) {
  const response = await fetch(base + path, { headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`)
  return JSON.parse(text)
}
const owner = (path, body) => json(backendUrl, '/api/v1/messaging/' + path, body, { authorization: `Bearer ${adminToken}` })
let binding
const mobile = (path, body, key) => json(cloudUrl, '/api/v1/' + path, body, { authorization: `Bearer ${binding.access_token}`, ...(key ? { 'Idempotency-Key': key } : {}) })
async function history(id) { return (await mobile(`sessions/${id}/history`)).events }
async function executed(id, response) { return until(() => history(id), events => { const receipt = events.find(event => event.type === 'command.status' && event.payload.command_id === response.command_id); if (receipt?.payload.status === 'failed') throw new Error(receipt.payload.error); return receipt?.payload.status === 'executed' }, 'runtime execution receipt') }
async function send(session, text) {
  const key = randomUUID(), response = await mobile(`sessions/${session.id}/input`, { text }, key)
  await executed(session.id, response)
  await mobile(`sessions/${session.id}/input`, { text }, key)
  const events = await until(() => history(session.id), events => events.some(event => event.type === 'message' && event.payload.role === 'assistant' && event.payload.text?.includes(text) && event.payload.streaming === false), 'committed Agent reply')
  const users = events.filter(event => event.type === 'message' && event.payload.role === 'user' && event.payload.text === text)
  assert.equal(users.length, 1, 'idempotent retry must not submit twice')
  const reply = events.find(event => event.type === 'message' && event.payload.role === 'assistant' && event.payload.text?.includes(text))
  assert.ok(users[0].ts <= reply.ts, 'user message precedes streamed reply')
}
try {
  await writeFile(tokenFile, adminToken, { mode: 0o600 })
  const server = join(project, 'target/debug/kode-session-server'), configFile = join(root, 'backend.json')
  await writeFile(configFile, JSON.stringify({ node_id: 'mobile-validation', database: join(root, 'backend.sqlite'), peers: [] }))
  await writeFile(env.KODE_WORKBENCH_CONNECTION, JSON.stringify({ url: backendUrl, token_file: tokenFile, server_command: server, server_config: configFile }), { mode: 0o600 })
  const guiConfig = join(root, 'config.toml')
  await writeFile(guiConfig, 'default_backend = "codebuddy"\n')
  await writeFile(stateFile, JSON.stringify({ version: 1, tabs: [], config_path: guiConfig }))
  await start('backend', server, ['--config', configFile, '--token-file', tokenFile, '--bind', `127.0.0.1:${backendPort}`])
  await start('cloud', join(project, 'target/debug/kode-sync-server'), [], { KODE_SYNC_BIND: `127.0.0.1:${syncPort}`, KODE_SYNC_PUBLIC_URL: cloudUrl, KODE_SYNC_DATABASE: join(root, 'cloud.sqlite') })
  await until(() => owner('node'), value => Boolean(value.node_id), 'backend ready')
  await owner('workbench/agents', { action: 'save', key: 'validation-gui', name: 'Validation GUI', config: { command: process.execPath, args: [join(plugin, 'test/fixture-acp-server.js')], protocol: 'codebuddy', default_model: 'fixture-fast', model_flag: '--model', enabled: true } })
  const desktop = await start('GUI', join(project, 'target/debug/kode-gui'), [])
  const pairing = await until(() => owner('cloud/pair', { server_url: cloudUrl }), value => Boolean(value.uri), 'cloud pairing')
  const invite = new URL(pairing.uri)
  binding = await json(cloudUrl, `/api/v1/pairings/${invite.searchParams.get('pairing_id')}/claim`, { secret: invite.searchParams.get('secret'), mobile_name: 'Validation phone' })
  await until(() => mobile('backends'), value => value.backends.some(row => row.key === 'gui:validation-gui'), 'GUI catalog')
  const gui = await mobile('sessions', { backend_key: 'gui:validation-gui', cwd: root, model: 'fixture-fast' }, 'gui-create')
  assert.equal((await mobile('sessions', { backend_key: 'gui:validation-gui', cwd: root, model: 'fixture-fast' }, 'gui-create')).id, gui.id)
  assert.ok((await mobile('backends/' + encodeURIComponent(gui.runtime_backend_key ?? 'gui:validation-gui') + '/models')).models.length)
  assert.ok(gui.permission_modes.some(mode => mode.id === 'plan'))
  await executed(gui.id, await mobile(`sessions/${gui.id}/mode`, { mode: 'plan' }, 'gui-mode'))
  await until(() => mobile(`sessions/${gui.id}`), value => value.permission_mode === 'plan', 'confirmed GUI permission mode')
  await send(gui, 'GUI first message')
  console.log('PASS GUI-first creation, native reply and idempotent submission')

  const profile = join(root, 'dsh-home/profiles/web'), modules = join(profile, 'node_modules')
  await mkdir(modules, { recursive: true })
  for (const name of await readdir(join(plugin, 'node_modules'))) {
    if (name === '@kode') { await mkdir(join(modules, name)); for (const child of await readdir(join(plugin, 'node_modules/@kode'))) await symlink(join(plugin, 'node_modules/@kode', child), join(modules, '@kode', child)); await symlink(plugin, join(modules, '@kode/dsh')) }
    else await symlink(join(plugin, 'node_modules', name), join(modules, name))
  }
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'mobile-sync-validation', private: true, dependencies: { '@kode/dsh': `file:${plugin}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@kode/dsh'] } } }))
  await writeFile(join(profile, 'cordis.yml'), '[]\n')
  const fixture = { id: 'validation-dsh', name: 'Validation dsh', type: 'codex', executable: process.execPath, args: [join(plugin, 'test/fixture-codex-server.js')], defaultModel: 'fixture', env: { KODE_FIXTURE_AGENT_LABEL: 'Shared dsh', KODE_FIXTURE_UNIQUE_THREAD: '1' } }
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: kode\n  config: ${JSON.stringify({ url: backendUrl, tokenFile, stateFile: join(root, 'owners.json'), sharedBackendState: true, publishWorkbenchConnection: false, agentProfiles: [fixture] })}\n`)
  const host = await start('dsh', process.execPath, [join(plugin, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--', '--port', String(dshPort), '--host', '127.0.0.1', '--no-open'], { DSH_HOME: join(root, 'dsh-home'), KODE_DSH_HOME: join(root, 'dsh-state') })
  const launch = await until(async () => host.log().match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\x1b]+/)?.[0], Boolean, 'authenticated dsh Host')
  const signedIn = await fetch(launch, { redirect: 'manual' }), cookie = signedIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const web = (path, body) => json(hostUrl, '/api/kode/' + path, body, { cookie })
  await until(() => mobile('backends'), value => value.backends.some(row => row.key === 'dsh:validation-dsh'), 'dsh runtime catalog')
  // Publish a saved-tab reference for the already running GUI session, exactly as GUI persistence does.
  const doc = await owner('workbench/documents/session-index')
  await owner('workbench/documents/session-index', { expected_revision: doc.revision, value: { ...doc.value, native_sessions: [...(doc.value.native_sessions ?? []), { backend_key: gui.backend_key, session_id: gui.session_uuid, cwd: root, title: 'GUI first message', transport_kind: 'acp' }] } })
  const directory = await web('project-hosts?current=local&view=directory')
  const saved = directory.hosts.find(row => row.id === 'local').sessions.find(row => row.nativeThreadId === gui.session_uuid)
  assert.ok(saved?.id.startsWith('saved:'))
  const attached = await web('project-hosts?current=local', { action: 'import-saved', sessionId: saved.id })
  assert.equal(attached.sharedSession.session_uuid, gui.session_uuid)
  assert.equal(attached.imported, false, 'opening a running GUI session must not resume another native CLI')
  await web('shared-session', { session_id: attached.sharedSession.id, kind: 'input', payload: { text: 'From dsh into GUI' }, request_id: randomUUID() })
  await until(() => history(gui.id), events => events.some(row => row.type === 'message' && row.payload.role === 'assistant' && row.payload.text?.includes('From dsh into GUI')), 'dsh to GUI reply')
  console.log('PASS installing dsh discovers and attaches the existing GUI session')

  const dsh = await mobile('sessions', { backend_key: 'dsh:validation-dsh', cwd: root, model: 'fixture' }, 'dsh-create')
  assert.equal(dsh.runtime, 'dsh'); assert.ok(dsh.permission_modes.length)
  assert.equal(dsh.runtime_backend_key, 'dsh:validation-dsh')
  assert.ok((await mobile('backends/' + encodeURIComponent(dsh.runtime_backend_key) + '/models')).models.some(row => row.id === 'fixture'))
  await send(dsh, 'Mobile into dsh')
  const publicSession = (await owner('runtime/sessions')).sessions.find(row => row.runtime_session_id === dsh.runtime_session_id)
  const mirrored = await owner(`runtime/history?id=${publicSession.id}`)
  assert.ok(mirrored.events.some(event => event.payload.text?.includes('Mobile into dsh')))
  const mode = dsh.permission_modes.find(option => option.id === 'read-only') ?? dsh.permission_modes[0]
  await executed(dsh.id, await mobile(`sessions/${dsh.id}/mode`, { mode: mode.id }, 'permission-change'))
  await until(() => mobile(`sessions/${dsh.id}`), value => value.permission_mode === mode.id, 'durable dsh permission preset')
  await web('integrations', { action: 'configure', settings: { messaging_enabled: false } })
  await web('integrations', { action: 'configure', settings: { memory_enabled: false } })
  assert.deepEqual(await owner('integrations'), { messaging_enabled: false, memory_enabled: false })
  console.log('PASS mobile/dsh content, permission execution and shared settings')
  await until(async () => JSON.parse(await readFile(stateFile, 'utf8')), state => state.tabs.some(tab => tab.backend_key === 'validation-gui' && tab.transport_kind === 'acp'), 'persisted custom ACP transport')
  desktop.child.kill('SIGTERM')
  await until(async () => desktop.child.exitCode !== null || desktop.child.signalCode !== null, Boolean, 'GUI exit')
  await start('restored GUI', join(project, 'target/debug/kode-gui'), [])
  const restored = (await until(() => mobile('sessions'), value => value.sessions.some(row => row.runtime === 'gui' && row.backend_key === 'validation-gui' && row.status === 'idle' && row.id !== gui.id), 'custom ACP session restored')).sessions.find(row => row.runtime === 'gui' && row.backend_key === 'validation-gui' && row.status === 'idle' && row.id !== gui.id)
  assert.ok(restored.permission_modes.some(mode => mode.id === 'plan'))
  await send(restored, 'Mobile after GUI restart')
  console.log('PASS custom ACP transport and native replies after GUI restart')
} finally {
  for (const child of children.reverse()) { if (child.exitCode === null) child.kill('SIGTERM') }
  await pause(500)
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
  if (process.env.KODE_KEEP_SYNC_TEST !== '1') await rm(root, { recursive: true, force: true })
}
