/** Read cached public route metadata only; never invoke model discovery or settings export. */
export function officialResourceDirectory(llm) {
  if (!llm?.listProviders) return { status: 'unavailable', items: [] }
  const routes = new Map()
  try {
    for (const item of llm.listConfigurableProviders?.() ?? []) {
      if (typeof item.provider !== 'string' || !item.provider || item.provider.startsWith('kode-agent-')) continue
      routes.set(item.provider, { provider_id: item.provider, name: item.displayName ?? item.provider, registered: false })
    }
    for (const item of llm.listProviders()) {
      if (typeof item.id !== 'string' || !item.id || item.id.startsWith('kode-agent-')) continue
      routes.set(item.id, { provider_id: item.id, name: item.name ?? item.id, registered: true })
    }
    return { status: llm.listConfigurableProviders ? 'registered_and_declared' : 'registered_only', items: [...routes.values()] }
  } catch { return { status: 'unavailable', items: [] } }
}
