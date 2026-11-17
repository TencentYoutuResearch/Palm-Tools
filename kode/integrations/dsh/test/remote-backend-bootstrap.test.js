/** Installer bootstrap remains usable while rolling back an older frontend release. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compileFunction } from 'node:vm'

const source = await readFile(new URL('../src/remote-install.mjs', import.meta.url), 'utf8')
const body = source.slice(source.indexOf('async function sharedBackend('), source.indexOf('async function start(state'))

test('rollback uses the uploaded Kode bootstrap and remains available after cancellation', async () => {
  const calls = [], children = new Set(), stop = new AbortController()
  stop.abort()
  const connection = { token_file: '/fixture/shared/admin.token', server_command: '/fixture/shared/bin/kode-session-server' }
  const spawn = (binary, args, options) => {
    calls.push({ binary, args, signal: options.signal })
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({ connection_file: '/fixture/shared/connection.json', node_id: 'existing-node', remote_port: 47870, link_token: 'existing-link-token' }))
      child.emit('close', 0)
    })
    return child
  }
  const sharedBackend = compileFunction(`${body}; return sharedBackend`, ['spawn', 'join', 'staging', 'request', 'stop', 'children', 'readJson', 'readFile'])(
    spawn, join, '/fixture/upload', { localNode: 'desktop', linkToken: 'new-token' }, stop, children,
    async () => connection, async () => 'administrator-token\n',
  )
  const state = { release: '/fixture/old-release', backendPid: 42 }
  assert.equal(await sharedBackend(state, true, true), connection)
  assert.equal(calls[0].binary, '/fixture/upload/bin/kode-session-server')
  assert.ok(calls[0].args.includes('--upgrade'))
  assert.equal(calls[0].signal, undefined)
  assert.equal(state.nodeId, 'existing-node')
  assert.equal(state.backendPid, undefined)
  assert.equal(children.size, 0)
  await sharedBackend(state)
  assert.equal(calls[1].signal, stop.signal)
})
