const endpoint = '/api/kode/session-interop'
export async function requestSessionInterop(settings, { signal, fetcher = globalThis.fetch } = {}) {
  const response = await fetcher(endpoint, { method: settings === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', signal,
    ...(settings === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'configure', settings }) }) })
  if (!response.ok) throw Object.assign(Error(`本机会话互通设置请求失败 (${response.status})`), {status:response.status})
  return response.json()
}
export function validateInteropSettings(settings, profiles) {
  if (!settings || !Array.isArray(settings.grants)) throw Error('授权列表无效')
  const summary = settings.summary
  if (summary !== null) {
    const profile = profiles.find(item => item.id === summary?.profile_id)
    if (!profile || !profile.models.includes(summary.model)) throw Error('请选择当前可用的摘要配置与模型')
    if (summary.reasoningEffort && !profile.reasoningEfforts.includes(summary.reasoningEffort)) throw Error('请选择可用的推理强度')
  }
  const seen = new Set()
  const grants = settings.grants.map(row => {
    if (![row.source, row.target].every(id => typeof id === 'string' && id.trim() === id && id.length > 0 && !id.includes('*'))) throw Error('来源和目标必须是精确会话 ID，不能使用通配符')
    if (!Array.isArray(row.actions) || !row.actions.length || row.actions.some(action => !['summary', 'model', 'direct_insert'].includes(action))) throw Error('每条授权至少选择一种允许的操作')
    const key = JSON.stringify([row.source, row.target])
    if (seen.has(key)) throw Error('同一来源与目标请合并为一条授权')
    seen.add(key)
    return { source: row.source, target: row.target, actions: [...new Set(row.actions)] }
  })
  return { summary: summary === null ? null : { profile_id: summary.profile_id, model: summary.model, ...(summary.reasoningEffort ? { reasoningEffort: summary.reasoningEffort } : {}) }, grants }
}
export function parseInteropSnapshot(value) {
  if (value?.scope !== 'local_host' || !Array.isArray(value.profiles) || !Array.isArray(value.grants) || !Object.hasOwn(value, 'summary')) throw Error('无法确认本机设置，请重新加载')
  const profiles = value.profiles.map(row => {
    if (typeof row.id !== 'string' || !Array.isArray(row.models) || !Array.isArray(row.reasoningEfforts) || [...row.models,...row.reasoningEfforts].some(item => typeof item !== 'string')) throw Error('模型目录无效')
    return { id: row.id, name: row.name || row.id, models: [...row.models], reasoningEfforts: [...row.reasoningEfforts] }
  })
  // Retain an unavailable saved configuration for correction rather than silently deleting it.
  if (value.summary !== null && (!value.summary || typeof value.summary.profile_id !== 'string' || typeof value.summary.model !== 'string')) throw Error('摘要设置无效')
  const settings = { summary: value.summary === null ? null : {...value.summary}, grants: value.grants.map(row=>({...row,actions:Array.isArray(row.actions)?[...row.actions]:[]})) }
  return { profiles, settings }
}
