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
