/** Evidence for the actual already scope-checked provider request, not authority.
 * Hashes exclude transport cancellation and do not persist prompt contents.
 */
import { createHash } from 'node:crypto'
import { snapshotProviderRequest } from './scoped-provider-transport.js'
const fail = message => Object.assign(Error(message), { code: 'SCOPED_CONVERSATION_REQUEST_REJECTED' })
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  throw fail('Non-JSON model content cannot be attested')
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
export function conversationRequestEvidence(raw, { sessionId, route }) {
  const { content } = snapshotProviderRequest(raw)
  const history = content.toolHistory
  const emptyHistory = history === undefined || Array.isArray(history) && history.length === 0
    || history && Object.getPrototypeOf(history) === Object.prototype
      && Object.keys(history).length === 2 && Array.isArray(history.tools) && history.tools.length === 0
      && Array.isArray(history.updates) && history.updates.length === 0
  if (content.sessionId !== sessionId || content.provider !== route.provider || content.model !== route.model
    || content.reasoningEffort !== route.reasoningEffort || !Array.isArray(content.messages)
    || !content.messages.length || content.messages.some(message => !['system', 'developer', 'user', 'assistant'].includes(message?.role))
    || content.tools !== undefined && (!Array.isArray(content.tools) || content.tools.length)
    || !emptyHistory) throw fail('Conversation-only request exceeds its exact route or empty tool profile')
  const systems = content.messages.filter(message => message.role === 'system').map(message => message.content)
  return Object.freeze({ version: 1, source: 'owned_session_provider_request',
    request_sha256: digest({ ...content, tools: [], toolHistory: { tools: [], updates: [] } }),
    tools_sha256: digest([]), system_sha256: digest(systems), system_messages: systems.length })
}
