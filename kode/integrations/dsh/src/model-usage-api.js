/** Owner-only access to the existing CLI history aggregator on the selected Host.
 * Keep credentials server-side and coalesce scans from multiple open chat views. */
export function registerModelUsageApi(ctx, backend) {
  const cache = new Map()
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/model-usage', handler: async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admission = ctx.connection.admit(req)
    if ('rejection' in admission || admission.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    const url = new URL(req.url, 'http://localhost'), period = url.searchParams.get('period') ?? 'today'
    const offsetText = url.searchParams.get('timezone_offset_minutes') ?? '0', offset = Number(offsetText)
    if (!['today', 'month', 'all'].includes(period) || !/^-?\d{1,4}$/.test(offsetText) || !Number.isInteger(offset) || Math.abs(offset) > 1439) return send(400, { error: 'Invalid usage period or timezone' })
    // Use the viewer's calendar boundary for remote Hosts in other timezones.
    const local = new Date(Date.now() + offset * 60000)
    const requestedStart = url.searchParams.get('since_ms')
    if (requestedStart !== null && (!/^\d{1,16}$/.test(requestedStart) || !Number.isSafeInteger(Number(requestedStart)) || Number(requestedStart) > Date.now())) return send(400, { error: 'Invalid usage start time' })
    const requestedEnd = url.searchParams.get('until_ms')
    if (requestedEnd !== null && (!/^\d{1,16}$/.test(requestedEnd) || !Number.isSafeInteger(Number(requestedEnd)) || Number(requestedEnd) > Date.now())) return send(400, { error: 'Invalid usage end time' })
    const until = requestedEnd === null ? Date.now() : Number(requestedEnd)
    let since
    if (requestedStart !== null) since = Number(requestedStart)
    else if (period !== 'all') since = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), period === 'month' ? 1 : local.getUTCDate()) - offset * 60000
    if (since !== undefined && since > until) return send(400, { error: 'Usage start must not exceed end time' })
    const key = `${period}:${offset}:${since ?? ''}:${requestedEnd ?? ''}`
    try {
      let entry = cache.get(key)
      if (!entry || entry.expires < Date.now()) {
        if (cache.size >= 24) cache.delete(cache.keys().next().value)
        entry = { expires: Date.now() + 15000 }
        entry.promise = backend.call(`/api/v1/messaging/model-usage?period=${period}&timezone_offset_minutes=${offset}${since === undefined ? '' : `&since_ms=${since}`}&until_ms=${until}`).then(snapshot => {
          if (requestedEnd !== null && snapshot.until_ms !== until) throw Object.assign(new Error('Usage range unsupported'), { code: 'usage-range-unsupported' })
          return { ...snapshot, until_ms: until }
        })
        cache.set(key, entry)
        entry.promise.catch(() => { if (cache.get(key) === entry) cache.delete(key) })
      }
      return send(200, await entry.promise)
    } catch (error) {
      if (error.code === 'usage-range-unsupported') return send(503, { error: '当前主机的 Kode 服务尚不支持结束时间，请更新并重启该服务。' })
      return send(error.status === 404 ? 503 : 502, { error: error.status === 404 ? '当前主机需要更新 Kode 服务以提供 token 统计。' : '读取 token 统计失败，请稍后重试。' })
    }
  } })
}
