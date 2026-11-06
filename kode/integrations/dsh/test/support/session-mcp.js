/** Owned STDIO process using a generated fixture session credential only. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
export async function sessionMcp(hub, registration) {
  const file = join(hub.root, `${registration.session.address.session_id}-mcp.token`)
  await writeFile(file, registration.owner_token, { mode: 0o600 })
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../src/mcp.js', import.meta.url))], { env: { ...process.env, KODE_MESSAGING_URL: hub.url, KODE_MESSAGING_TOKEN_FILE: file }, stdio: ['pipe', 'pipe', 'ignore'] })
  const lines = createInterface({ input: child.stdout }), pending = new Map()
  let next = 0
  lines.on('line', line => { const result = JSON.parse(line); pending.get(result.id)?.resolve(result); pending.delete(result.id) })
  child.on('exit', () => { for (const request of pending.values()) request.reject(new Error('Fixture MCP exited')); pending.clear() })
  const write = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error('Fixture MCP timed out')) }, 10000)
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    write(id, method, params)
  })
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit'); child.stdin.end()
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
    try { await exited } finally { clearTimeout(timer); lines.close() }
  }
  try {
    await call('initialize', { protocolVersion: '2024-11-05' })
    return { close, async tool(name, args) {
      const response = await call('tools/call', { name, arguments: args })
      if (response.error || response.result?.isError) throw new Error(response.result?.content?.[0]?.text ?? 'Fixture MCP RPC failed')
      return JSON.parse(response.result.content[0].text)
    }, dropReceipt(name, args) {
      // Deliberately discard this request's response at the model-facing boundary.
      write(++next, 'tools/call', { name, arguments: args })
    } }
  } catch (error) { await close(); throw error }
}
