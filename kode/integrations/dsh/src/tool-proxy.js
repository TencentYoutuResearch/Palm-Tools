/** Per-Agent MCP bridge using the official SDK. Only a scoped loopback credential leaves the Host. */
import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export async function createToolProxy(tools, execute) {
  const token = randomBytes(32).toString('hex'), root = await mkdtemp(join(tmpdir(), 'kode-agent-tools-'))
  const tokenFile = join(root, 'token')
  await writeFile(tokenFile, token, { mode: 0o600 })
  const transports = new Set()
  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401).end(); return }
    if (req.url !== '/mcp' || req.headers.host !== `127.0.0.1:${server.address().port}` || req.headers.origin) { res.writeHead(403).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const protocol = new Server({ name: 'kode-dsh-agent-tools', version: '0.1.0' }, { capabilities: { tools: {} } })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    transports.add(transport)
    const close = () => { transports.delete(transport); void transport.close(); void protocol.close() }
    res.once('close', close)
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters })) }))
    protocol.setRequestHandler(CallToolRequestSchema, async request => {
      if (!tools.some(t => t.name === request.params.name)) throw new Error('unadvertised Agent tool')
      const result = await execute(request.params.name, request.params.arguments ?? {})
      return { isError: !result.success, content: result.contentItems.filter(c => c.type === 'inputText').map(c => ({ type: 'text', text: c.text })) }
    })
    try { await protocol.connect(transport); await transport.handleRequest(req, res) }
    catch { if (!res.headersSent) res.writeHead(500); res.end(); close() }
  })
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }) }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error }
  const url = `http://127.0.0.1:${server.address().port}/mcp`
  return { url, tokenFile,
    definition: { name: 'kode', command: process.execPath, args: [fileURLToPath(new URL('./tool-proxy-stdio.js', import.meta.url))], env: [{ name: 'KODE_TOOL_PROXY_URL', value: url }, { name: 'KODE_TOOL_PROXY_TOKEN_FILE', value: tokenFile }] },
    async close() {
      await Promise.allSettled([...transports].map(t => t.close()))
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      await rm(root, { recursive: true, force: true })
    },
  }
}
