/** Local OpenAI-compatible fixture. No external inference, credentials, or repository reads. */
import http from 'node:http'
const requests = []
const server = http.createServer(async (req, res) => {
  if (req.url === '/requests') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(requests)); return }
  let text = ''; for await (const chunk of req) text += chunk
  const input = JSON.parse(text || '{}'); requests.push(input)
  const base = { id: `fixture-${requests.length}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture' }
  const answer = 'Fixture response: session input received.'
  const messageText = m => typeof m?.content === 'string' ? m.content : (m?.content ?? []).map(c => c.text ?? '').join('\n')
  // dsh can append a clock/time-zone user context after a resumed input. Match
  // the fixture conversation input rather than mistaking that context for it.
  const users = [...(input.messages ?? [])].reverse().filter(m => m.role === 'user')
  const content = messageText(users.find(m => /KODE_TEST_|Kode session message/.test(messageText(m))) ?? users[0])
  let action
  if (input.messages?.at(-1)?.role !== 'tool') {
    const send = content.match(/KODE_TEST_SEND ([A-Za-z0-9_.:-]+)\/([A-Za-z0-9_.:-]+)/)
    const incoming = content.match(/Kode session message ([A-Za-z0-9-]+) from ([A-Za-z0-9_.:-]+)\/([A-Za-z0-9_.:-]+):/)
    if (send) action = { name: 'kode_sessions_send', arguments: { node_id: send[1], session_id: send[2], content: 'KODE_TEST_REQUEST Please confirm this SSH message.', idempotency_key: 'fixture-send-' + requests.length } }
    else if (incoming && content.includes('KODE_TEST_REQUEST')) action = { name: 'kode_sessions_send', arguments: { node_id: incoming[2], session_id: incoming[3], content: 'SSH message confirmed by remote agent.', idempotency_key: 'fixture-reply-' + incoming[1], in_reply_to: incoming[1] } }
    else if (content.includes('KODE_TEST_LIST')) action = { name: 'kode_sessions_list', arguments: {} }
  }
  const delta = action ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + requests.length, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.arguments) } }] } : { role: 'assistant', content: answer }
  if (input.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const choices of [[{ index: 0, delta, finish_reason: null }], [{ index: 0, delta: {}, finish_reason: action ? 'tool_calls' : 'stop' }]]) res.write(`data: ${JSON.stringify({ ...base, choices })}\n\n`)
    res.end('data: [DONE]\n\n')
  } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })) }
})
server.listen(Number(process.env.KODE_FIXTURE_PORT ?? 47973), '127.0.0.1', () => console.log(`Fixture model ${server.address().port}`))
