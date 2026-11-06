/** Runtime routing reports are configuration observations, not provider attestations. */
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/.test(value)
export function codexReroutedSelection(params, { threadId, turnId, model, effort }) {
  if (!bounded(threadId, 256) || !bounded(turnId, 256) || params?.threadId !== threadId || params?.turnId !== turnId) return null
  const requested = model && model !== 'default' ? model : null
  const observed = bounded(params.toModel, 256) ? params.toModel : null
  const mismatch = requested !== null && observed !== null && requested !== observed
  return { threadId, turnId, scope: 'executor_configuration', observed_at: Date.now(),
    model: { requested, observed, status: mismatch ? 'mismatch' : observed === null ? 'unverifiable' : 'reported', source: 'model/rerouted' },
    effort: { requested: effort ?? null, observed: null, status: 'unverifiable', source: null },
    ...(mismatch ? { admission: 'rejected', reason: 'selection_mismatch' } : {}),
  }
}
