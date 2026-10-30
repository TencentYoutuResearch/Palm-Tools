/** Standards-based ACP fixture using the same released SDK as the client. No inference. */
import { agent, ndJsonStream } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import { appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
// CodeBuddy's discovery transport precedes interactive ACP creation.
if (process.argv.includes('--input-format')) {
  const { createInterface } = await import('node:readline')
  const lines = createInterface({ input: process.stdin })
  lines.on('line', line => {
    const request = JSON.parse(line)
    if (request.request?.subtype === 'get_available_models') process.stdout.write(JSON.stringify({ request_id: request.request_id, availableModels: [{ modelId: 'fixture-fast', name: 'Fast fixture', isDefault: true }, { modelId: 'fixture-large', name: 'Large fixture' }] }) + '\n')
  })
  await new Promise(resolve => lines.on('close', resolve))
  process.exit(0)
}
const app = agent({ name: 'kode-acp-fixture' })
const sessionId = 'same-native-session', clients = new Map(), pending = new Map()
const modes = { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }] }
const configOptions = [{ id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'fixture-fast', options: [{ value: 'fixture-fast', name: 'Fast fixture' }, { value: 'fixture-large', name: 'Large fixture' }] }, { id: 'effort', category: 'thought_level', name: 'Effort', type: 'select', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }]
const record = async (method, params) => { if (process.env.KODE_ACP_FIXTURE_LOG) await appendFile(process.env.KODE_ACP_FIXTURE_LOG, JSON.stringify({ method, params, label: process.env.KODE_ACP_FIXTURE_LABEL }) + '\n') }
app.onRequest('initialize', async ({ params }) => { await record('initialize', params); return { protocolVersion: 1, agentCapabilities: { loadSession: process.env.KODE_ACP_NO_RESUME !== '1', promptCapabilities: { image: process.env.KODE_ACP_IMAGES === '1' } }, agentInfo: { name: 'Fixture', version: '1' }, authMethods: [] } })
async function configureServers(params) {
  for (const spec of params.mcpServers) {
    const client = new Client({ name: 'fixture-acp-agent', version: '1' })
    await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...process.env, ...Object.fromEntries(spec.env.map(v => [v.name, v.value])) }, stderr: 'pipe' }))
    clients.set(spec.name, client)
    await client.listTools()
  }
}
const availableCommands = [{ name: 'fixture-command', description: 'Native fixture command', input: { hint: 'message' } }, { name: 'fixture:skill', description: 'Workspace skill', input: { hint: 'task' }, _meta: { type: 'skill' } }]
const announceCommands = client => client.notify('session/update', { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands } })
app.onRequest('session/new', async ({ params, client }) => { await record('session/new', params); await configureServers(params); if(process.env.KODE_ACP_LATE_COMMANDS==='1')setTimeout(()=>void announceCommands(client),20);else await announceCommands(client); return { sessionId, modes, configOptions } })
app.onRequest('session/load', async ({ params, client }) => {
  await record('session/load', params); await configureServers(params)
  await client.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAY MUST NOT REAPPEAR' } } })
  await announceCommands(client)
  return { modes, configOptions }
})
app.onRequest('session/set_mode', async ({ params }) => { await record('session/set_mode', params); modes.currentModeId = params.modeId; return {} })
app.onRequest('session/set_config_option', async ({ params }) => { await record('session/set_config_option', params); configOptions.find(option => option.id === params.configId).currentValue = params.value; return { configOptions } })
app.onNotification('session/cancel', ({ params }) => pending.get(params.sessionId)?.())
app.onRequest('session/prompt', async ({ params, client, signal }) => {
  await record('session/prompt', params)
  const text = params.prompt[0]?.text ?? ''
  if (text.includes('WAIT')) { await new Promise(resolve => { pending.set(params.sessionId, resolve); signal.addEventListener('abort', resolve, { once: true }) }); return { stopReason: 'cancelled' } }
  if (text.includes('APPROVAL')) {
    const toolCall = { toolCallId: 'operation', title: 'Fixture command', kind: 'execute', rawInput: { command: 'fixture operation' }, status: 'pending' }
    await client.notify('session/update', { sessionId, update: { ...toolCall, sessionUpdate: 'tool_call' } })
    const decision = await client.request('session/request_permission', { sessionId, toolCall, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }] })
    await record('permission-result', decision)
    await client.notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'operation', status: decision.outcome.optionId === 'allow' ? 'completed' : 'failed' } })
  }
  const target = text.match(/KODE_TEST_SEND ([A-Za-z0-9_.:-]+)\/([A-Za-z0-9_.:-]+)/)
  if (text.includes('TOOL') || target) {
    const action = target ? { name: 'kode_sessions_send', arguments: { node_id: target[1], session_id: target[2], content: 'KODE_TEST_REQUEST Confirm this native ACP message.', idempotency_key: 'native-acp-fixture-' + createHash('sha256').update(text).digest('hex').slice(0, 32) } } : { name: 'kode_sessions_list', arguments: {} }
    const result = await clients.get('kode').callTool(action)
    await record('tool-result', result)
  }
  await client.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${process.env.KODE_ACP_FIXTURE_LABEL ?? 'acp'}: ${text}` } } })
  return { stopReason: 'end_turn' }
})
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
connection.closed.then(async () => { for (const client of clients.values()) await client.close() })
