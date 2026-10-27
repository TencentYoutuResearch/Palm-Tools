/** Standard stdio MCP client/server proxy for ACP Agents that do not accept HTTP MCP servers. */
import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
const token = (await readFile(process.env.KODE_TOOL_PROXY_TOKEN_FILE, 'utf8')).trim()
const endpoint = new URL(process.env.KODE_TOOL_PROXY_URL)
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Agent tool proxy must be the Host loopback endpoint')
const client = new Client({ name: 'kode-stdio-tool-proxy', version: '0.1.0' })
await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
const server = new Server({ name: 'kode-dsh-agent-tools', version: '0.1.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () => client.listTools())
server.setRequestHandler(CallToolRequestSchema, request => client.callTool(request.params))
await server.connect(new StdioServerTransport())
const close = () => { void server.close(); void client.close() }
process.stdin.once('end', close)
process.once('SIGTERM', () => { close(); process.exit(0) })
