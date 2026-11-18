import React from 'react'
import { IconButton } from './icons.js'
import { requestCollabMessage } from './outbox.js'
import { conversationTarget, conversationTargetKey, validateConversationQuestions } from './conversation-target.js'
const h = React.createElement
/** Read only Hub question records; choosing a row never sends or grants anything. */
export function ConversationQuestions({ team, target, disabled, onSelect, compact = false, request = requestCollabMessage }) {
  const [state, setState] = React.useState({ items: [], loading: true, error: '', loaded: false })
  const [refresh, setRefresh] = React.useState(0)
  React.useEffect(() => {
    const controller = new AbortController()
    setState({ items: [], loading: true, error: '', loaded: false })
    request(`/api/kode/conversation/messages?conversation_id=${encodeURIComponent(team.conversation_id)}&view=clarifications`, { signal: controller.signal })
      .then(result => { const items = validateConversationQuestions(team, result); if (!controller.signal.aborted) setState({ items, loading: false, error: '', loaded: true }) })
      .catch(() => { if (!controller.signal.aborted) setState({ items: [], loading: false, error: '暂时无法读取待回答的问题，请刷新重试。普通消息仍可发送。', loaded: false }) })
    return () => controller.abort()
  }, [team.home_hub, team.id, team.conversation_id, refresh, request])
  const selected = conversationTargetKey(target)
  const missing = target && state.loaded && !state.items.some(row => conversationTargetKey(row) === selected)
  if (!state.items.length && !target) return null
  return h('section', { className: 'kode-collab-conversation-questions', 'aria-label': '选择要回答的问题' },
    h('style', null, `.kode-collab-conversation-questions{min-width:0;max-height:30dvh;overflow:auto;overflow-wrap:anywhere}.kode-collab-conversation-questions .kode-collab-toolbar{flex-wrap:wrap}.kode-collab-conversation-questions .kode-trigger{min-width:0;max-width:100%;overflow:hidden}.kode-collab-conversation-questions .kode-trigger span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kode-collab-conversation-questions ul{margin:6px 0 12px;padding-inline-start:16px}.kode-collab-conversation-questions :is(strong,p,li){min-width:0;overflow-wrap:anywhere}.kode-collab-question-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}.kode-collab-question-heading .kode-collab-button{flex:0 1 auto;min-width:0;max-width:100%;white-space:normal;overflow-wrap:anywhere}`),
    h('div', { className: 'kode-collab-toolbar' }, h('strong', null, '当前私信待回答的问题'),
      h(IconButton, { icon: 'refresh', size: 'sm', label: state.loading ? '正在读取问题…' : '刷新问题', disabled: state.loading, onClick: () => setRefresh(value => value + 1) })),
    state.error && h('p', { role: 'status', className: 'kode-collab-note' }, state.error),
    ...state.items.map(row => h('div', { key: conversationTargetKey(row), className: 'kode-collab-note' },
      h('div', { className: 'kode-collab-question-heading' }, h('strong', null, row.run_title),
        h('button', { type: 'button', className: 'kode-collab-button', 'aria-label': `回答 ${row.run_title}`, disabled, onClick: () => onSelect(conversationTarget(row)) }, '回答这个问题')),
      h('p', null, `任务 ${row.run_id} · 问题 ${row.question_request_id}`),
      h('ul', null, ...row.questions.map((question, index) => h('li', { key: index }, question.question, question.options?.length ? h('ul', null, ...question.options.map((option, choice) => h('li', { key: choice }, option.label, option.description ? `：${option.description}` : ''))) : null))))),
    target && h('div', { role: 'status', className: 'kode-collab-note' },
      h('p', null, `这条回答仅用于任务 ${target.run_id} 的问题 ${target.question_request_id}。回答中的操作指令不会授予新权限。`),
      h('button', { type: 'button', className: 'kode-collab-button', disabled, onClick: () => onSelect(null) }, '取消关联')),
    missing && h('p', { role: 'alert', className: 'kode-collab-note' }, '所选问题已不在待回答列表中。草稿仍保留，发送时将由 Hub 核验；可改选其他问题或取消关联。'))
}
