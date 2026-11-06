import React from 'react'
import { builderAccountKey, selectedBuilderResource, confirmBuilderAccount, requestBuilderAccount } from './builder-account.js'
const h = React.createElement
export function BuilderAccountForm({ draft, storage, request }) {
  const [account, setAccount] = React.useState(''), [epoch, setEpoch] = React.useState('1'), [create, setCreate] = React.useState(true)
  const [review, setReview] = React.useState(null), [pending, setPending] = React.useState(null), [ready, setReady] = React.useState(false)
  const [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void storage.read(builderAccountKey(draft)).then(value => {
      if (controller.signal.aborted) return
      if (value && (value.home_hub !== draft.home_hub || value.command?.draft_id !== draft.id)) throw Error('Wrong account record')
      setPending(value?.state === 'accepted' ? null : value); setReady(true)
    }).catch(() => { if (!controller.signal.aborted) setMessage('无法读取账户确认记录，请重新打开草案。') })
    return () => controller.abort()
  }, [draft.id, draft.home_hub])
  const prepare = async event => {
    event.preventDefault(); if (running.current || pending) return
    running.current = true; setBusy(true); setMessage(''); setReview(null)
    try {
      if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(account) || (!create && (!/^\d+$/.test(epoch) || !Number.isSafeInteger(Number(epoch)) || Number(epoch) < 1))) throw Error('Invalid account')
      const { selection, resource } = await selectedBuilderResource(draft, request, active.current.signal)
      if (resource.quota_status === 'authority_unavailable' || (!resource.account && resource.quota_status !== 'account_unbound')) throw Error('Binding unavailable')
      const revision = resource.account?.binding_revision ?? 0
      if (!Number.isSafeInteger(revision) || revision < 0) throw Error('Invalid binding revision')
      const command = { draft_id: draft.id, request_id: crypto.randomUUID(), draft_revision: draft.revision, selection_revision: selection.revision, account_id: account, account_epoch: create ? 1 : Number(epoch), create_account: create, expected_binding_revision: revision }
      if (!active.current.signal.aborted) setReview({ command, selection, previous: resource.account?.id ?? null })
    } catch { if (!active.current.signal.aborted) setMessage('无法核对账户绑定，请检查账户标识、已保存的资源选择和服务状态。') }
    finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  const confirm = async () => {
    const intent = pending ?? review
    if (running.current || !intent) return
    running.current = true; setBusy(true); setMessage('')
    try {
      await confirmBuilderAccount({ storage, draft, command: intent.command, selection: intent.selection, request: requestBuilderAccount, signal: active.current.signal })
      if (!active.current.signal.aborted) { setPending(null); setReview(null); setMessage('账户绑定已确认。供应商额度仍需独立采集，可刷新执行资源查看。') }
    } catch {
      if (!active.current.signal.aborted) { setMessage('绑定结果尚未确认，请恢复原请求。'); try { const row = await storage.read(builderAccountKey(draft)); if (row?.state !== 'accepted') setPending(row) } catch {} }
    } finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  return h('section', { className: 'kode-collab-account-form' }, h('h3', null, '创建助手账户归属'),
    h('p', null, '账户标识用于归集同一账户的用量，请勿填写密钥。此设置不代表已连接供应商或已有余额。'),
    pending ? h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void confirm() }, '恢复原账户确认') :
    review ? h('div', null, h('p', null, '执行资源：', review.selection.selection.profile_id, '；账户：', review.command.account_id, review.command.create_account ? '（新建归属记录）' : '（使用已有归属记录）'),
      h('p', null, review.previous ? `将替换账户 ${review.previous} 的绑定。` : '此执行资源尚未绑定账户。', '绑定对使用该执行资源的其他团队也生效，后续执行会重新检查。'),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void confirm() }, '确认账户绑定'),
      h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => setReview(null) }, '返回修改账户')) :
    h('form', { onSubmit: event => void prepare(event) },
      h('label', null, '账户标识', h('input', { 'aria-label': '账户归属标识', value: account, maxLength: 160, disabled: busy, onChange: event => setAccount(event.target.value) })),
      h('label', null, h('input', { type: 'checkbox', checked: create, disabled: busy, onChange: event => setCreate(event.target.checked) }), '登记新账户归属'),
      !create && h('label', null, '已有账户版本', h('input', { 'aria-label': '已有账户版本', inputMode: 'numeric', value: epoch, disabled: busy, onChange: event => setEpoch(event.target.value) })),
      h('button', { type: 'submit', className: 'kode-collab-button', disabled: !ready || busy || !account }, '核对账户绑定')),
    message && h('p', { role: 'status' }, message))
}
