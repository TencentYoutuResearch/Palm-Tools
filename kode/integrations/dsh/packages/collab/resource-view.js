import React from 'react'
import { ModelDirectory } from './model-directory.js'
const h = React.createElement
const quotaLabels = { reported: '已有额度观测', exhausted: '额度耗尽', stale: '额度记录已过期', reset_passed: '重置时间已过，等待新观测', partial: '额度信息不完整', account_unbound: '尚未绑定账户', binding_unavailable: '账户绑定已变化', source_unsupported: '此资源尚不支持额度采集', source_not_connected: '尚未连接额度来源', not_connected: '尚未连接额度来源', authority_unavailable: '额度服务暂不可用' }
export function ResourceView({ home, request }) {
  const [page, setPage] = React.useState({ items: [], next: null, loaded: false }), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const active = React.useRef(null)
  const load = async more => {
    active.current?.abort(); const controller = new AbortController(); active.current = controller
    setBusy(true); setError('')
    const after = more ? page.next : ''
    try {
      const result = await request(`/api/kode/resource-coverage?limit=25&after=${encodeURIComponent(after || '')}`, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (result.host !== home || result.scope !== 'host_execution_resources' || !Array.isArray(result.items) || result.items.length > 25) throw Error('Wrong resource scope')
      let cursor = after || ''
      for (const row of result.items) { if (row.host !== home || typeof row.cursor !== 'string' || row.cursor <= cursor) throw Error('Invalid resource page'); cursor = row.cursor }
      if (result.next_cursor !== null && (!result.items.length || result.next_cursor !== cursor)) throw Error('Invalid resource continuation')
      setPage(previous => ({ items: more ? [...previous.items, ...result.items] : result.items, next: result.next_cursor, loaded: true }))
    } catch { if (!controller.signal.aborted) setError('暂时无法读取执行资源。已有信息仍保留，请重试。') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  React.useEffect(() => { void load(false); return () => active.current?.abort() }, [home])
  return h('section', { className: 'kode-collab-resources', 'aria-label': '执行资源与额度' },
    h('h3', null, '执行资源与额度'), h('p', { className: 'kode-collab-note' }, '这里显示此 Hub 上已登记的资源。登记不代表已具备团队执行权限，远端资源需另行核对。'),
    h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void load(false) }, busy ? '正在读取…' : '刷新执行资源'),
    error && h('p', { role: 'status' }, error),
    page.loaded && !page.items.length && h('p', null, '此 Hub 尚未登记执行资源。'),
    ...page.items.map(row => h('article', { key: row.cursor, className: 'kode-collab-run' },
      h('h4', null, row.name || row.profile_id || row.provider_id),
      row.resource_kind === 'official_loop_provider' && row.route_registered && h(ModelDirectory, { home, provider: row.provider_id, request }),
      h('p', null, row.runtime_available ? '执行器已登记' : '执行器暂不可用', ' · ', row.grant_capability?.status === 'conditional' ? '需受控工具和授权检查' : '当前不支持团队权限约束'),
      h('p', null, '供应商额度：', quotaLabels[row.quota_status] || '状态未识别，不能推断可用额度'),
      ...(row.limits ?? []).flatMap(bucket => bucket.windows.map(window => h('p', { key: `${bucket.limit_id}:${window.window_id}` }, bucket.limit_id, ' / ', window.window_id, '：已用 ', window.used_percent, '%', window.freshness === 'reported' ? '' : '（非最新观测）'))),
      h('p', null, '供应商金额余额：', row.provider_monetary?.status === 'observed' ? '已有独立金额记录，需按账户、单位和有效期核对' : '尚无可确认的金额记录'),
      h('p', null, '团队预算：需按具体团队读取，此资源目录不提供团队预算。'))),
    page.next && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void load(true) }, '更多执行资源'))
}
