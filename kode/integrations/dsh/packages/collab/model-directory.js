import React from 'react'
const h = React.createElement
export function ModelDirectory({ home, provider, request }) {
  const [items, setItems] = React.useState(null), [detail, setDetail] = React.useState(null)
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const active = React.useRef(null)
  React.useEffect(() => () => active.current?.abort(), [home, provider])
  const load = async model => {
    active.current?.abort(); const controller = new AbortController(); active.current = controller
    setBusy(true); setError(''); setDetail(null)
    try {
      const result = await request(`/api/kode/builder/models?provider=${encodeURIComponent(provider)}${model ? `&model=${encodeURIComponent(model)}` : ''}`, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (result.home_hub !== home || result.provider !== provider || result.eligible_for_dispatch !== false) throw Error('Wrong model scope')
      if (model) {
        if (result.item?.provider !== provider || result.item.id !== model) throw Error('Wrong model')
        setDetail(result.item)
      } else {
        if (!Array.isArray(result.items) || result.items.length > 2000 || result.items.some(row => row.provider !== provider || typeof row.id !== 'string' || typeof row.name !== 'string')) throw Error('Invalid catalog')
        setItems(result.items)
      }
    } catch { if (!controller.signal.aborted) setError('暂时无法读取模型信息，请重试。') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return h('div', null,
    h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void load(null) }, busy ? '正在读取模型…' : '查看可用模型'),
    error && h('p', { role: 'status' }, error),
    items && h('label', null, '模型信息 ', h('select', { value: detail?.id || '', disabled: busy, onChange: event => { if (event.target.value) void load(event.target.value) } },
      h('option', { value: '' }, items.length ? '选择模型查看推理强度' : '提供商未列出模型'),
      ...items.map(row => h('option', { key: row.id, value: row.id }, row.name)))),
    detail && h('p', null, detail.reasoning ? `推理强度：${detail.reasoning.efforts.map(row => row.name).join('、') || '无可选项'}；默认：${detail.reasoning.default_effort ?? '由提供商决定'}` : '提供商未声明可选推理强度。'),
    items && h('p', { className: 'kode-collab-note' }, '模型目录不代表已通过额度和权限检查。此处查看信息，不会启动助手。'))
}
