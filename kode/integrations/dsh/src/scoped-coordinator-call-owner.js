/** Host-owned composition of the original lease, selection and call ledgers.
 * This is not a runtime readiness authority. No routes or credentials are added.
 * An independent transport is constructed here; parent LLM services/closures are
 * never accepted. installAdapters is trusted Host wiring for existing providers.
 */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { isDeepStrictEqual } from 'node:util'
import { acquireOperationLease } from './operation-lease.js'
import { OfficialCallOutbox } from './official-call-outbox.js'
import { SelectionOutbox } from './selection-outbox.js'
import { createScopedCoordinatorModel } from './scoped-coordinator-model.js'
import { contextScopeKey } from './context-scope.js'
import { snapshotProviderRequest } from './scoped-provider-transport.js'
import { conversationRequestEvidence } from './scoped-conversation-request.js'
const fail = message => Object.assign(Error(message), { code: 'SCOPED_CALL_OWNER_REJECTED' })

export async function createScopedCoordinatorCallOwner({ authority, operation, worker, route,
  profileRevision, profiles, client, installAdapters, resolveLeaseAdmission, resolveAdmission, inputIds = [] }) {
  authority = structuredClone(authority); operation = structuredClone(operation)
  worker = structuredClone(worker); route = structuredClone(route); inputIds = structuredClone(inputIds)
  if (authority?.context_key !== contextScopeKey(authority?.context_scope)
    || authority.session_id !== `context-${authority.context_key}` || authority.operation_id !== operation?.id
    || worker?.session_id !== authority.session_id || worker.node_id !== authority.context_scope.home_hub
    || ![operation.attempt, operation.epoch].every(n => Number.isSafeInteger(n) && n > 0)
    || typeof installAdapters !== 'function' || typeof resolveAdmission !== 'function' || typeof resolveLeaseAdmission !== 'function'
    || typeof client?.call !== 'function' || typeof profiles?.update !== 'function'
    || !Array.isArray(inputIds) || inputIds.some(id => typeof id !== 'string' || !id)) throw fail('Exact Host-owned scope, accounting and provider dependencies required')
  const session = authority.session_id, binding = profiles.binding(session)
  if (!isDeepStrictEqual(binding?.managedOperation, operation) || binding.revision !== profileRevision) throw fail('Accounting store differs from scoped operation')
  const ctx = new Context(), stop = new AbortController()
  let lease, prepared, preparedEvidence, preparedScopedCall, selectionPolicy, disposed = false, fenced = false, active = 0, drained, closeTask
  const fence = error => { fenced = true; stop.abort(error); lease?.dispose() }
  const selections = new SelectionOutbox(client, profiles), calls = new OfficialCallOutbox(client, profiles)
  const check = async () => {
    stop.signal.throwIfAborted()
    const current = await resolveAdmission()
    if (current?.runtime_ready !== true || current.dispatch_allowed !== true || current.stage !== 'runtime'
      || !isDeepStrictEqual(current.authority, authority)) throw fail('Trusted scoped runtime admission unavailable')
    const currentBinding = profiles.binding(session)
    if (!isDeepStrictEqual(currentBinding?.managedOperation, operation) || currentBinding.revision !== profileRevision) throw fail('Scoped operation binding changed')
  }
  const checkClaim = async () => {
    stop.signal.throwIfAborted()
    const current = await resolveLeaseAdmission()
    if (current?.claim_allowed !== true || !isDeepStrictEqual(current.authority, authority)) throw fail('Trusted scoped lease claim admission unavailable')
    const currentBinding = profiles.binding(session)
    if (!isDeepStrictEqual(currentBinding?.managedOperation, operation) || currentBinding.revision !== profileRevision) throw fail('Scoped operation binding changed before claim')
  }
  try {
    await ctx.plugin(LlmRuntime)
    // Registration only: no parent Context, tools, prompts, registry or history.
    await installAdapters(Object.freeze({ registerAdapter: (...args) => ctx.llm.registerAdapter(...args) }))
  } catch (error) { await ctx.fiber.dispose(); throw error }
  const prepareLease = async () => {
      if (lease) await check(); else await checkClaim()
      prepared = await ctx.llm.prepareCall(route, stop.signal)
      if (!isDeepStrictEqual(prepared.config, route)) throw fail('Original provider prepared a different model route')
      if (!lease) lease = await acquireOperationLease(client, operation, worker, { signal: stop.signal,
        beforeClaim: async policy => {
          await checkClaim()
          if (policy?.scope !== 'executor_configuration' || policy.profile_revision !== profileRevision
            || policy.model !== route.model || (policy.effort ?? null) !== (route.reasoningEffort ?? null)) throw fail('Operation selection policy differs from exact prepared route')
          selectionPolicy = structuredClone(policy)
          return true
        } })
      await check(); await lease.assertActive()
      if (!selectionPolicy) throw fail('Operation has no explicit selection policy')
  }
  const model = createScopedCoordinatorModel({ authority, resolveAuthority: resolveAdmission,
    acquirePermit: async () => {
      await check(); await lease.assertActive()
      const provenance = { schema_version: 1, source: 'official_prepared_input', system_sha256: preparedEvidence.system_sha256,
        system_messages: preparedEvidence.system_messages, instruction: { role: 'coordinator', version: 'kode.context.conversation.v1', sha256: preparedEvidence.system_sha256 },
        ...(preparedScopedCall ? { scoped_call: preparedScopedCall } : {}) }
      const policy = calls.policy(session, operation, async () => { await check(); await lease.assertActive() }, provenance)
      await selections.record(session, { operation, profile_revision: profileRevision, threadId: session,
        turnId: policy.callId, inputIds, scope: selectionPolicy.scope, observed_at: Date.now(), source: 'official_prepared_call',
        model: { requested: route.model, observed: prepared.config.model, status: 'reported' },
        effort: { requested: route.reasoningEffort ?? null, observed: prepared.config.reasoningEffort ?? null,
          status: route.reasoningEffort === undefined ? 'unverifiable' : 'reported' } })
      selections.assertSettled(session, operation, selectionPolicy)
      return { authority, lease, route, policy }
    }, dispatch: request => prepared.stream(request) })
  return Object.freeze({
    stream(request, callProof) {
      if (disposed || fenced) throw fail('Scoped call owner closed or requires reconciliation')
      if (active) throw fail('Scoped call already active')
      // Reserve before entering the async iterator, so two unstarted streams
      // cannot silently swap their prepared transport.
      const snapshot = snapshotProviderRequest(request)
      if (snapshot.content.sessionId !== session || snapshot.content.provider !== route.provider
        || snapshot.content.model !== route.model || snapshot.content.reasoningEffort !== route.reasoningEffort) throw fail('Request differs from scoped route')
      preparedEvidence = conversationRequestEvidence(request, { sessionId: session, route })
      preparedScopedCall = undefined
      if(callProof!==undefined){
        const {scoped_call,...evidence}=structuredClone(callProof)
        if(!isDeepStrictEqual(evidence,preparedEvidence)||scoped_call?.context_key!==authority.context_key
          ||scoped_call.session_id!==session||scoped_call.journal_id!==authority.journal_id
          ||scoped_call.request_sha256!==preparedEvidence.request_sha256||scoped_call.tools_sha256!==preparedEvidence.tools_sha256)throw fail('Owned call proof differs from actual model request')
        preparedScopedCall=scoped_call
      }
      active++
      const signal = snapshot.signal ? AbortSignal.any([snapshot.signal, stop.signal]) : stop.signal
      const iterator = (async function* () {
        signal.throwIfAborted()
        await prepareLease()
        yield* model({ ...snapshot.content, signal })
      })()
      let completed = false
      const finish = () => { if (!completed) { completed = true; active--; drained?.() } }
      return {
        [Symbol.asyncIterator]() { return this },
        async next(value) { try { const result = await iterator.next(value); if (result.done) finish(); return result } catch (error) { fence(error); finish(); throw error } },
        async return(value) { if (!completed) fence(fail('Scoped call returned before completion')); try { return await iterator.return(value) } finally { finish() } },
        async throw(error) { fence(error); try { return await iterator.throw(error) } finally { finish() } },
      }
    },
    recoverEvidence: () => calls.recover(),
    close() {
      if (closeTask) return closeTask
      disposed = true; stop.abort(fail('Scoped call owner closing')); lease?.dispose()
      closeTask = (async () => {
        // A caller must return/drain its iterator. Never pretend an abandoned
        // provider has stopped, or recycle a context while it is still running.
        if (active) await new Promise(resolve => { drained = resolve })
        await selections.close(); await ctx.fiber.dispose()
      })()
      return closeTask
    },
  })
}
