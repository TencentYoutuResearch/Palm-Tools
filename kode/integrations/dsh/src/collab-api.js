/** Owner-only read bridge. Team revisions are configuration, not live execution status. */
import { handleContactDirectory } from './contact-directory-route.js'
export function registerCollabTeams(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/collab/teams', handler: async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (new URL(req.url, 'http://localhost').searchParams.has('view')) {
      if (!config?.backendClient) return send(503, { error: 'Contact backend unavailable' })
      if (await handleContactDirectory(req, res, config.backendClient)) return
    }
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    if (!config?.backendClient) return send(503, { error: 'Team directory unavailable' })
    try {
      const query = new URL(req.url, 'http://localhost').searchParams
      const keys = [...query.keys()]
      if (keys.length !== new Set(keys).size || keys.some(key => !['team_id', 'after', 'limit', 'q'].includes(key))) return send(400, { error: 'Invalid team query' })
      const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
      const id = query.get('team_id')
      if (id !== null) {
        if (!valid(id) || query.has('after') || query.has('limit') || query.has('q')) return send(400, { error: 'Invalid team identity query' })
        const team = await config.backendClient.call(`/api/v1/messaging/teams/${encodeURIComponent(id)}`)
        return send(200, { team, projection: 'configuration_revision' })
      }
      const after = query.get('after') ?? '', limit = query.get('limit') ?? '25'
      const search = query.get('q') ?? ''
      if (Buffer.byteLength(search, 'utf8') > 160 || search.includes('\0')) return send(400, { error: 'Invalid team search' })
      if ((after !== '' && !valid(after)) || !/^[1-9]\d?$/.test(limit) || Number(limit) > 50) return send(400, { error: 'Invalid team cursor' })
      const page = await config.backendClient.call(`/api/v1/messaging/teams?after=${encodeURIComponent(after)}&limit=${limit}${query.has('q') ? '&q=' + encodeURIComponent(search) : ''}`)
      return send(200, { ...page, projection: 'configuration_revision' })
    } catch (error) {
      return send(error?.status === 404 ? 404 : 503, { error: error?.status === 404 ? 'Team directory entry unavailable' : 'Team directory unavailable' })
    }
  } })
}

/** Owner process directory includes terminal work; scheduler discovery is not a history API. */
export function registerCollabRuns(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/collab/runs', handler: async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    if (!config?.backendClient) return send(503, { error: 'Work history unavailable' })
    try {
      const query = new URL(req.url, 'http://localhost').searchParams, keys = [...query.keys()]
      const id = query.get('team_id'), after = query.get('after') ?? '', limit = query.get('limit') ?? '25'
      const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
      if (keys.length !== new Set(keys).size || keys.some(key => !['team_id', 'after', 'limit'].includes(key)) || !valid(id)
        || (after !== '' && !valid(after)) || !/^[1-9]\d?$/.test(limit) || Number(limit) > 50) return send(400, { error: 'Invalid work history query' })
      return send(200, await config.backendClient.call(`/api/v1/messaging/teams/${encodeURIComponent(id)}/work-runs?after=${encodeURIComponent(after)}&limit=${limit}`))
    } catch (error) { return send(error?.status === 404 ? 404 : 503, { error: 'Work history unavailable' }) }
  } })
}

/** Fixed owner read of a currently selected stage output; never an arbitrary observation ID. */
export function registerCollabEvidence(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/collab/evidence', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    if (!config?.backendClient) return send(503, { error: 'Evidence unavailable' })
    const query = new URL(req.url, 'http://localhost').searchParams
    const keys = ['run_id', 'stage_id', 'output']
    if ([...query.keys()].length !== 3 || [...query.keys()].some(key => !keys.includes(key))
      || keys.some(key => query.getAll(key).length !== 1 || !/^[A-Za-z0-9_.:-]{1,160}$/.test(query.get(key)))) return send(400, { error: 'Invalid evidence query' })
    try {
      const [run, stage, output] = keys.map(key => encodeURIComponent(query.get(key)))
      return send(200, await config.backendClient.call(`/api/v1/messaging/work-runs/${run}/stages/${stage}/outputs/${output}`))
    } catch (error) { return send(error?.status === 404 ? 404 : 503, { error: 'Evidence unavailable' }) }
  } })
}
