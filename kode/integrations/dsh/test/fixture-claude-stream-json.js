// Deterministic SDK executable substitute. No network, tools or real model.
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const send = value => console.log(JSON.stringify(value))
const model = 'fixture-claude', session_id = randomUUID()
if(process.env.KODE_CLAUDE_FIXTURE_LOG)appendFileSync(process.env.KODE_CLAUDE_FIXTURE_LOG,JSON.stringify({type:'fixture-argv',args:process.argv.slice(2)})+'\n')
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line)
  if (process.env.KODE_CLAUDE_FIXTURE_LOG) appendFileSync(process.env.KODE_CLAUDE_FIXTURE_LOG, JSON.stringify(value) + '\n')
  if (value.type === 'control_request') {
    const response = value.request.subtype === 'initialize' ? { commands: [], agents: [], output_style: 'default', available_output_styles: [], models: [{ value: model, displayName: 'Fixture Claude', description: 'Local fixture' }], account: {} } : {}
    send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response } })
  } else if (value.type === 'user') {
    send({ ...value, uuid: value.uuid ?? randomUUID(), session_id })
    const text = JSON.stringify(value.message.content)
    send({ type: 'assistant', uuid: randomUUID(), session_id, parent_tool_use_id: null, message: { id: randomUUID(), type: 'message', role: 'assistant', model, content: [{ type: 'text', text: `fixture: ${text}` }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } })
    send({ type: 'result', subtype: 'success', uuid: randomUUID(), session_id, is_error: false, result: `fixture: ${text}`, duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }, modelUsage: { [model]: { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2, costUSD: 0, contextWindow: 200000, maxOutputTokens: 1000 } }, permission_denials: [] })
  }
}
