import { defaultBuilderQuestionnaire } from './builder-interview.js'
/** Initial owner interview only; free-text preferences never create execution authority. */
export function registerBuilderCreate(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/builder/create-draft', handler: async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'POST') return send(405, { error: 'POST required' })
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON required' })
    if (!config?.backendClient) return send(503, { error: 'Builder unavailable' })
    let input
    try {
      let bytes = 0; const chunks = []
      for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > 16384) return send(413, { error: 'Draft too large' }); chunks.push(chunk) }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch { return send(400, { error: 'Invalid JSON' }) }
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
    if (!input || Object.keys(input).some(key => !['draft_id', 'request_id', 'purpose'].includes(key)) || !valid(input.draft_id) || !valid(input.request_id)
      || typeof input.purpose !== 'string' || !input.purpose.trim() || input.purpose.includes('\0') || Buffer.byteLength(input.purpose) > 8192) return send(400, { error: 'Invalid draft' })
    const questionnaire = defaultBuilderQuestionnaire()
    const questions = questionnaire.questions.filter(question => !question.when_answer).slice(0, 3).map(({ id, prompt }) => ({ id, prompt }))
    try {
      // A retry must preserve the interview version chosen by its original creation.
      const previous = await config.backendClient.call(`/api/v1/messaging/superagents/drafts/${encodeURIComponent(input.draft_id)}/commands/${encodeURIComponent(input.request_id)}`)
      if (previous.receipt) {
        const saved = previous.receipt
        if (saved.id !== input.draft_id || saved.request_id !== input.request_id || saved.revision !== 1 || saved.interview?.purpose !== input.purpose || saved.eligible_for_execution !== false) throw Error('Creation identity conflict')
        return send(200, saved)
      }
      if (previous.receipt !== null) throw Error('Unknown creation outcome')
      return send(200, await config.backendClient.call('/api/v1/messaging/superagents/drafts', { id: input.draft_id, request_id: input.request_id, expected_revision: 0, revoked: false,
        interview: { purpose: input.purpose, workspace_refs: [], answers: {}, questions, questionnaire, proposed_team: null } }))
    } catch { return send(409, { error: 'Draft creation not confirmed; retry the exact request', retry: 'same_request' }) }
  } })
}
