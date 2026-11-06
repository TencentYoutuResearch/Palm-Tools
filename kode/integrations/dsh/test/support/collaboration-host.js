/** Owned child Host; protocol payloads never include fixture credentials. */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
export function collaborationHost(hub, { native = false } = {}) {
  let child, next = 0
  const receive = (match, send) => new Promise((resolve, reject) => {
    const current = child, timer = setTimeout(() => finish(new Error('Host fixture timed out')), 10000)
    function finish(error, value) { clearTimeout(timer); current.off('message', message); current.off('exit', exited); error ? reject(error) : resolve(value) }
    const message = value => { if (value.type === 'error') finish(new Error(value.error)); else if (match(value)) finish(value.error ? new Error(value.error) : null, value) }
    const exited = () => finish(new Error('Host fixture exited'))
    current.on('message', message); current.once('exit', exited); send?.()
  })
  const start = async () => {
    child = fork(fileURLToPath(new URL('../fixture-collaboration-host.js', import.meta.url)), [hub.root, hub.url, join(hub.root, 'admin.token'), hub.node, native ? 'native' : 'controlled'], { execPath: process.env.KODE_TEST_HOST_NODE ?? process.execPath, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    return receive(value => value.type === 'ready')
  }
  const call = async (name, args) => { const id = ++next; return (await receive(value => value.id === id, () => child.send({ id, name, args }))).result }
  const kill = async () => { if (child && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit } }
  const wait = async (name, args, predicate) => { for (let i = 0; i < 250; i++) { const value = await call(name, args); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)) }; assert.fail(`Expected durable state: ${name}`) }
  return { start, call, kill, wait }
}
