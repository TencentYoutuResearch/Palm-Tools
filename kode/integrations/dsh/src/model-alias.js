/** Resolve only identities or unique advertised labels; never guess another model. */
export function resolveAdvertisedModel(models, requested) {
  const exact = models.find(m => (m.id ?? m.modelId ?? m.value) === requested)
  if (exact) return exact.id ?? exact.modelId ?? exact.value
  const normalize = value => String(value ?? '').trim().toLocaleLowerCase()
  const wanted = normalize(requested)
  const matches = models.filter(m => [m.id, m.modelId, m.value, m.name, m.displayName].some(value => value != null && normalize(value) === wanted))
  if (matches.length === 1) return matches[0].id ?? matches[0].modelId ?? matches[0].value
  throw new Error(matches.length ? '模型名称对应多个选项，请选择完整模型标识。' : '此 Agent 未公布该模型，请从模型列表重新选择。')
}

/** Resolve one advertised new-session default, including both Fast transports. */
export function resolveDefaultSelection(models, preference, fallbackModel) {
  const requested = preference?.model ?? fallbackModel ?? models.find(row => row.isDefault)?.id ?? models[0]?.id
  if (!requested) throw new Error('此 Agent 未返回可用模型。')
  let model = resolveAdvertisedModel(models, requested), selected = models.find(row => row.id === model)
  const fast = preference?.fast
  if (fast !== undefined) {
    if (typeof fast !== 'boolean') throw new Error('Fast 必须是布尔值。')
    const capability = selected.fastCapability
    if (!capability) throw new Error('此模型未公布 Fast 模式。')
    if (capability.transport === 'model-variant') {
      model = resolveAdvertisedModel(models, fast ? capability.fastModelId : capability.standardModelId)
      selected = models.find(row => row.id === model)
    }
  }
  if (preference?.reasoningEffort !== undefined && (typeof preference.reasoningEffort !== 'string' || !preference.reasoningEffort.trim())) throw new Error('推理强度无效。')
  const reasoningEffort = preference?.reasoningEffort ?? selected.defaultReasoningEffort
  if (reasoningEffort && !(selected.reasoningEfforts ?? []).some(row => row.id === reasoningEffort)) throw new Error('此模型未公布该推理强度，请重新选择。')
  return { model, ...(reasoningEffort ? { reasoningEffort } : {}), ...(selected.fastCapability ? { fast: fast ?? selected.fastCapability.defaultEnabled ?? false } : {}) }
}
