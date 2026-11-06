import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectProjectConfiguration } from '../src/project-inspection-native.js'

test('cancelled inspection never starts a native reader', async () => {
  const stop = new AbortController()
  stop.abort(Error('fixture stopped before inspection'))
  await assert.rejects(inspectProjectConfiguration({ root: '/fixture', workspaceId: 'selected', paths: ['README.md'],
    identity: { dev: 1n, ino: 1n }, command: '/must-not-start', signal: stop.signal }), /stopped before inspection/)
})

test('inspection cancellation waits for actual child exit before returning', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-inspection-stop-'))
  const command = join(root, 'reader.mjs'), pidFile = join(root, 'pid'), finished = join(root, 'finished')
  const stop = new AbortController()
  let pending
  try {
    await writeFile(command, '#!' + process.execPath + '\n' +
      "import {writeFileSync} from 'node:fs';\n" +
      'writeFileSync(' + JSON.stringify(pidFile) + ',String(process.pid));\n' +
      'setInterval(()=>{},1000);\n' +
      "process.on('SIGTERM',()=>setTimeout(()=>{writeFileSync(" + JSON.stringify(finished) + ", 'stopped');process.exit(0)},150));\n")
    await chmod(command, 0o700)
    pending = inspectProjectConfiguration({ root, workspaceId: 'selected', paths: ['README.md'], identity: { dev: 1n, ino: 1n }, command, signal: stop.signal })
    pending.catch(() => {})
    let pid
    const until = Date.now() + 3000
    while (!pid) {
      try { pid = Number(await readFile(pidFile, 'utf8')) } catch {}
      assert.ok(Date.now() < until, 'owned reader started before deadline')
      if (!pid) await new Promise(resolve => setTimeout(resolve, 10))
    }
    stop.abort(Error('fixture cancelled during inspection'))
    await assert.rejects(pending, /cancelled during inspection/)
    assert.equal(await readFile(finished, 'utf8'), 'stopped')
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
  } finally {
    stop.abort(Error('owned inspection cleanup'))
    await pending?.catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
