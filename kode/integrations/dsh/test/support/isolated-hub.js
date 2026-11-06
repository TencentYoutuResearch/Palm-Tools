/** Own only generated fixture configuration/processes; never use a daily service. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BackendClient } from '../../src/backend-client.js'
const binary = fileURLToPath(new URL('../../../../target/debug/kode-session-server', import.meta.url))
export async function isolatedHub(node) {
  const root = await mkdtemp(join(tmpdir(), 'kode-hub-fixture-'))
  const token = randomBytes(32).toString('hex'), tokenFile = join(root, 'admin.token'), config = join(root, 'config.json')
  await writeFile(tokenFile, token, { mode: 0o600 })
  await writeFile(config, JSON.stringify({ node_id: node, database: join(root, 'ledger.sqlite'), peers: [] }), { mode: 0o600 })
  await writeFile(join(root, 'gui-state.json'), JSON.stringify({ config_path: join(root, 'fixture-config.toml') }), { mode: 0o600 })
  let child, bind = '127.0.0.1:0', client
  const stop = async (signal = 'SIGINT') => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    const current = child, exited = once(current, 'exit')
    current.kill('SIGCONT'); current.kill(signal)
    const timer = setTimeout(() => current.kill('SIGKILL'), 3000)
    try { await exited } finally { clearTimeout(timer) }
  }
  const start = async () => {
    if (child && child.exitCode === null && child.signalCode === null) throw new Error('Fixture Hub already running')
    child = spawn(binary, ['--config', config, '--token-file', tokenFile, '--bind', bind], {
      env: { ...process.env, KODE_GUI_STATE_PATH: join(root, 'gui-state.json'), KODE_CLOUD_SYNC_CONFIG: join(root, 'cloud-sync.json'), KODE_MEMORY_ROOT: join(root, 'memory') },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    bind = await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => finish(new Error('Fixture Hub startup timed out')), 10000)
      const finish = (error, address) => { clearTimeout(timer); child.off('error', failed); child.off('exit', exited); child.stdout.off('data', data); error ? reject(error) : resolve(address) }
      const failed = () => finish(new Error('Fixture Hub could not start'))
      const exited = () => finish(new Error('Fixture Hub exited before ready'))
      const data = bytes => { output = (output + bytes).slice(-8192); const match = output.match(/kode-session-server [a-zA-Z0-9_-]+ (127\.0\.0\.1:\d+)/); if (match) finish(null, match[1]) }
      child.once('error', failed); child.once('exit', exited); child.stdout.on('data', data)
    })
    client = new BackendClient(`http://${bind}`, token)
    return client
  }
  try { await start() } catch (error) { await stop(); await rm(root, { recursive: true, force: true }); throw error }
  return { node, root, get pid() { return child?.pid }, get client() { return client }, get url() { return `http://${bind}` }, start, stop,
    pause() { if (!child.kill('SIGSTOP')) throw new Error('Fixture Hub pause failed') },
    resume() { child.kill('SIGCONT') },
    async close() { await stop(); await rm(root, { recursive: true, force: true }) },
  }
}
export async function pairHubs(home, worker) {
  const configFile = process.env.KODE_TEST_SSH_CONFIG, port = Number(process.env.KODE_TEST_SSH_PORT)
  if ((configFile || process.env.KODE_TEST_SSH_PORT) && (!configFile || !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('Explicit disposable SSH fixture configuration and port required')
  }
  const link_token = randomBytes(32).toString('hex')
  await home.client.call('/api/v1/messaging/workbench/peers', { node_id: worker.node, link_token, url: null, ssh: null })
  await worker.client.call('/api/v1/messaging/workbench/peers', { node_id: home.node, link_token,
    url: configFile ? null : home.url,
    ssh: configFile ? { host: 'messaging.example', port, remote_port: Number(new URL(home.url).port), config_file: configFile } : null })
}
