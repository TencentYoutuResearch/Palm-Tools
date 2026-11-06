/** Process-local dispatch authority; no permit is serialized or exposed to model arguments. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { isDeepStrictEqual } from 'node:util'
import { managedCodexEnabled } from './managed-codex-profile.js'

export class OfficialEntryGuard {
  constructor(ctx, profiles) {
    this.profiles = profiles; this.streams = new WeakMap(); this.toolScope = new AsyncLocalStorage(); this.closed = false
    this.disposers = []
    if (!ctx.on) return // Minimal test/host surfaces have no public execution pipeline.
    const guard = this
    this.disposers.push(ctx.on('llm/stream', (options, next) => (async function* () {
      if (guard.managed(options.sessionId)) {
        const permit = guard.streams.get(options)
        if (guard.closed || !permit || permit.used) throw new Error('Managed official stream requires controlled execution')
        permit.used = true
        await permit.admit()
      }
      yield* next()
    })()))
    this.disposers.push(ctx.on('tools/execute', async (request, next) => {
      if (guard.managed(request.agent?.id)) {
        const permit = guard.toolScope.getStore()
        if (guard.closed || !permit || !permit.active || permit.used || permit.agent !== request.agent || permit.name !== request.name
            || permit.callId !== request.callId || !isDeepStrictEqual(permit.arguments, request.arguments)) {
          throw new Error('Managed official tool requires exact controlled execution')
        }
        permit.used = true
        await permit.admit()
        permit.admitted = true
      }
      return next()
    }))
  }
  managed(id) {
    const binding = id ? this.profiles.binding(id) : undefined
    return Boolean(binding?.managedOperation && (binding.profile.type === 'dsh' || managedCodexEnabled(binding.profile)))
  }
  async *stream(options, next, admit) {
    if (this.closed || this.streams.has(options)) throw new Error('Official stream permit unavailable')
    this.streams.set(options, { used: false, admit })
    try { yield* next() } finally { this.streams.delete(options) }
  }
  execute(request, next, admit) {
    if (this.closed) throw new Error('Official tool permit unavailable')
    const permit = { agent: request.agent, name: request.name, callId: request.callId,
      arguments: structuredClone(request.arguments), used: false, active: true, admitted: false, admit }
    return this.toolScope.run(permit, async () => {
      try { return await next() } finally { permit.active = false }
    })
  }
  assertToolBody(agent, name, args) {
    const permit = this.toolScope.getStore()
    if (this.closed || !permit?.active || !permit.used || !permit.admitted || permit.agent !== agent || permit.name !== name
        || !isDeepStrictEqual(permit.arguments, args)) throw new Error('Assignment tool requires exact controlled tool body')
  }
  close() {
    this.closed = true
    // Keep the deny fence until the owning Cordis scope disposes its listeners.
    // Removing it here would reopen ordinary dispatch for still-bound managed agents.
  }
}
