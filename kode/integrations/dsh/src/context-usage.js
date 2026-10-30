/** Use the latest native context sample, never lifetime token billing totals. */
import { z } from 'zod'
export function nativeContextUsage(event, previous = {}) {
  const native = event.type === 'plugin:kode/native-event' ? event.data?.event : undefined
  if (!native) return
  const coordinate = Number.isSafeInteger(event.seq) ? { seq: event.seq } : {}
  if (native.method === 'thread/compacted' || native.method === 'item/completed' && native.params?.item?.type === 'contextCompaction') return { ...(previous.total ? { total: previous.total } : {}), awaitingSample: true, ...coordinate }
  let used, total
  if (native.method === 'thread/tokenUsage/updated') {
    const usage = native.params?.tokenUsage
    used = usage?.last?.totalTokens ?? usage?.last?.inputTokens
    total = usage?.modelContextWindow
  } else {
    const update = native.params?.update
    if (update?.sessionUpdate !== 'usage_update') return
    used = update.used; total = update.size
  }
  if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(total) || total <= 0) return
  return { used, total, ...coordinate }
}
const schema = z.object({ used: z.number().int().nonnegative().optional(), total: z.number().int().positive().optional(), seq: z.number().int().nonnegative().optional(), awaitingSample: z.boolean().optional() })
export const contextUsageProjection = {
  key: 'kodeContextUsage', stateVersion: 2, stateSchema: schema,
  init: () => ({}),
  apply: (state, event) => nativeContextUsage(event, state) ?? state,
  wire: { viewSchema: schema, view: state => state },
}
