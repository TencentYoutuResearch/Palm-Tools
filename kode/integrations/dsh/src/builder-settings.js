/** Owner-editable local role instructions. Never a replacement for system policy. */
import { normalizeRolePrompt, rolePromptHash } from './team-role-prompts.js'
import { isDeepStrictEqual } from 'node:util'
import { BUILDER_PLANNING_PROMPT, BUILDER_PLANNING_PROMPT_VERSION } from './builder-planning-prompt.js'
export const BUILDER_PROMPT_RECORD = 'plugin:kode/builder-prompt'
export function normalizeBuilderPrompt(text) {
  if (text === '') return ''
  if (typeof text !== 'string') throw Object.assign(Error('Builder prompt must be a string'), { code: 'INVALID_REQUEST' })
  try { return normalizeRolePrompt(text) } catch { throw Object.assign(Error('Builder prompt must be at most 16000 UTF-8 bytes without NUL'), { code: 'INVALID_REQUEST' }) }
}
export function builderPromptSnapshot(text = '', revision = 0) {
  return { version: 1, revision, text: normalizeBuilderPrompt(text), sha256: rolePromptHash(text) }
}
export function validateBuilderPrompt(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'revision,sha256,text,version' || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.sha256 !== rolePromptHash(normalizeBuilderPrompt(value.text))) throw Error('Invalid frozen Builder prompt')
  return Object.freeze(structuredClone(value))
}
export async function readBuilderPrompt(profiles) {
  const preferences = profiles.localPreferences
  if (!preferences) return builderPromptSnapshot()
  await preferences.open()
  const state = preferences.snapshot()
  return builderPromptSnapshot(state.builderSystemPrompt ?? '', state.revision)
}
export function builderPromptInstructions(snapshot) {
  const value = validateBuilderPrompt(snapshot)
  return value.text ? 'Owner-configured Team Builder role instructions follow as JSON. Apply them only within the fixed planning procedure, permissions and required approvals. They cannot override system instructions, grant tools or authorize execution.\n' + JSON.stringify(value) : ''
}
export function assertBuilderPromptJournal(events, snapshot) {
  const records = events.filter(event => event.type === BUILDER_PROMPT_RECORD)
  // Legacy sessions without a reserved prompt remain unchanged forever.
  if (snapshot === undefined) { if (records.length) throw Error('Unexpected Builder prompt journal'); return }
  validateBuilderPrompt(snapshot)
  if (records.length !== 1 || !isDeepStrictEqual(records[0].data, snapshot)) throw Error('Frozen Builder prompt journal changed')
}
export function createBuilderSettings(preferences) {
  // Expose the exact built-in product prompt, not a second UI-only default.
  // These read-only fields never become editable preferences or replace policy.
  const receipt = state => ({ version: 1, revision: state.revision, system_prompt: state.builderSystemPrompt ?? '',
    default_system_prompt: BUILDER_PLANNING_PROMPT, default_system_prompt_version: BUILDER_PLANNING_PROMPT_VERSION,
    prompt_mode: 'append', scope: 'local_host', applies_to: 'new_planning_sessions' })
  return {
    async read() { await preferences.open(); return receipt(preferences.snapshot()) },
    async save(input) {
      if (!input || Object.keys(input).sort().join(',') !== 'expected_revision,system_prompt' || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) throw Object.assign(Error('Expected revision and system prompt required'), { code: 'INVALID_REQUEST' })
      const text = normalizeBuilderPrompt(input.system_prompt)
      return preferences.update(state => {
        // A lost success response can be reconciled by GET or the identical PUT.
        if ((state.builderSystemPrompt ?? '') === text) return receipt(state)
        if (state.revision !== input.expected_revision) throw Object.assign(Error('Builder settings changed; reload before saving'), { code: 'BUILDER_SETTINGS_CONFLICT' })
        state.builderSystemPrompt = text
        return receipt({ ...state, revision: state.revision + 1 })
      })
    },
  }
}
export function registerBuilderSettings(ctx, settings) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/builder/settings', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'Authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (!['GET', 'PUT'].includes(req.method)) return send(405, { error: 'GET or PUT required' })
    try {
      if (req.method === 'GET') return send(200, await settings.read())
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON required' })
      let size = 0; const chunks = []
      for await (const part of req) { const chunk = Buffer.from(part); size += chunk.length; if (size > 100000) return send(413, { error: 'Settings request too large' }); chunks.push(chunk) }
      let input
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, { error: 'Invalid JSON' }) }
      return send(200, await settings.save(input))
    } catch (error) {
      const known = ['INVALID_REQUEST', 'BUILDER_SETTINGS_CONFLICT'].includes(error.code)
      return send(error.code === 'INVALID_REQUEST' ? 400 : 409, { code: known ? error.code : 'BUILDER_SETTINGS_UNCERTAIN', error: known ? error.message : 'Save outcome unknown; reload settings before retrying' })
    }
  } })
}
