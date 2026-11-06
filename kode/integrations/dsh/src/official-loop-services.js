import { symbols } from '@deepseek-ai/cordis'
/** AgentLoop service view. Serial tool calls use ToolRuntime's complete public pipeline.
 * The scheduler symbol is an upstream internal contract: keep real-loop compatibility tests.
 * No root service is replaced, and missing controlled ownership never falls back to raw calls.
 */
import { createRequire } from 'node:module'
// Resolve the symbol from the loop's own dependency instance (linked packages may differ).
const loopRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { TOOL_RUNTIME_SCHEDULER } = await import(loopRequire.resolve('@deepseek-ai/dsh-tools'))
const view = (service, overrides) => new Proxy({}, {
  get(target, key) {
    if (Object.hasOwn(overrides, key)) return overrides[key]
    if (typeof key === 'symbol') return undefined
    const value = Reflect.get(service, key, service)
    return typeof value === 'function' ? value.bind(service) : value
  },
})
export function officialLoopServices(ctx, resolveRun) {
  const rawTools = ctx.tools[symbols.original] ?? ctx.tools
  const runtimeSchedulers = Reflect.ownKeys(rawTools).filter(key => typeof key === 'symbol' && key.description === TOOL_RUNTIME_SCHEDULER.description)
  if (runtimeSchedulers.length > 1) throw Error('Ambiguous official tool scheduler protocol')
  const schedulerSymbol = runtimeSchedulers[0] ?? TOOL_RUNTIME_SCHEDULER
  const owned = agent => {
    const run = resolveRun(agent)
    if (!run) throw new Error('Controlled official loop execution unavailable')
    return run
  }
  const completed = new WeakMap()
  const scheduler = Object.freeze({
    async prepare(request) {
      // Complete pre/body/post/finalization in order through the public API. Declaring
      // exclusive mode prevents the outer scheduler from overlapping these transactions.
      const result = await owned(request.agent).execute(request)
      completed.set(request, result)
      return { kind: 'final-result', exec: request, result }
    },
    finish(request, result) {
      if (!completed.has(request) || completed.get(request) !== result) throw new Error('Official tool completion identity mismatch')
      completed.delete(request)
      return result
    },
    dispatch() { throw new Error('Official serial scheduler has no deferred dispatch') },
    finalize() { throw new Error('Official serial scheduler already finalized its result') },
  })
  return {
    llm: view(ctx.llm, {
      prepareCall: (...args) => owned(ctx.agents.requireInitiator()).prepareCall(...args),
      stream: options => owned(ctx.agents.requireInitiator()).stream(options),
    }),
    tools: view(ctx.tools, {
      forScope: scope => scope.reflect.trace(rawTools),
      executionMode: () => ({ kind: 'exclusive' }),
      [schedulerSymbol]: scheduler,
    }),
  }
}
