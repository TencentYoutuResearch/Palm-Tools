import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deploymentHost, sshArgs, shellQuote, bootstrapScript, runProcess } from '../src/remote-deploy.js'
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
