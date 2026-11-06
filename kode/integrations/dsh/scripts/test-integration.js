/** Start an isolated Rust backend and run the JavaScript contract/host tests against it. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm, readdir, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
const directory = dirname(fileURLToPath(import.meta.url))
const project = resolve(directory, '../../..')
// Each file may own a native Host and Chromium. Those isolated Hubs cannot
// share production admission limits, so give this runner an explicit budget.
const concurrency = Number(process.env.KODE_TEST_CONCURRENCY ?? 2)
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('KODE_TEST_CONCURRENCY must be an integer from 1 to 8')
async function run(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: project, env, stdio: 'inherit' })
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(`${command} failed (${code})`)
}
await run('cargo', ['build', '-p', 'kode-bridge', '--bin', 'kode-session-server', '--bin', 'kode-session-mcp'])
const root = await mkdtemp(join(tmpdir(), 'kode-dsh-integration-'))
await mkdir(join(root, 'codex-home'))
const tokenFile = join(root, 'admin.token')
const configFile = join(root, 'config.json')
await writeFile(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 })
await writeFile(configFile, JSON.stringify({ node_id: 'integration', database: join(root, 'messages.sqlite'), peers: [] }))
// Explicit missing fixture config selects defaults without reading the user's config.
await writeFile(join(root, 'gui-state.json'), JSON.stringify({ config_path: join(root, 'fixture-config.toml') }), { mode: 0o600 })
const backend = spawn(join(process.env.CARGO_TARGET_DIR ? resolve(project, process.env.CARGO_TARGET_DIR) : join(project, 'target'), 'debug/kode-session-server'), ['--config', configFile, '--token-file', tokenFile, '--bind', '127.0.0.1:0'], { env: { ...process.env, KODE_GUI_STATE_PATH: join(root, 'gui-state.json'), KODE_CLOUD_SYNC_CONFIG: join(root, 'cloud-sync.json'), KODE_MEMORY_ROOT: join(root, 'memory'), KODE_AGENT_HUB_HOME: join(root, 'agent-home'), CODEX_HOME: join(root, 'codex-home') }, stdio: ['ignore', 'pipe', 'inherit'] })
try {
  const address = await new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error('backend startup timed out')), 10000)
    backend.on('error', reject)
    backend.on('exit', code => { clearTimeout(timer); reject(new Error(`backend exited (${code})`)) })
    backend.stdout.on('data', bytes => { text += bytes; const match = text.match(/kode-session-server integration (127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]) } })
  })
  const files = (await readdir(resolve(directory, '../test'))).filter(f => f.endsWith('.test.js')).map(f => resolve(directory, '../test', f))
  await run(process.execPath, ['--test', `--test-concurrency=${concurrency}`, ...files], { ...process.env, KODE_TEST_BACKEND_URL: `http://${address}`, KODE_TEST_TOKEN_FILE: tokenFile })
} finally {
  const exited = once(backend, 'exit'); backend.kill('SIGINT'); await exited
  await rm(root, { recursive: true, force: true })
}
