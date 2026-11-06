/** Controlled official call entry: preserve the public LLM pipeline and propagate lease abort. */
import { meterOfficialCall } from './official-call-meter.js'
export async function* streamLeasedOfficialCall(llm, options, lease, policy) {
  if (!lease?.signal || typeof lease.assertActive !== 'function') throw new Error('Official execution lease required')
  const signal = options.signal ? AbortSignal.any([options.signal, lease.signal]) : lease.signal
  const scoped = { ...options, signal }
  yield* meterOfficialCall(scoped, () => llm.stream(scoped), {
    ...policy,
    admit: async identity => {
      signal.throwIfAborted()
      await lease.assertActive()
      await policy.admit(identity)
      // A begin acknowledgement is evidence, not a new lease grant.
      try {
        await lease.assertActive()
        signal.throwIfAborted()
      } catch (error) {
        await policy.record({ ...identity, event_id: `${identity.call_id}:admission-interrupted`, kind: 'interrupted', usage: { status: 'unverifiable', reason: 'lease_lost_before_dispatch' } })
        throw error
      }
    },
  })
}
