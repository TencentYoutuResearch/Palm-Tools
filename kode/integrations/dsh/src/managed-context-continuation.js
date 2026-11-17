/** Pre-admission durable checkpoint. No model, admission, quota release or permission mutation. */
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { contextScope, projectManagedContext, recallManagedContext, resolveContextReceipt, CONTEXT_TARGET_BYTES, contextBytes, assertManagedContext, contextDigest } from './managed-context-projection.js'
async function persist(runtime, agent) {
  const sessions = runtime.ctx.get?.('sessions') ?? runtime.ctx.sessions
  if (typeof sessions?.flush !== 'function' || await sessions.flush(agent.session) !== true) throw Error('Context checkpoint persistence unavailable')
}
export async function prepareContextContinuation(runtime, agent, binding, options, assertOwner) {
  assertManagedContext(options, false)
  if (contextBytes(options) <= CONTEXT_TARGET_BYTES) return { options, proof: null }
  await assertOwner()
  await persist(runtime, agent)
  const scope = contextScope(runtime.host, agent, binding), events = agent.session.snapshotEvents(0)
  const { messages, proof } = projectManagedContext({ ...options, scope, events })
  if (proof) {
    if (!events.some(e => e.type === 'plugin:kode/context-projection' && e.data?.checkpoint_sha256 === proof.checkpoint_sha256)) {
      appendPluginRecord(agent.session, 'plugin:kode/context-projection', proof)
    }
    await persist(runtime, agent)
  }
  await assertOwner()
  return { options: { ...options, messages }, proof }
}
export async function executeContextRecall(runtime, agent, binding, args, assertOwner) {
  await assertOwner()
  const result = recallManagedContext(contextScope(runtime.host, agent, binding), agent.session.snapshotEvents(0), args)
  await assertOwner()
  return result
}

/** Separate Host audit linkage, not an extension of the Home billing/provenance schema. */
export async function bindContextCall(runtime, agent, binding, options, proof, callId, assertOwner) {
  await assertOwner()
  const observed = { version: 1, phase: 'prepared_before_admission', call_id: callId, scope_sha256: contextDigest(contextScope(runtime.host, agent, binding)),
    input_sha256: contextDigest({ messages: options.messages, tools: options.tools }), input_bytes: assertManagedContext(options),
    checkpoint_sha256: proof?.checkpoint_sha256 ?? null, original_sha256: proof?.original_sha256 ?? null,
    source: 'host_pre_admission_payload', home_projection_validation: false }
  appendPluginRecord(agent.session, 'plugin:kode/context-call-binding', observed)
  await persist(runtime, agent)
  await assertOwner()
  return Object.freeze(observed)
}
export function assertContextCallInput(proof, options) {
  if (!proof || proof.input_sha256 !== contextDigest({ messages: options.messages, tools: options.tools })
      || proof.input_bytes !== assertManagedContext(options)) throw Error('Managed context changed after pre-admission attestation')
}

/** Called only by the scoped grant policy. A valid shape is not a receipt authority.
 * Unknown receipts, other task scopes and corrupt provenance remain grant denials.
 */
export function authorizeContextRecall(runtime, agent, args) {
  try {
    const binding = runtime.profiles.binding(agent.id)
    resolveContextReceipt(contextScope(runtime.host, agent, binding), agent.session.snapshotEvents(0), args.receipt_sha256)
    return true
  } catch { return false }
}
