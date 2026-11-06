import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

test('kernel workspace ownership excludes aliases/processes and releases after SIGKILL', { skip: !process.env.KODE_TEST_HOST_NODE, timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-workspace-lock-')), children = []
  const start = async workspace => {
    const child = fork(new URL('./fixture-workspace-lock.js', import.meta.url), [join(root, 'locks'), workspace], {
      execPath: process.env.KODE_TEST_HOST_NODE, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    children.push(child)
    const [message] = await once(child, 'message')
    return { child, message }
  }
  try {
    const workspace = join(root, 'workspace'), other = join(root, 'other'), alias = join(root, 'alias')
    await mkdir(workspace); await mkdir(other); await symlink(workspace, alias)
    const first = await start(workspace); assert.equal(first.message.event, 'locked')
    assert.equal((await start(alias)).message.event, 'busy')
    const unrelated = await start(other); assert.equal(unrelated.message.event, 'locked')
    assert.notEqual(unrelated.message.key, first.message.key)
    const exited = once(first.child, 'exit'); first.child.kill('SIGKILL'); await exited
    const recovered = await start(alias); assert.equal(recovered.message.event, 'locked')
    assert.equal(recovered.message.key, first.message.key)
    const released = once(recovered.child, 'exit'); recovered.child.send('release'); await released
    assert.equal((await start(workspace)).message.event, 'locked')
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    }))
    await rm(root, { recursive: true, force: true })
  }
})
