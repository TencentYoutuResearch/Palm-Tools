/** Owner-only versioned edits. Saving never activates or rewrites an in-flight run. */
import { normalizeTeamRolePrompts } from './team-role-prompts.js'
export function registerTeamConfiguration(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/teams/configuration', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(403, { code: 'OWNER_REQUIRED', error: 'Host owner required' })
    if (req.method !== 'POST') return send(405, { code: 'METHOD_NOT_ALLOWED', error: 'POST required' })
    if (!config?.backendClient) return send(503, { code: 'BACKEND_UNAVAILABLE', error: 'Team backend unavailable' })
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { code: 'JSON_REQUIRED', error: 'JSON required' })
    let command
    try {
      let bytes = 0; const chunks = []
      for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > 131072) return send(413, { code: 'CONFIGURATION_INVALID', error: 'Configuration too large' }); chunks.push(chunk) }
      command = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const valid = x => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(x)
      if (!command || Object.keys(command).some(k => !['id', 'request_id', 'expected_revision', 'spec'].includes(k)) || !valid(command.id) || !valid(command.request_id)
        || !Number.isSafeInteger(command.expected_revision) || command.expected_revision < 1 || !command.spec || typeof command.spec !== 'object' || Array.isArray(command.spec)) return send(400, { code: 'CONFIGURATION_INVALID', error: 'Versioned configuration required' })
      command.spec = normalizeTeamRolePrompts(command.spec)
    } catch (error) { return send(400, { error: error.code === 'ROLE_PROMPT_INVALID' ? error.message : 'Invalid configuration', code: error.code === 'ROLE_PROMPT_INVALID' ? error.code : 'CONFIGURATION_INVALID' }) }
    try { return send(200, await config.backendClient.call('/api/v1/messaging/teams', command)) }
    catch { return send(409, { code: 'CONFIGURATION_SAVE_UNCONFIRMED', error: 'Configuration save unconfirmed; retry the same command or reload after resolving a revision conflict', retry: 'same_request' }) }
  } })
}
