/** Owner IM presentation backed by the existing Kode appearance document; never an executor profile. */
import { createHash } from 'node:crypto'
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
export function teamAppearanceKey(home, superagent) {
  return `im:${createHash('sha256').update(JSON.stringify([home, superagent])).digest('hex')}`
}
export function registerCollabAppearance(ctx, { backendClient, appearance }) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/collab/appearance', handler: async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'GET or POST required' })
    if (!backendClient || !appearance) return send(503, { error: 'Team appearance unavailable' })
    try {
      const query = new URL(req.url, 'http://localhost').searchParams
      let input
      if (req.method === 'GET') {
        if ([...query.keys()].length !== new Set(query.keys()).size) return send(400, { error: 'Duplicate appearance query' })
        input = Object.fromEntries(query)
      } else {
        if (query.size || !(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON body required without query' })
        let body = ''; for await (const part of req) { body += part; if (Buffer.byteLength(body) > 4096) return send(413, { error: 'Appearance request too large' }) }
        try { input = JSON.parse(body) } catch { return send(400, { error: 'Invalid appearance request' }) }
      }
      const keys = ['team_id', 'home_hub', 'superagent_id', ...(req.method === 'POST' ? ['avatar_id'] : [])]
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))
          || !['team_id', 'home_hub', 'superagent_id'].every(key => validId(input[key]))
          || (req.method === 'POST' && input.avatar_id !== null && typeof input.avatar_id !== 'string')) return send(400, { error: 'Invalid team appearance identity' })
      const team = await backendClient.call(`/api/v1/messaging/teams/${encodeURIComponent(input.team_id)}`)
      if (team.id !== input.team_id || team.home_hub !== input.home_hub || team.superagent_id !== input.superagent_id
          || team.owner?.kind !== 'human' || team.owner.id !== 'local_owner') return send(409, { error: 'Team appearance identity changed' })
      const key = teamAppearanceKey(team.home_hub, team.superagent_id)
      await appearance.load()
      if (req.method === 'POST') {
        const choice = input.avatar_id === null ? null : (await appearance.gallery()).find(row => row.id === input.avatar_id || row.aliases?.includes(input.avatar_id))
        if (input.avatar_id !== null && !choice) return send(400, { error: 'Selected Kode avatar is unavailable' })
        await appearance.setSession(key, choice?.id ?? null)
      }
      const avatar = appearance.avatarForSession(key, 'custom')
      return send(200, { team_id: team.id, home_hub: team.home_hub, superagent_id: team.superagent_id,
        profile: { id: key, name: team.spec?.name ?? 'Superagent', type: 'custom', avatar: avatar.id ? avatar : { id: null, url: null } } })
    } catch (error) { return send(error?.status === 404 ? 404 : 503, { error: 'Team appearance unavailable' }) }
  } })
}
