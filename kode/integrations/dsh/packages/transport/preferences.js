/** Interface appearance belongs to the browser's entry Host, not its execution Host. */
export async function fetchWithLocalAppearance(input, init, { current, send }) {
  const path = new URL(input, 'http://localhost/').pathname
  let envelope
  if (init?.method === 'POST' && typeof init.body === 'string') { try { envelope = JSON.parse(init.body) } catch {} }
  const namespace = envelope?.payload?.args?.ns
  if (['/api/settings/mutate', '/api/settings/replace'].includes(path) && namespace === 'ui-theme') return send(input, init, 'local')
  if (current === 'local' || path !== '/api/settings/describe') return send(input, init, current)
  const [remote, local] = await Promise.all([send(input, init, current), send(input, init, 'local')])
  if (!remote.ok) return remote
  if (!local.ok) return local
  const [remoteBody, localBody] = await Promise.all([remote.clone().json(), local.json()])
  if (!remoteBody.result?.ok) return remote
  if (!localBody.result?.ok) return new Response(JSON.stringify(localBody), { status: local.status, headers: { 'content-type': 'application/json' } })
  const theme = localBody.result.value.namespaces.find(row => row.ns === 'ui-theme')
  if (!theme) throw new Error('入口主机未提供 ui-theme，无法读取界面外观。')
  const rows = remoteBody.result.value.namespaces
  remoteBody.result.value.namespaces = [...rows.filter(row => row.ns !== 'ui-theme'), theme]
  return new Response(JSON.stringify(remoteBody), { status: remote.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
