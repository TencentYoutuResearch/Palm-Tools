import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deploymentHost, sshArgs, shellQuote, bootstrapScript, runProcess, deployRemote } from '../src/remote-deploy.js'
import { ProjectHosts } from '../src/project-hosts.js'

test('SSH deployment validates targets, retains host verification and quotes shell data', () => {
  const host = deploymentHost({ name: 'Builder', host: 'user@builder.example', port: 2200, configFile: '/example/ssh.conf' })
  assert.ok(sshArgs(host).includes('StrictHostKeyChecking=yes'))
  assert.ok(sshArgs(host).includes('BatchMode=yes'))
  assert.equal(sshArgs(host).at(-1), host.host)
  for (const value of ['-oProxyCommand=bad', 'bad\nhost', 'user host']) assert.throws(() => deploymentHost({ name: 'Bad', host: value }))
  assert.throws(() => deploymentHost({ name: 'Bad', host: 'builder.example', port: 65536 }))
  assert.equal(shellQuote("a'b"), "'a'\\''b'")
  assert.throws(() => bootstrapScript('bad;id', 'a'.repeat(64), {}))
})

test('deployment cancellation terminates its owned process and reports cancellation', async () => {
  const controller = new AbortController()
  const result = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal })
  controller.abort(new Error('cancelled by owner'))
  await assert.rejects(result, /cancelled by owner/)
})

test('deployment jobs deduplicate work, stream metadata, persist private credentials and permit retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-deploy-jobs-')), result = Promise.withResolvers()
  let calls = 0
  const manager = new ProjectHosts({}, { projectHostsFile: join(root, 'hosts.json'), deployRemote: async (host, _config, { progress }) => {
    calls++; progress('connect', 'running', 'Connecting'); await result.promise
    progress('connect', 'done', 'Connected')
    return { ...host, remote_port: 47980, token: 'private-web-token', managed: true, node_id: 'remote-test' }
  } })
  manager.connect = async () => ({})
  try {
    const input = { name: 'Builder', host: 'builder.example' }
    const initial = manager.startDeployment(input)
    assert.equal(manager.startDeployment(input).id, initial.id); assert.equal(calls, 1)
    const updates = [], job = manager.deployments.get(initial.id)
    job.listeners.add(() => updates.push(manager.deploymentView(job)))
    result.resolve(); await job.promise
    assert.equal(job.status, 'done'); assert.ok(updates.some(update => update.steps.some(step => step.step === 'save' && step.status === 'running')))
    assert.doesNotMatch(JSON.stringify(manager.deploymentView(job)), /private-web-token/)
    assert.equal(JSON.parse(await readFile(join(root, 'hosts.json'), 'utf8'))[0].token, 'private-web-token')
    const again = manager.startDeployment(input); await manager.deployments.get(again.id).promise
    assert.equal(manager.hosts.length, 1); assert.equal(manager.hosts[0].id, job.result.id)
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }) }
})

test('failed and cancelled deployments never register an incomplete Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-deploy-fail-'))
  const manager = new ProjectHosts({}, { projectHostsFile: join(root, 'hosts.json'), deployRemote: async () => { throw new Error('Connection failed') } })
  try {
    const failed = manager.startDeployment({ name: 'Builder', host: 'builder.example' }); const job = manager.deployments.get(failed.id); await job.promise
    assert.equal(job.status, 'failed'); assert.equal(manager.hosts.length, 0)
    manager.config.deployRemote = async (_host, _config, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    const pending = manager.startDeployment({ name: 'Builder', host: 'builder.example' }); const cancelled = manager.deployments.get(pending.id)
    cancelled.controller.abort(new Error('cancelled')); await cancelled.promise
    assert.equal(cancelled.status, 'cancelled'); assert.equal(manager.hosts.length, 0)
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }) }
})


test('installed plugin deployment packages published files and pairs the shared Kode backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-published-deploy-'))
  const artifacts = join(root, 'linux-x64')
  await mkdir(artifacts)
  for (const name of ['kode-session-server', 'kode-ssh-tunnel']) await writeFile(join(artifacts, name), 'fixture binary, never executed')
  const packed = [], paired = []
  let stagedManifest
  const config = {
    remoteArtifactsDirectory: root,
    backendClient: { async call(path, input) {
      if (path.endsWith('/node')) return { node_id: 'desktop-test', managed_peers: true }
      paired.push(input)
    } },
  }
  const run = async (command, args, options = {}) => {
    if (command === 'tar' && args[0] === '-xzf') {
      const plugin = args.at(-1)
      await mkdir(join(plugin, 'packages/private-ui'), { recursive: true })
      await writeFile(join(plugin, 'package.json'), JSON.stringify({ dependencies: { '@kode/private-ui': '0.1.0' }, bundledDependencies: ['@kode/private-ui'] }))
      await writeFile(join(plugin, 'packages/private-ui/package.json'), JSON.stringify({ name: '@kode/private-ui', version: '0.1.0' }))
    }
    if (command === 'tar' && args[0] === '-czf') {
      if (!args.includes('package.json')) stagedManifest = JSON.parse(await readFile(join(args[args.indexOf('-C') + 1], 'plugin/package.json'), 'utf8'))
      packed.push(args)
      await writeFile(args[1], 'fixture archive')
    }
    if (options.input && typeof options.input !== 'string') for await (const _chunk of options.input) {}
    if (options.onLine) options.onLine(JSON.stringify({ kind: 'ready', nodeId: 'remote-test', webPort: 47980, backendPort: 47870, token: 'private-web-token', linkToken: 'private-pairing-token-at-least-32-bytes' }))
    return command === 'ssh' && args.at(-1).includes('KODE_PLATFORM') ? 'KODE_PLATFORM=Linux:x86_64' : ''
  }
  try {
    const result = await deployRemote(deploymentHost({ name: 'Builder', host: 'builder.example' }), config, { run, progress() {} })
    assert.equal(result.node_id, 'remote-test')
    assert.equal(stagedManifest.dependencies['@kode/private-ui'], 'file:packages/private-ui')
    assert.equal(stagedManifest.bundledDependencies, undefined)
    const source = packed.find(args => args.includes('package.json'))
    assert.ok(source)
    assert.ok(!source.includes('package-lock.json'))
    assert.equal(paired[0].node_id, 'remote-test')
    assert.equal(paired[0].ssh.remote_port, 47870)
    assert.equal(result.remote_port, 47980)
  } finally { await rm(root, { recursive: true, force: true }) }
})
