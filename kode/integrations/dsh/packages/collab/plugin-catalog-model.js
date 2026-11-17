/** Read-only federation: every failed authority remains explicitly unavailable. */
import {projectPluginCatalog} from '../../src/plugin-catalog.js'
export async function readPluginCatalog({inventory, request, signal}) {
  const readers = {
    inventory,
    agentHub: () => request('/api/kode/agent-hub', signal),
    externalStatus: () => request('/api/kode/external-resources?op=status', signal),
  }
  const values = {}, unavailable = []
  await Promise.all(Object.entries(readers).map(async ([key, read]) => {
    try {
      const value = await read()
      if (value == null) throw Error('Missing authority')
      projectPluginCatalog({[key]: value}) // reject malformed authorities independently
      values[key] = value
    } catch { unavailable.push(key) }
  }))
  return {catalog: projectPluginCatalog(values), unavailable}
}
export async function requestPluginCatalogJson(path, signal) {
  const response = await fetch(path, {method: 'GET', credentials: 'same-origin', cache: 'no-store', signal})
  if (!response.ok) throw Error('Authority unavailable')
  return response.json()
}
export const runtimeLabel = phase => ({active:'运行中', failed:'运行失败', pending:'等待加载', loading:'正在加载', unloading:'正在卸载'}[phase] ?? '运行状态未知')
export const evidenceLabel = basis => ({skills_links_only:'仅技能链接', launch_argument_configured:'已配置启动参数', installer_pending:'等待原生安装', installer_completed:'已记录原生安装完成'}[basis] ?? '未提供安装证据')
