/** Owner-entered internal rates; no inference from provider names or budget limits. */
export function proposedTargetPrices(team, values, uuid = () => crypto.randomUUID()) {
  const prices = {}
  for (const [id, value] of Object.entries(values)) {
    const target = team.spec.execution_targets.find(target => target.id === id)
    if (!target || typeof value.enabled !== 'boolean') throw Error('Invalid pricing target')
    if (!value.enabled) continue
    if (typeof value.unit !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.unit)) throw Error('Team budget unit required')
    const rates = {}
    for (const field of ['input_per_million', 'cached_per_million', 'output_per_million']) {
      if (typeof value[field] !== 'string' || !/^\d+$/.test(value[field]) || !Number.isSafeInteger(Number(value[field])) || Number(value[field]) > 4000000000000000) throw Error('Explicit nonnegative internal rates required')
      rates[field] = Number(value[field])
    }
    prices[id] = { id: uuid(), model: target.model_id, model_policy: 'requested_model', unit: value.unit, ...rates }
  }
  return prices
}
