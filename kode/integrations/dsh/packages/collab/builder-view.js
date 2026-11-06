import { VerificationReviewForm } from './verification-review-form.js'
import { BuilderWorkflowView } from './builder-workflow-view.js'
import { BuilderAccountForm } from './builder-account-form.js'
import { BuilderProposalView } from './builder-proposal-view.js'
import { BuilderStartForm } from './builder-start-form.js'
import { BuilderFundingForm } from './builder-funding-form.js'
import { BuilderSelectionForm } from './builder-selection-form.js'
import React from 'react'
import { ResourceView } from './resource-view.js'
import { BuilderWorkspaceForm } from './builder-workspace-form.js'
import { BuilderCreateForm } from './builder-create-form.js'
import { BuilderAnswerForm } from './builder-answer-form.js'
const h = React.createElement
export function BuilderView({ request, storage, onTeamSaved }) {
  const [list, setList] = React.useState({ items: [], next: null, home: null }), [draft, setDraft] = React.useState(null)
  const [showResources, setShowResources] = React.useState(false)
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const active = React.useRef(null)
  const updateDraft = React.useCallback(value => setDraft(previous => previous && previous.id === value.id && previous.home_hub === value.home_hub && value.revision > previous.revision ? value : previous), [])
  const read = async (id, more = false) => {
    active.current?.abort(); const controller = new AbortController(); active.current = controller
    setBusy(true); setError('')
    try {
      const value = await request(id ? `/api/kode/builder/drafts?draft_id=${encodeURIComponent(id)}` : `/api/kode/builder/drafts?after=${encodeURIComponent(more ? list.next : '')}&limit=25`, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (id) {
        if (value.id !== id || value.home_hub !== list.home || !value.interview || !Array.isArray(value.interview.questions)) throw Error('Invalid draft')
        setDraft(value)
      } else {
        if (!Array.isArray(value.items) || value.items.length > 25 || typeof value.home_hub !== 'string' || (list.home && value.home_hub !== list.home)) throw Error('Invalid directory')
        let cursor = more ? list.next : ''
        for (const row of value.items) { if (typeof row.id !== 'string' || row.id <= cursor || !Number.isSafeInteger(row.revision)) throw Error('Invalid draft identity'); cursor = row.id }
        if (value.next_cursor !== null && (!value.items.length || value.next_cursor !== cursor)) throw Error('Invalid draft cursor')
        setList(previous => ({ items: more ? [...previous.items, ...value.items] : value.items, next: value.next_cursor, home: value.home_hub }))
      }
    } catch { if (!controller.signal.aborted) setError('暂时无法读取团队草案，请重试。') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  React.useEffect(() => { void read(null); return () => active.current?.abort() }, [])
  return h('section', { className: 'kode-collab-builder kode-collab-messages', 'aria-label': '团队搭建助手' },
    h('h1', null, '团队搭建助手'), h('p', null, '查看已保存的团队目标和待确认问题，继续配置团队。'),
    h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void read(draft?.id ?? null) }, busy ? '正在读取…' : '刷新'),
    error && h('p', { role: 'status' }, error),
    draft ? h('article', null,
      h('button', { type: 'button', className: 'kode-collab-button', onClick: () => { setDraft(null); void read(null) } }, '返回草案列表'),
      h('h2', null, draft.interview.purpose), h('p', null, draft.status === 'revoked' ? '已撤销' : '配置草案'),
      h('h3', null, '待确认问题'), ...(draft.interview.questions.length ? draft.interview.questions.map(question => h('p', { key: question.id }, question.prompt)) : [h('p', { key: 'empty' }, '当前没有待回答的问题。')]),
      draft.status === 'draft' && h(BuilderAnswerForm, { key: draft.id, draft, storage, onRefresh: () => void read(draft.id), onSaved: setDraft }),
      draft.status === 'draft' && h(BuilderWorkspaceForm, { key: 'workspaces:' + draft.id, draft, storage, request, onRefresh: () => void read(draft.id), onSaved: setDraft }),
      draft.status === 'draft' && h(BuilderSelectionForm, { key: 'selection:' + draft.id, draft, storage, request }),
      draft.status === 'draft' && h(BuilderAccountForm, { key: 'account:' + draft.id, draft, storage, request }),
      draft.status === 'draft' && h(BuilderFundingForm, { key: 'funding:' + draft.id, draft, storage, request }),
      draft.status === 'draft' && h(BuilderStartForm, { key: 'start:' + draft.id, draft, storage, request, onDraftUpdated: updateDraft }),
      h('details', null, h('summary', null, '配置本机验证命令'), h(VerificationReviewForm, { host: draft.home_hub, storage })),
      h(BuilderWorkflowView, { key: 'workflow:' + draft.id + ':' + draft.revision, draft, storage }),
      h(BuilderProposalView, { key: 'proposal:' + draft.id, draft, storage, onTeamSaved }),
      h('h3', null, '已记录的回答'), ...Object.entries(draft.interview.answers ?? {}).map(([key, value]) => h('p', { key }, key, '：', value)),
      h('button', { type: 'button', className: 'kode-collab-button', 'aria-expanded': showResources, onClick: () => setShowResources(value => !value) }, showResources ? '收起执行资源' : '查看执行资源与额度'),
      showResources && h(ResourceView, { home: draft.home_hub, request }),
      h('p', { className: 'kode-collab-note' }, '团队执行以已确认的方案、激活记录和当前权限检查为准。')) : h('div', null,
      list.home && h(BuilderCreateForm, { home: list.home, storage, onCreated: setDraft }),
      ...list.items.map(row => h('button', { key: row.id, type: 'button', className: 'kode-collab-contact', disabled: busy, onClick: () => void read(row.id) }, row.purpose, row.status === 'revoked' ? ' · 已撤销' : ' · 草案')),
      !busy && !list.items.length && h('p', null, '还没有团队草案。描述目标，开始配置第一个团队。'),
      list.next && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy, onClick: () => void read(null, true) }, '更多草案')))
}
