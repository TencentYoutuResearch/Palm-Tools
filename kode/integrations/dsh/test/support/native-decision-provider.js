/** Owned Responses peer for real engine protocol tests. It never contacts a model service. */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

export async function nativeDecisionProvider(decide) {
  let sequence = 0
  const errors = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks))
      let messages
      for (const input of body.input ?? []) for (const part of input.content ?? []) {
        if (part.type !== 'input_text') continue
        try { const value = JSON.parse(part.text); if (Array.isArray(value)) messages = value } catch {}
      }
      assert.ok(Array.isArray(messages), 'native decision must receive the original workflow history')
      const decision = await decide({ messages, tools: body.tools, model: body.model, instructions: body.instructions })
      const id = ++sequence
      const item = decision.question
        ? { type: 'function_call', id: `question-${id}`, call_id: `question-call-${id}`, name: 'request_user_input',
          status: 'completed', arguments: JSON.stringify({ questions: decision.question }) }
        : decision.call
          ? { type: 'function_call', id: `function-${id}`, call_id: decision.call.id, name: decision.call.name,
            status: 'completed', arguments: decision.call.arguments }
          : { type: 'message', id: `message-${id}`, role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: decision.text ?? 'Stage evidence published', annotations: [] }] }
      const result = { id: `response-${id}`, object: 'response', created_at: 1, model: body.model, status: 'completed', output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [
        { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: result },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      if (decision.endResponseAfterMs != null) {
        const timer = setTimeout(() => response.end(), decision.endResponseAfterMs)
        response.once('close', () => clearTimeout(timer))
      } else if (!decision.holdResponseOpen) response.end()
    })().catch(error => { errors.push(error.message); response.writeHead(500); response.end('{}') })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { endpoint: `http://127.0.0.1:${server.address().port}/responses`, errors,
    get calls() { return sequence },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
