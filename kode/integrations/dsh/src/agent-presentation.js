/** Native preset names and default marks do not alter executable identities. */
import { AGENT_TYPES } from './agent-profiles.js'
export function profilePresentations(profiles, state = {}) {
  const configured = new Map()
  for (const profile of profiles) if (state.desktop_ids?.[profile.id] === profile.type && AGENT_TYPES[profile.type] && profile.type !== 'custom') configured.set(profile.type, profile.id)
  const rank = new Map(Object.keys(AGENT_TYPES).map((type, index) => [type, index]))
  return profiles.filter(profile => profile.origin !== 'builtin' || !configured.has(profile.type)).map(profile => {
    const builtin = profile.origin === 'builtin' || configured.get(profile.type) === profile.id
    return { ...profile, ...(builtin ? { origin: 'builtin', name: AGENT_TYPES[profile.type]?.name ?? profile.name } : {}), avatar: { id: null, url: `/api/kode/avatars/media?type=${encodeURIComponent(profile.type)}&state=idle` } }
  }).sort((left, right) => Number(right.origin === 'builtin') - Number(left.origin === 'builtin') || (left.origin === 'builtin' ? (rank.get(left.type) ?? 99) - (rank.get(right.type) ?? 99) : 0))
}
