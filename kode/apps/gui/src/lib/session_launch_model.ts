type ModelCatalogue = { models: Array<{ id: string }> }

function modelIdentity(model: string): string {
  return model.trim().toLowerCase()
    .replace(/^anthropic\./, '')
    .replace(/^claude-/, '')
    .replace(/\[1m\]$/, '')
    .replace(/-1m$/, '')
    .replace(/-ioa$/, '')
    .replace(/(\d)-(?=\d)/g, '$1.')
}

export async function resolveSessionLaunchModel(
  backendKey: string,
  model: string | null | undefined,
  discover: () => Promise<ModelCatalogue>,
): Promise<string | null> {
  if (!model || model === 'auto') return null
  if (backendKey !== 'tclaude') return model
  const { models } = await discover()
  if (models.some((entry) => entry.id === model)) return model
  const matches = models.filter((entry) => modelIdentity(entry.id) === modelIdentity(model))
  const ids = [...new Set(matches.map((entry) => entry.id))]
  if (ids.length === 1) return ids[0]
  throw new Error(ids.length > 1
    ? `Model "${model}" matches multiple tclaude launch IDs; select an exact model.`
    : `Model "${model}" is unavailable in the current tclaude catalogue; select an available model.`)
}
