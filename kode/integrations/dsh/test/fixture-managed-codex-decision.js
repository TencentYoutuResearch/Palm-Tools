/** Unpaid protocol peer. Only its owned HTTP endpoint can be contacted. */
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
if (!existsSync(process.env.CODEX_HOME)) process.exit(1)
const args = process.argv.slice(2), config = new Map()
for (let index = 0; index < args.length; index++) {
  if (args[index] === '-c') {
    const value = args[++index], split = value.indexOf('=')
    config.set(value.slice(0, split), value.slice(split + 1))
  }
}
const mode = process.env.KODE_MANAGED_FIXTURE_MODE
const base = /base_url="([^"]+)"/.exec(config.get('model_providers.kode_workflow'))[1]
const effort = config.has('model_reasoning_effort') ? JSON.parse(config.get('model_reasoning_effort')) : null
let tools, threadId = `managed-${randomUUID()}`, turnId = 'managed-turn'
let responseDrained = false
let reported = { inputTokens: process.env.KODE_MANAGED_FIXTURE_SMALL_USAGE ? 1 : 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: process.env.KODE_MANAGED_FIXTURE_SMALL_USAGE ? 1 : 2 }
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const notify = (method, params) => send({ method, params: { threadId, turnId, ...params } })
const result = (id, value = {}) => send({ id, result: value })
const usage = () => !['no-usage', 'foreign-late-usage', 'foreign-turn-late-usage'].includes(mode)
  && !process.env.KODE_MANAGED_FIXTURE_NO_USAGE && notify('thread/tokenUsage/updated', { tokenUsage: { total: {
  ...reported,
} } })
async function request(method, params, id) {
  if (method === 'initialize') return result(id)
  if (method === 'initialized') return
  if (method === 'thread/start') {
    tools = params.dynamicTools
    const mismatch = mode === 'mismatch' || (mode === 'environment' && process.env.KODE_MANAGED_PARENT_MARKER)
    return result(id, { thread: { id: threadId }, model: mismatch ? 'other' : params.model,
      modelProvider: params.modelProvider, cwd: params.cwd, reasoningEffort: effort,
      activePermissionProfile: { id: params.permissions } })
  }
  if (method === 'turn/start') {
    result(id, { turn: { id: turnId } })
    const body = { model: params.model, tools: tools.map(tool => ({ type: 'function', name: tool.name, parameters: tool.inputSchema })),
      ...(mode === 'provider' ? { fixture_messages: JSON.parse(params.input[0].text) } : {}),
      ...(effort ? { reasoning: { effort } } : {}) }
    if (mode === 'extra-native-tool') body.tools.push({ type: 'custom', name: 'apply_patch', format: { type: 'text' } })
    const response = await fetch(base + '/responses', { method: 'POST', body: JSON.stringify(body) })
    if (mode === 'early-text') {
      usage()
      notify('item/completed', { item: { type: 'agentMessage', text: 'Checked fixture' } })
      notify('turn/completed', { turn: { id: turnId, status: 'completed' } })
    }
    if (mode?.startsWith('early-tool')) send({ id: 100, method: 'item/tool/call', params: { threadId, turnId,
      callId: 'decision-call', tool: tools[0].name, arguments: { path: 'fixture.txt' } } })
    let content = ''
    if (process.env.KODE_MANAGED_FIXTURE_CLOSE_AFTER_TERMINAL === '1') {
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let terminal = false
      while (!terminal) {
        const next = await reader.read()
        if (next.done) break
        content += decoder.decode(next.value, { stream: true })
        if (content.length > 8 * 1024 * 1024) throw new Error('Fixture SSE bound exceeded')
        for (const frame of content.split('\n\n').slice(0, -1)) {
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
          if (data && data !== '[DONE]' && JSON.parse(data).type === 'response.completed') terminal = true
        }
      }
      await reader.cancel()
      if (!terminal) throw new Error('Fixture terminal missing')
    } else content = await response.text()
    responseDrained = true
    if (mode === 'early-text') return
    if (mode?.startsWith('early-tool')) return
    if (!response.ok) return notify('turn/completed', { turn: { id: turnId, status: 'failed' } })
    if (mode === 'provider') {
      const chunks = JSON.parse(content).chunks
      const counters = chunks.find(chunk => chunk.type === 'usage').usage
      reported = { inputTokens: counters.inputTokens + counters.cacheReadTokens + counters.cacheWriteTokens,
        cachedInputTokens: counters.cacheReadTokens, cacheWriteInputTokens: counters.cacheWriteTokens, outputTokens: counters.outputTokens }
      const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')?.block
      if (call) return send({ id: 100, method: 'item/tool/call', params: { threadId, turnId,
        callId: call.id, tool: call.name, arguments: JSON.parse(call.arguments) } })
      usage()
      notify('item/completed', { item: { type: 'agentMessage', text: chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'text').map(chunk => chunk.block.text).join('') } })
      return notify('turn/completed', { turn: { id: turnId, status: 'completed' } })
    }
    if (mode === 'retry') {
      usage()
      const retry = await fetch(base + '/responses', { method: 'POST', body: JSON.stringify(body) })
      await retry.text()
      return notify('turn/completed', { turn: { id: turnId, status: 'failed' } })
    }
    if (['text', 'no-usage', 'late-usage', 'invalid-late-usage', 'foreign-late-usage', 'foreign-turn-late-usage'].includes(mode)) {
      if (mode !== 'late-usage') usage()
      notify('item/completed', { item: { type: 'agentMessage', text: 'Checked fixture' } })
      return notify('turn/completed', { turn: { id: turnId, status: 'completed' } })
    }
    send({ id: 100, method: mode.startsWith('question') ? 'item/tool/requestUserInput' : 'item/tool/call',
      params: { threadId, turnId, callId: 'decision-call', tool: tools[0].name,
        arguments: { path: 'fixture.txt' }, questions: [{ id: 'scope', question: 'Which scope?' }] } })
    return
  }
  if (method === 'turn/interrupt') {
    if (!mode.endsWith('late-usage')) usage()
    result(id)
    notify('turn/completed', { turn: { id: turnId, status: mode === 'early-tool' && !responseDrained ? 'failed' : 'interrupted' } })
  }
}
const input = createInterface({ input: process.stdin })
input.on('close', () => {
  if (process.env.KODE_MANAGED_FIXTURE_FOREIGN_CLOSE) setTimeout(() => send({ method: 'thread/tokenUsage/updated', params: {
    threadId: 'foreign-thread', turnId, tokenUsage: { total: { ...reported } } } }), 25)
  if (['late-usage', 'early-tool-late-usage', 'question-late-usage'].includes(mode)) setTimeout(usage, 25)
  if (mode === 'invalid-late-usage') {
    setTimeout(usage, 10)
    setTimeout(() => notify('thread/tokenUsage/updated', { tokenUsage: { total: {
      inputTokens: '10', cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2,
    } } }), 25)
  }
  if (mode === 'foreign-late-usage') setTimeout(() => send({ method: 'thread/tokenUsage/updated', params: {
    threadId: 'foreign-thread', turnId, tokenUsage: { total: { ...reported } } } }), 25)
  if (mode === 'foreign-turn-late-usage') setTimeout(() => send({ method: 'thread/tokenUsage/updated', params: {
    threadId, turnId: 'foreign-turn', tokenUsage: { total: { ...reported } } } }), 25)
})
input.on('line', line => {
  const value = JSON.parse(line)
  void request(value.method, value.params, value.id).catch(() => process.exit(1))
})
