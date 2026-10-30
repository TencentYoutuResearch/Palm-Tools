import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareRuntimeConfig, runtimePlatform } from '../src/bundle-runtime.js'

test('one-command startup provisions a private backend and bundled server', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kode-bundle-home-'))
  const root = await mkdtemp(join(tmpdir(), 'kode-bundle-plugin-'))
  const server = join(root, 'assets', 'remote', runtimePlatform('darwin', 'arm64'), 'kode-session-server')
  await mkdir(join(server, '..'), { recursive: true })
  await writeFile(server, '#!/bin/sh\n')
  await chmod(server, 0o755)
  try {
    const config = await prepareRuntimeConfig({ url: 'http://127.0.0.1:47870' }, {
      home, root, platform: 'darwin', arch: 'arm64', hostname: 'Test Mac', env: {},
    })
    const directory = join(home, '.config', 'kode', 'dsh')
    assert.equal(config.tokenFile, join(directory, 'admin.token'))
    assert.equal(config.serverConfig, join(directory, 'messaging.json'))
    assert.equal(config.serverCommand, server)
    assert.equal(config.stateFile, join(directory, 'owners.json'))
    assert.match((await readFile(config.tokenFile, 'utf8')).trim(), /^[a-f0-9]{64}$/)
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(config.tokenFile)).mode & 0o777, 0o600)
    const backend = JSON.parse(await readFile(config.serverConfig, 'utf8'))
    assert.equal(backend.node_id, 'test-mac')
    assert.equal(backend.database, join(directory, 'messaging.sqlite'))
    const token = await readFile(config.tokenFile, 'utf8')
    const second = await prepareRuntimeConfig({}, {
      home, root, platform: 'darwin', arch: 'arm64', hostname: 'Renamed Mac', env: {},
    })
    assert.equal(await readFile(second.tokenFile, 'utf8'), token)
    assert.equal(JSON.parse(await readFile(second.serverConfig, 'utf8')).node_id, 'test-mac')
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('explicit remote and disabled-auto configurations are not provisioned', async () => {
  const explicit = await prepareRuntimeConfig({
    url: 'https://kode.example.com',
    tokenFile: '/tmp/explicit-token',
    autoProvision: false,
  }, { env: {} })
  assert.equal(explicit.tokenFile, '/tmp/explicit-token')
  assert.equal(explicit.serverConfig, undefined)
  assert.equal(explicit.serverCommand, undefined)
  assert.equal(explicit.stateFile, undefined)
})

test('GUI-first installations join the same backend without provisioning a second database', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kode-gui-first-'))
  const directory = join(home, 'Library', 'Application Support', 'kode')
  await mkdir(directory, { recursive: true })
  const shared = { url: 'http://127.0.0.1:49123', token_file: join(directory, 'token'), server_config: join(directory, 'server.json'), server_command: '/Applications/kode.app/Contents/MacOS/kode', server_args: ['--kode-workbench-server'] }
  await writeFile(join(directory, 'workbench-connection.json'), JSON.stringify(shared))
  try {
    const result = await prepareRuntimeConfig({ url: 'http://127.0.0.1:47870' }, { home, platform: 'darwin', env: {} })
    assert.equal(result.url, shared.url); assert.equal(result.tokenFile, shared.token_file); assert.equal(result.serverConfig, shared.server_config)
    assert.deepEqual(result.serverArgs, shared.server_args); assert.equal(result.sharedBackendState, true)
    assert.equal(result.publishWorkbenchConnection, undefined)
    await assert.rejects(readFile(join(home, '.config/kode/dsh/messaging.json')), { code: 'ENOENT' })
    const explicit = await prepareRuntimeConfig({ url: 'https://explicit.example', tokenFile: '/explicit/token' }, { home, platform: 'darwin', env: {} })
    assert.equal(explicit.url, 'https://explicit.example')
  } finally { await rm(home, { recursive: true, force: true }) }
})


test('explicit paths take precedence and environment moves only generated state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kode-bundle-override-'))
  try {
    const config = await prepareRuntimeConfig({ serverConfig: '/custom/config', serverCommand: '/custom/server', stateFile: '/custom/owners' }, { env: { KODE_DSH_HOME: directory } })
    assert.equal(config.tokenFile, join(directory, 'admin.token'))
    assert.equal(config.serverConfig, '/custom/config')
    assert.equal(config.serverCommand, '/custom/server')
    assert.equal(config.stateFile, '/custom/owners')
    for (const input of [{ tokenFile: '/custom/token' }, { autoProvision: false }, { url: 'https://localhost' }]) {
      const result = await prepareRuntimeConfig(input, { env: {} })
      assert.equal(result.serverConfig, undefined)
    }
    const result = await prepareRuntimeConfig({}, { env: { KODE_BRIDGE_TOKEN: 'external' } })
    assert.equal(result.tokenFile, undefined)
    assert.equal(result.serverConfig, undefined)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
