/** Use the same CLI collector on every device, through its existing SSH connection. */
const totalFields = ['input_tokens', 'output_tokens', 'cached_tokens', 'total_tokens', 'cost_usd']

async function bridgeUsage(hosts, endpoint, query) {
  const tunnel = await hosts.openTunnel({
    host: endpoint.ssh_host,
    port: endpoint.ssh_port || 22,
    remote_port: endpoint.ssh_remote_port || 9870,
    use_config_port: true,
  })
  try {
    const response = await fetch(`${tunnel.url}/api/v1/model-usage?${query}`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
    })
    if (!response.ok) throw new Error('Remote bridge usage unavailable')
    return await response.json()
  } finally {
    await tunnel.close()
  }
}

async function remoteUsage(backend, hosts, query, requireEnd) {
  const warnings = [], devices = new Map()
  if (!hosts) return { warnings, snapshots: [] }
  const [catalog, saved] = await Promise.allSettled([
    backend.call('/api/v1/messaging/workbench/catalog?view=endpoints'), hosts.usageHosts(),
  ])
  const add = (host, port, config, id, name, read) => {
    const key = JSON.stringify([host, port || 22, config ?? ''])
    if (!devices.has(key)) devices.set(key, { id, name, readers: [] })
    devices.get(key).readers.push(read)
  }
  if (catalog.status === 'fulfilled') {
    for (const endpoint of catalog.value.endpoints ?? []) {
      if (!endpoint.ssh_host || !endpoint.id || !endpoint.token) continue
      add(endpoint.ssh_host, endpoint.ssh_port, null, `endpoint:${endpoint.id}`, endpoint.display_name || endpoint.id,
        () => bridgeUsage(hosts, endpoint, query))
    }
  } else warnings.push('暂时无法读取 Kode 的 SSH 设备列表。')
  if (saved.status === 'fulfilled') {
    const hostQuery = new URLSearchParams(query)
    // A preset uses the same calendar start. Let older remote hosts choose
    // their own sampling instant, which avoids comparing machine clocks.
    if (!requireEnd) hostQuery.delete('until_ms')
    for (const host of saved.value) {
      add(host.host, host.port, host.config_file, `ssh:${host.id}`, host.name,
        async () => (await hosts.connect(host.id)).usage(hostQuery))
    }
  } else warnings.push('暂时无法读取 DSH 的 SSH 设备列表。')

  const snapshots = await Promise.all([...devices.values()].map(async ({ id, name, readers }) => {
    for (const read of readers) {
      try {
        const snapshot = await read()
        if (snapshot.period === query.get('period') && Array.isArray(snapshot.rows) && snapshot.totals
          && (!requireEnd || snapshot.until_ms === Number(query.get('until_ms')))) return { id, name, snapshot }
      } catch { /* Another connection to the same SSH device may still work. */ }
    }
    return { id, name, warning: `${name} 的 token 用量暂不可用。` }
  }))
  return { warnings, snapshots }
}

export async function collectDeviceUsage(backend, hosts, query, requireEnd, localUsage) {
  const [local, remote] = await Promise.all([localUsage, remoteUsage(backend, hosts, query, requireEnd)])
  const sources = [{ id: 'local', name: '此计算机', snapshot: local }, ...remote.snapshots]
  const result = {
    period: local.period, until_ms: local.until_ms, scanned_files: 0,
    devices: [], rows: [], totals: Object.fromEntries(totalFields.map(field => [field, 0])),
    warnings: remote.warnings,
  }
  const daily = new Map(), timeline = new Map()
  for (const { id, name, snapshot, warning } of sources) {
    if (warning) { result.warnings.push(warning); continue }
    result.devices.push({ id, name })
    result.scanned_files += snapshot.scanned_files ?? 0
    result.warnings.push(...(snapshot.warnings ?? []).map(message => `${name}：${message}`))
    const tag = row => ({ ...row, source: id })
    for (const row of snapshot.rows ?? []) result.rows.push(tag(row))
    for (const field of totalFields) result.totals[field] += snapshot.totals?.[field] ?? 0
    for (const day of snapshot.daily ?? []) daily.set(day.date, (daily.get(day.date) ?? 0) + day.total_tokens)
    for (const bucket of snapshot.timeline ?? []) {
      if (!timeline.has(bucket.date)) timeline.set(bucket.date, [])
      timeline.get(bucket.date).push(...bucket.rows.map(tag))
    }
  }
  result.totals.cost_usd = Number(result.totals.cost_usd.toFixed(6))
  result.daily = [...daily.keys()].sort().map(date => ({ date, total_tokens: daily.get(date) }))
  result.timeline = [...timeline.keys()].sort().map(date => ({ date, rows: timeline.get(date) }))
  return result
}
