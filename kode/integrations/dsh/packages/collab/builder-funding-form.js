import React from 'react'
import { fundingKey, confirmFunding, requestBuilderFunding } from './builder-funding.js'
const h = React.createElement
const numeric = { limit: '创建预算总额', input_per_million: '每百万输入 token 内部计价', cached_per_million: '每百万缓存输入 token 内部计价', output_per_million: '每百万输出 token 内部计价' }
export function BuilderFundingForm({ draft, storage, request }) {
  const [values, setValues] = React.useState({ unit: '', limit: '', input_per_million: '', cached_per_million: '', output_per_million: '', ends_at: '' })
  const [ready, setReady] = React.useState(false), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const [review, setReview] = React.useState(null), [pending, setPending] = React.useState(null), [record, setRecord] = React.useState(null)
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void Promise.all([request(`/api/kode/builder/funding?draft_id=${encodeURIComponent(draft.id)}`, { signal: controller.signal }), storage.read(fundingKey(draft))]).then(([value, local]) => {
      if (controller.signal.aborted) return
      if (value.home_hub !== draft.home_hub || value.draft_id !== draft.id || value.activation_performed !== false) throw Error('Wrong funding record')
      setRecord(value.record); setPending(local?.state !== 'accepted' ? local : null); setReady(true)
    }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取创建预算，请重新打开草案后重试。') })
    return () => controller.abort()
  }, [draft.id, draft.home_hub])
  const prepare = async event => {
    event.preventDefault(); if (running.current || !ready) return
    running.current = true; setBusy(true); setMessage('')
    try {
      const starts_at = Date.now(), ends_at = new Date(values.ends_at).getTime(), command = { draft_revision: draft.revision, unit: values.unit, starts_at, ends_at }
      if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(values.unit) || !Number.isSafeInteger(ends_at) || ends_at <= starts_at) throw Error('Invalid period')
      for (const key of Object.keys(numeric)) {
        if (!/^\d+$/.test(values[key])) throw Error('Invalid amount')
        command[key] = Number(values[key]); if (!Number.isSafeInteger(command[key]) || command[key] > 4000000000000000) throw Error('Invalid amount')
      }
      if (command.limit === 0) throw Error('Empty budget')
      const value = await request(`/api/kode/builder/selection?draft_id=${encodeURIComponent(draft.id)}`, { signal: active.current.signal })
      if (value.home_hub !== draft.home_hub || value.draft_id !== draft.id || value.draft_status !== 'draft' || value.draft_revision !== draft.revision || value.record?.draft_revision !== draft.revision) throw Error('Save current selection first')
      command.selection_revision = value.record.revision
      if (!active.current.signal.aborted) setReview({ command, selection: value.record })
    } catch { if (!active.current.signal.aborted) setMessage('请检查整数金额、有效期，并先保存当前草案的助手资源。') }
    finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const confirm = async () => {
    if (running.current || (!review && !pending)) return
    running.current = true; setBusy(true); setMessage('')
    try {
      const source = pending ?? review
      const result = await confirmFunding({ storage, draft, command: source.command, selection: source.selection, request: requestBuilderFunding, signal: active.current.signal })
      if (!active.current.signal.aborted) { setRecord(result); setPending(null); setReview(null); setMessage('创建预算与草案权限已配置，尚未启动助手。') }
    } catch {
      if (!active.current.signal.aborted) { setMessage('确认结果尚未确定，请重试原确认。'); try { setPending(await storage.read(fundingKey(draft))) } catch {} }
    } finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const current = pending ?? review
  return h('section', { className: 'kode-collab-funding-form' }, h('h3', null, '团队预算 · 创建助手'),
    h('p', null, '这份预算用于搭建团队。内部计价由你填写，不代表供应商价格或余额。保存预算不会启动助手。'),
    record && h('p', null, '初始确认记录：', record.budget.limit, ' ', record.budget.unit, '；有效至 ', new Date(record.budget.ends_at).toLocaleString(), '。此处不是实时可用余额。'),
    !record && !current && h('form', { className: 'kode-collab-composer', onSubmit: prepare },
      h('label', null, '预算单位', h('input', { 'aria-label': '预算单位', value: values.unit, required: true, disabled: !ready || busy, onChange: event => setValues(previous => ({ ...previous, unit: event.target.value })) })),
      ...Object.entries(numeric).map(([key, label]) => h('label', { key }, label, h('input', { 'aria-label': label, inputMode: 'numeric', required: true, value: values[key], disabled: !ready || busy, onChange: event => setValues(previous => ({ ...previous, [key]: event.target.value })) }))),
      h('label', null, '预算到期时间', h('input', { 'aria-label': '预算到期时间', type: 'datetime-local', required: true, value: values.ends_at, disabled: !ready || busy, onChange: event => setValues(previous => ({ ...previous, ends_at: event.target.value })) })),
      h('button', { type: 'submit', className: 'kode-collab-button', disabled: !ready || busy }, '核对预算与权限')),
    current && h('div', null,
      h('p', null, '团队预算：', current.command.limit, ' ', current.command.unit, '；有效期：', new Date(current.command.starts_at).toLocaleString(), ' — ', new Date(current.command.ends_at).toLocaleString()),
      h('p', null, '模型：', current.selection.selection.provider, ' / ', current.selection.selection.model),
      ...Object.entries(numeric).filter(([key]) => key !== 'limit').map(([key, label]) => h('p', { key }, label, '：', current.command[key], ' ', current.command.unit)),
      h('p', null, '授权：读取 ', current.selection.selection.workspace.root_ref, ' 并通过受控工具编写团队草案；不包含工作区写入、提交、发布或工具网络访问。'),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void confirm() }, pending ? '重试原预算确认' : '确认创建预算与草案权限'),
      !pending && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setReview(null) }, '返回修改预算')),
    message && h('p', { role: 'status' }, message))
}
