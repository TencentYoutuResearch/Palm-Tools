import React from 'react'
import { createDraftKey, createBuilderDraft, requestCreateDraft } from './builder-create.js'
const h = React.createElement
export function BuilderCreateForm({ home, storage, onCreated }) {
  const [purpose, setPurpose] = React.useState(''), [pending, setPending] = React.useState(null)
  const [ready, setReady] = React.useState(false), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const active = React.useRef(null), running = React.useRef(false)
  React.useEffect(() => {
    const controller = new AbortController(); active.current = controller
    void storage.read(createDraftKey(home)).then(row => { if (!controller.signal.aborted) { setPending(row?.state !== 'accepted' ? row : null); setReady(true) } }).catch(() => { if (!controller.signal.aborted) setError('无法读取创建记录，请检查浏览器存储权限。') })
    return () => controller.abort()
  }, [home])
  const submit = async event => {
    event.preventDefault(); if (!ready || running.current) return
    running.current = true; setBusy(true); setError('')
    try {
      const draft = await createBuilderDraft({ storage, home, purpose, request: requestCreateDraft, signal: active.current.signal })
      if (!active.current.signal.aborted) onCreated(draft)
    } catch {
      if (!active.current.signal.aborted) {
        setError('创建结果尚未确认，重试会恢复原草案。')
        try { setPending(await storage.read(createDraftKey(home))) } catch {}
      }
    } finally { running.current = false; if (!active.current.signal.aborted) setBusy(false) }
  }
  return h('form', { className: 'kode-collab-composer kode-collab-builder-create', onSubmit: submit },
    h('h2', null, '新建团队草案'),
    pending ? h('p', null, pending.command.purpose) : h('label', { className: 'kode-collab-input-label' }, '这个团队主要帮你做什么？', h('textarea', { value: purpose, maxLength: 8192, onChange: event => setPurpose(event.target.value) })),
    h('p', { className: 'kode-collab-note' }, '先保存目标并确认需求，随后配置工作区、资源和预算。'),
    h('button', { type: 'submit', className: 'kode-collab-button', disabled: !ready || busy || (!pending && !purpose.trim()) }, busy ? '正在保存…' : pending ? '恢复原草案' : '保存目标并继续'),
    error && h('p', { role: 'status' }, error))
}
