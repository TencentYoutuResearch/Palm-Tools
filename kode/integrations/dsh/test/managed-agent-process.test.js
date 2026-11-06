import test from 'node:test'
import assert from 'node:assert/strict'
import { signalAgentProcess } from '../src/managed-agent-process.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnAgent } from '../src/managed-agent-process.js'
import { RpcProcess } from '../src/rpc-process.js'

test('a protected process group falls back to its owned live child', () => {
  const calls = [], child = { pid: 321, exitCode: null, signalCode: null, kill: signal => calls.push(signal) }
  signalAgentProcess(child, 'SIGKILL', { platform: 'darwin', killGroup: pid => { assert.equal(pid, -321); throw Object.assign(new Error('protected group'), { code: 'EPERM' }) } })
  assert.deepEqual(calls, ['SIGKILL'])
})

test('protected reaped groups and denied child signals cannot escape a cleanup timer', () => {
  const denied = () => { throw Object.assign(new Error('protected process'), { code: 'EPERM' }) }
  assert.doesNotThrow(() => signalAgentProcess({ pid: 321, exitCode: null, signalCode: null, kill: denied }, 'SIGKILL', { platform: 'darwin', killGroup: denied }))
  signalAgentProcess({ pid: 321, exitCode: 0, signalCode: null, kill: () => assert.fail('must not signal a reaped child') }, 'SIGKILL', { platform: 'darwin', killGroup: denied })
})


async function waitFor(predicate) {
  const until = Date.now() + 5000
  while (!(await predicate())) {
    assert.ok(Date.now() < until, 'fixture readiness timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
test('managed close is shared and observes exit after escalating an ignored TERM', async () => {
  const process = spawnAgent(globalThis.process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"], tmpdir())
  let ready = false
  process.child.stdout.on('data', () => { ready = true })
  try {
    await waitFor(() => ready)
    const first = process.close(), second = process.close()
    assert.equal(first, second)
    const evidence = await first
    assert.equal(evidence.leader_exited, true)
    assert.equal(evidence.exit_signal, 'SIGKILL')
    assert.equal(evidence.process_group_empty, process.platform !== 'win32')
    assert.equal(evidence.descendants_confirmed, false)
    assert.deepEqual(evidence.signal_failures, [])
  } finally { await process.close() }
})
test('RPC close signals owned descendants as well as the leader', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-stop-tree-')), marker = join(root, 'child-stopped')
  const child = `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'term');process.exit(0)});console.log('ready');setInterval(()=>{},1000)`
  const leader = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','pipe','ignore']});c.stdout.on('data',()=>console.log(JSON.stringify({method:'fixture/ready'})));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`
  const rpc = new RpcProcess({ executable: process.execPath, args: ['-e', leader, '--'] }, root)
  let ready = false
  rpc.on('notification', () => { ready = true })
  try {
    await waitFor(() => ready)
    const evidence = await rpc.close()
    assert.equal(await readFile(marker, 'utf8'), 'term')
    assert.equal(evidence.leader_exited, true)
    assert.equal(evidence.signal_scope, 'process_group')
    assert.equal(evidence.descendants_confirmed, false, 'a group signal cannot prove escaped descendants stopped')
  } finally { await rpc.close(); await rm(root, { recursive: true, force: true }) }
})
test('spawn failure never reports a confirmed process exit', async () => {
  const process = spawnAgent('/nonexistent/kode-fixture-agent', [], tmpdir())
  await waitFor(() => process.closed)
  const evidence = await process.close()
  assert.equal(evidence.leader_exited, false)
  assert.equal(evidence.process_group_empty, false)
  assert.equal(evidence.descendants_confirmed, false)
})

test('optional RPC EOF shutdown lets the launcher reap its child before group confirmation', async () => {
  const child = "process.on('SIGTERM',()=>process.exit(0));console.log('ready');setInterval(()=>{},1000)"
  const leader = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','pipe','ignore']});c.stdout.on('data',()=>console.log(JSON.stringify({method:'fixture/ready'})));process.stdin.resume();process.stdin.on('end',()=>{c.once('exit',()=>process.exit(0));c.kill('SIGTERM')})`
  const rpc = new RpcProcess({ executable: process.execPath, args: ['-e', leader, '--'] }, tmpdir(), { gracefulCloseMs: 2000 })
  let ready = false
  rpc.on('notification', () => { ready = true })
  try {
    await waitFor(() => ready)
    const first = rpc.close()
    assert.equal(rpc.close(), first)
    assert.throws(() => rpc.send({ method: 'fixture/rejected' }), /closed/)
    const evidence = await first
    assert.equal(evidence.exit_code, 0)
    assert.equal(evidence.exit_signal, null)
    assert.equal(evidence.process_group_empty, true)
    assert.deepEqual(evidence.signal_failures, [])
  } finally { await rpc.close() }
})

test('a transient denied group query is retried until actual ESRCH confirms drainage', async () => {
  const rpc = new RpcProcess({ executable: process.execPath, args: ['-e', "console.log(JSON.stringify({method:'fixture/ready'}));setInterval(()=>{},1000)", '--'] }, tmpdir())
  let ready = false, denied = false
  rpc.on('notification', () => { ready = true })
  const kill = process.kill
  try {
    await waitFor(() => ready)
    process.kill = function (pid, signal) {
      try { return kill.call(process, pid, signal) } catch (error) {
        if (pid === -rpc.child.pid && signal === 0 && error.code === 'ESRCH' && !denied) {
          denied = true
          throw Object.assign(new Error('fixture transient query denial'), { code: 'EPERM' })
        }
        throw error
      }
    }
    const evidence = await rpc.close()
    assert.equal(denied, true)
    assert.equal(evidence.process_group_empty, true)
    assert.deepEqual(evidence.signal_failures, [])
  } finally { process.kill = kill; await rpc.close() }
})
