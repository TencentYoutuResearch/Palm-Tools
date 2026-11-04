/** Resolve persisted backend identities without inferring a protocol from a name. */
export function savedSessionProfile(profiles, tab) {
  const configured = profiles?.list() ?? []
  const bound = id => Object.values(profiles?.bindings ?? {}).find(row => row.threadId === tab.session_id && row.profile.id === id)?.profile
  if (tab.agent_id) return configured.find(row => row.id === tab.agent_id) ?? bound(tab.agent_id)
  const ids = Object.entries(profiles?.sharedState?.desktop_ids ?? {}).filter(([, backend]) => backend === tab.backend_key).map(([id]) => id)
  const mapped = configured.filter(row => ids.includes(row.id))
  if (mapped.length) return mapped.length === 1 ? mapped[0] : undefined
  const exact = configured.find(row => row.id === tab.backend_key)
    ?? configured.find(row => row.id === `kode-${tab.backend_key}`)
  if (exact) return exact
  const named = configured.filter(row => row.name.toLocaleLowerCase() === tab.backend_key.toLocaleLowerCase())
  return named.length === 1 ? named[0] : undefined
}
