/** Optional owned backend. Existing bridges are connected to, never stopped or replaced. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'

export async function connectBackend(client, config) {
  try { return { node: await client.call('/api/v1/messaging/node'), close: async () => {} } }
  catch (error) {
    if (!config.serverConfig || !(error instanceof TypeError)) throw error
  }
  const url = new URL(client.url)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('automatic backend startup requires a loopback HTTP URL')
  if (!config.tokenFile) throw new Error('automatic backend startup requires tokenFile')
  const child = spawn(config.serverCommand ?? 'kode-session-server', [
    '--config', config.serverConfig, '--token-file', config.tokenFile,
    '--bind', `${url.hostname}:${url.port || '80'}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'], shell: false })
  let failure, stderr = ''
  child.on('error', error => { failure = error })
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096) })
  async function close() {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
    const exited = once(child, 'exit')
    child.kill('SIGINT')
    const force = setTimeout(() => child.kill('SIGKILL'), 5000)
    try { await exited } finally { clearTimeout(force) }
  }
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (failure) throw failure
      if (child.exitCode !== null) throw new Error(`kode-session-server exited (${child.exitCode}): ${stderr.trim()}`)
      try { return { node: await client.call('/api/v1/messaging/node'), close } }
      catch (error) { if (!(error instanceof TypeError)) throw error }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error('kode-session-server startup timed out')
  } catch (error) { await close(); throw error }
}
