import React from 'react'
import { requestCollabRead } from './data.js'
const h = React.createElement
export function BuilderPatchRecovery({ draft, pending, kind, storage, storageKey, onResolved }) {
  const [state, setState] = React.useState(''), [busy, setBusy] = React.useState(false)
  const active = React.useRef(null)
  React.useEffect(() => { const controller = new AbortController(); active.current = controller; return () => controller.abort() }, [pending.request_id])
  const check = async () => {
    setBusy(true); setState('')
    try {
      const query = new URLSearchParams({ draft_id: draft.id, request_id: pending.request_id, kind, expected_revision: String(pending.command.expected_revision) })
      const result = await requestCollabRead(`/api/kode/builder/patch-status?${query}`, { signal: active.current.signal })
      if (result.home_hub !== draft.home_hub || result.draft_id !== draft.id || result.kind !== kind || result.request_id !== pending.request_id || result.expected_revision !== pending.command.expected_revision) throw Error('Wrong status')
      if (!active.current.signal.aborted) setState(result.state === 'rejected_revision' && result.record === null ? 'rejected' : result.state === 'recorded' ? 'recorded' : 'unconfirmed')
    } catch { if (!active.current.signal.aborted) setState('unconfirmed') }
    finally { if (!active.current.signal.aborted) setBusy(false) }
  }
  const resolve = async () => {
    if (state !== 'rejected' || busy) return
    setBusy(true)
    try {
      await storage.save(storageKey, { ...pending, state: 'accepted', disposition: 'rejected_revision' })
      if (!active.current.signal.aborted) onResolved()
    } catch { if (!active.current.signal.aborted) setState('unconfirmed') }
    finally { if (!active.current.signal.aborted) setBusy(false) }
  }
  return h('div', null,
    h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void check() }, '检查提交结果'),
    state === 'recorded' && h('p', { role: 'status' }, 'Hub 已保存原提交，请重试原请求以恢复回执。'),
    state === 'unconfirmed' && h('p', { role: 'status' }, '结果仍未确定，原提交记录已保留。'),
    state === 'rejected' && h(React.Fragment, null, h('p', { role: 'status' }, '草案版本已变化，原提交未写入且不能再写入。请核对最新草案后重新提交。'),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void resolve() }, '保留输入并重新编辑')))
}
