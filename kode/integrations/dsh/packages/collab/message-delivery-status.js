import React from 'react'
import { Icon, IconButton } from './icons.js'
const h = React.createElement

/**
 * One compact line above the composer for the single unresolved outbox record: a one-line
 * preview, what the user needs to know, and a small retry icon. The draft itself stays in the
 * composer, so the full message is not repeated here. Retry is the outbox's own recovery
 * (look up the original request first, resend the same request only when it is absent), so the
 * button never creates a new request, target or content; this view only names it plainly.
 */
export function MessageDeliveryStatus({ record, busy, onRetry }) {
  if (!record || record.state === 'accepted') return null
  const working = busy || !!record.busy, rejected = record.state === 'rejected'
  const kind = record.clarification_target ? '回答问题' : record.prior_run_id ? '修改请求' : null
  const status = working ? '正在核对是否已送达…'
    : rejected ? '未送达：团队没有接收这条消息。可以修改后重新发送。'
      : '未确认是否送达。重试会先核对，已送达的不会重复发送。'
  return h('div', { className: 'kode-message-delivery', role: 'status', 'aria-live': 'polite', 'aria-busy': working || undefined, 'data-state': working ? 'checking' : rejected ? 'rejected' : 'unconfirmed' },
    h('span', { className: 'kode-message-delivery-icon', 'aria-hidden': true }, h(Icon, { name: working ? 'activity' : 'alert', size: 16 })),
    h('span', { className: 'kode-message-delivery-text' },
      h('span', { className: 'kode-message-delivery-preview', title: record.content }, kind && h('span', { className: 'kode-message-delivery-kind', title: record.prior_run_id ? `关联任务 ${record.prior_run_id}` : undefined }, kind), record.content),
      h('span', { className: 'kode-message-delivery-note', title: rejected && record.error ? record.error : undefined }, status)),
    h(IconButton, { icon: 'refresh', label: working ? '正在核对' : '重试发送', className: 'kode-message-delivery-retry', disabled: working, onClick: onRetry }))
}

export const messageDeliveryStyles = `
.kode-message-delivery{display:flex;align-items:center;gap:8px;min-height:36px;padding:4px 4px 4px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.kode-message-delivery-icon{display:inline-flex;flex:none;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}
.kode-message-delivery[data-state=checking] .kode-message-delivery-icon{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
@media (prefers-reduced-motion:no-preference){.kode-message-delivery[data-state=checking] .kode-message-delivery-icon svg{animation:kode-delivery-spin 1s linear infinite}}
@keyframes kode-delivery-spin{to{transform:rotate(360deg)}}
.kode-message-delivery-text{display:flex;flex-direction:column;min-width:0;flex:1}
.kode-message-delivery-preview{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);font-size:13px}
.kode-message-delivery-kind{margin-inline-end:6px;color:var(--dsw-alias-label-secondary)}
.kode-message-delivery-retry{flex:none}
`
