/** Context identity contract. No history migration or cross-scope recall is enabled here. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
const keys = ['version', 'home_hub', 'team_id', 'kind', 'scope_id', 'context_epoch']
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const fail = (message, code = 'CONTEXT_SCOPE_INVALID') => Object.assign(Error(message), { code })

export function validateContextScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k))
      || value.version !== 2 || value.context_epoch !== 1
      || !['home_hub', 'team_id', 'scope_id'].every(k => id(value[k]))
      || !['team_private', 'discussion_thread', 'builder_draft'].includes(value.kind)
      || value.kind === 'discussion_thread' && !/^[a-f0-9]{64}$/.test(value.scope_id)) {
    throw fail('Invalid context_scope v2 identity')
  }
  return Object.freeze({ ...value })
}

export function discussionScopeId(surfaceId, threadId) {
  if (!id(surfaceId) || !id(threadId)) throw fail('Invalid discussion context identity')
  return createHash('sha256').update(JSON.stringify([surfaceId, threadId])).digest('hex')
}

export function contextScopeKey(scope) {
  const value = validateContextScope(scope)
  return createHash('sha256').update(JSON.stringify(keys.map(k => value[k]))).digest('hex')
}

/** Missing identity denotes existing shared history, never a new isolated runtime. */
export function contextIsolation(scope) {
  return scope === undefined ? 'legacy_shared' : (validateContextScope(scope), 'scoped_v2')
}

/** Until Hub controls, journal ownership and tool reads are scoped, never downgrade v2.
 * This is deliberately not a feature flag: client-supplied claims cannot enable it.
 */
export function assertLegacyCoordinatorContext(...records) {
  for (const record of records) {
    if (record && Object.hasOwn(record, 'context_scope')) {
      validateContextScope(record.context_scope)
      throw fail('Scoped Coordinator runtime is not supported by this control protocol', 'CONTEXT_SCOPE_UNSUPPORTED')
    }
  }
  return 'legacy_shared'
}

/** Future journal admission contract, not a filter and not a grant source.
 * Caller must supply authoritative journal ownership, never labels from model input.
 * Reject the entire batch before provider dispatch; never silently drop tool pairs.
 */
export function assertScopedHistory(scope, journal) {
  validateContextScope(scope)
  if (!journal || !Array.isArray(journal.messages) || !Array.isArray(journal.toolHistory)
      || journal.seeded || journal.parent_session_id != null || journal.inherited_session_id != null
      || !isDeepStrictEqual(journal.context_scope, scope)) throw fail('Context history ownership mismatch')
  for (const row of [...journal.messages, ...journal.toolHistory]) {
    if (!row || !isDeepStrictEqual(row.context_scope, scope)) throw fail('Foreign or unscoped context history')
  }
  return journal
}
